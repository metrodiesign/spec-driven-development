#!/usr/bin/env bash
# check-secrets.sh — harness-agnostic secret scanner (.ai/bin engine)
# Ported from ~/.claude/hooks/secret-guard.sh; detection patterns kept verbatim.
#
# Default: scan STAGED changes (git diff --cached) — for pre-commit hooks / agents.
#   --all : scan the whole tree (tracked files) — for CI.
#
# Blocks (exit 2) on:
#   1. Known key patterns (Omise, Stripe, AWS, GitHub, generic high-entropy assignment)
#   2. Forbidden config files (.env/.env.*/*.pem/*.key/... and appsettings.*.json without .example)
# Prints which file/pattern matched to stderr.
#
# Exit 0 = OK, exit 2 = block. (SECRET_GUARD_SKIP=1 overrides — for the human, off-session.)

set -euo pipefail

RED=$'\e[31m'
YEL=$'\e[33m'
RST=$'\e[0m'

MODE=staged
if [ "${1:-}" = "--all" ]; then
  MODE=all
fi

fail=0
reasons=()

# --- gather file list + content depending on mode ---
if [ "$MODE" = "all" ]; then
  # whole tree (tracked files only)
  FILES=$(git ls-files 2>/dev/null || true)
  if [ -z "$FILES" ]; then
    exit 0
  fi
  # content = '+'-prefixed lines emulated by prefixing every line (so the '^\+' generic
  # pattern below works identically in both modes)
  CONTENT=$(
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      [ -f "$f" ] || continue
      sed 's/^/+/' "$f" 2>/dev/null || true
    done <<< "$FILES"
  )
else
  # staged (Added/Modified/Renamed/Copied)
  FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
  if [ -z "$FILES" ]; then
    exit 0
  fi
  CONTENT=$(git diff --cached --unified=0 2>/dev/null || true)
fi

# 1. Forbidden filename patterns
while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    *appsettings.Development.json|*appsettings.Production.json|*appsettings.Local.json)
      if [ -z "$(echo "$f" | grep -i 'example\|template\|sample')" ]; then
        fail=1
        reasons+=("forbidden file: $f (should be .example only, real config in user-secrets)")
      fi
      ;;
    *.env|*.env.local|*.env.production|*.pem|*.key|*.pfx|*.p12|secrets.json|id_rsa|id_ed25519)
      if [ -z "$(echo "$f" | grep -i 'example\|template\|sample')" ]; then
        fail=1
        reasons+=("forbidden file: $f")
      fi
      ;;
  esac
done <<< "$FILES"

# 2. Content patterns

# Omise keys
if printf '%s' "$CONTENT" | grep -qE '(skey_|pkey_)(test|live)_[a-zA-Z0-9]{15,}'; then
  fail=1
  reasons+=("Omise key pattern (skey_/pkey_) detected in $MODE content")
fi

# Stripe keys
if printf '%s' "$CONTENT" | grep -qE 'sk_(test|live)_[a-zA-Z0-9]{24,}|pk_(test|live)_[a-zA-Z0-9]{24,}|rk_(test|live)_[a-zA-Z0-9]{24,}'; then
  fail=1
  reasons+=("Stripe key pattern detected in $MODE content")
fi

# AWS
if printf '%s' "$CONTENT" | grep -qE 'AKIA[0-9A-Z]{16}|aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}'; then
  fail=1
  reasons+=("AWS credential pattern detected")
fi

# GitHub tokens
if printf '%s' "$CONTENT" | grep -qE 'ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82}'; then
  fail=1
  reasons+=("GitHub token pattern detected")
fi

# Generic: key/secret/password assigned to long value (naive entropy check)
# Catches: "SecretKey": "long-real-value", MinIO.SecretKey=..., etc
# Skip if value is placeholder (contains XXXX, ****, your-, example, changeme, placeholder)
if printf '%s' "$CONTENT" | grep -E '^\+' | \
   grep -iE '(secret[_-]?key|api[_-]?key|password|token|private[_-]?key)\s*[:=]\s*["'"'"']?[A-Za-z0-9_+/=\-]{20,}' | \
   grep -ivE '(XXXX|\*\*\*\*|your-|example|placeholder|changeme|<.*>|REPLACE|TODO)' >/dev/null 2>&1; then
  fail=1
  reasons+=("possible hardcoded secret assignment in $MODE content (matches key/password/token with long value)")
fi

if [ "$fail" -ne 0 ]; then
  printf '%s\n' "${RED}✗ Secret Guard — BLOCKED${RST}" >&2
  echo >&2
  for r in "${reasons[@]}"; do
    printf '  %s %s\n' "${YEL}•${RST}" "$r" >&2
  done
  echo >&2
  cat >&2 <<EOF
${YEL}Remediation:${RST}
  1. Remove the secret from staged files
  2. Move real values to environment (.env.local / user-secrets / K8s Secret)
  3. Commit only placeholder .example files
  4. If secret already pushed: rotate it + scrub history (BFG / git-filter-repo)

Bypass (NOT recommended): SECRET_GUARD_SKIP=1 ...
EOF
  if [ "${SECRET_GUARD_SKIP:-0}" = "1" ]; then
    echo >&2
    printf '%s\n' "${YEL}⚠ SECRET_GUARD_SKIP=1 set — overriding block${RST}" >&2
    exit 0
  fi
  exit 2
fi

exit 0
