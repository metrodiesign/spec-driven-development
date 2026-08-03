#!/usr/bin/env bash
# Verify operator-supplied golden bytes without generating or rewriting a manifest.
# Usage: scripts/check-golden-manifests.sh [golden-root ...]
# A missing root/manifest is an explicit P0-08 blocker, not a green empty suite.
set -euo pipefail
export LC_ALL=C

if [ "$#" -gt 0 ]; then
  roots=("$@")
elif [ -n "${GOLDEN_ROOTS:-}" ]; then
  read -r -a roots <<< "$GOLDEN_ROOTS"
else
  roots=("test/golden")
fi

manifests=()
for root in "${roots[@]}"; do
  [ -e "$root" ] || continue
  if [ -f "$root/_MANIFEST.sha256" ]; then
    manifests+=("$root/_MANIFEST.sha256")
  else
    while IFS= read -r manifest; do
      [ -n "$manifest" ] && manifests+=("$manifest")
    done < <(find "$root" -type f -name _MANIFEST.sha256 -print | sort)
  fi
done

if [ "${#manifests[@]}" -eq 0 ]; then
  echo "BLOCKED: operator_golden_fixture_missing (no _MANIFEST.sha256 under configured golden roots)" >&2
  exit 2
fi

status=0
for manifest in "${manifests[@]}"; do
  dir="$(dirname "$manifest")"
  expected="$(mktemp)"
  if find "$dir" -type l -print -quit | grep -q .; then
    echo "FAIL: golden_manifest_mismatch: symlink entry under golden root: $dir" >&2
    status=1
    rm -f "$expected"
    continue
  fi
  while IFS= read -r file; do
    rel="${file#"$dir"/}"
    digest="$(shasum -a 256 "$file" | awk '{print $1}')"
    printf '%s  %s\n' "$digest" "$rel"
  done < <(find "$dir" -type f ! -name _MANIFEST.sha256 -print | sort) > "$expected"

  if [ ! -s "$expected" ]; then
    echo "FAIL: golden_manifest_mismatch: operator golden manifest contains no files: $manifest" >&2
    status=1
    rm -f "$expected"
    continue
  fi

  if ! cmp -s "$manifest" "$expected"; then
    echo "FAIL: golden_manifest_mismatch: $manifest" >&2
    diff -u "$manifest" "$expected" >&2 || true
    status=1
    rm -f "$expected"
    continue
  fi

  # A mutable actor can rewrite both a golden file and its manifest. When the
  # fixture is tracked, compare the manifest bytes to the checked-out commit as
  # an independent trust anchor; this is intentionally not a manifest generator.
  repo_root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
  tracked_manifest=0
  if [ -n "$repo_root" ]; then
    manifest_rel="${manifest#"$repo_root"/}"
    if git -C "$repo_root" ls-files --error-unmatch -- "$manifest_rel" >/dev/null 2>&1; then
      tracked_manifest=1
    fi
  fi
  if [ "$tracked_manifest" -eq 1 ] && ! git -C "$repo_root" diff --quiet HEAD -- "$manifest_rel"; then
    echo "FAIL: golden_manifest_mismatch: manifest bytes changed from the operator commit: $manifest" >&2
    status=1
    rm -f "$expected"
    continue
  fi
  manifest_hash="$(shasum -a 256 "$manifest" | awk '{print $1}')"
  source_hash="$({
    while IFS= read -r file; do
      rel="${file#"$dir"/}"
      printf '%s\0' "$rel"
      cat "$file"
      printf '\0'
    done < <(find "$dir" -type f ! -name _MANIFEST.sha256 -print | sort)
    printf '%s\0' _MANIFEST.sha256
    cat "$manifest"
  } | shasum -a 256 | awk '{print $1}')"
  echo "OK: $manifest (source=$dir sourceHash=$source_hash manifestHash=$manifest_hash)"
  rm -f "$expected"
done

exit "$status"
