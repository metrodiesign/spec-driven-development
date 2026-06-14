#!/usr/bin/env bash
# install.sh — PRINT the one-time setup the human must run. Mutates NOTHING.
#
# ทำไม script นี้ "พิมพ์" คำสั่งแทนที่จะ "รัน" ให้:
#   คำสั่ง `git config core.hooksPath ...` มี token `core.hooksPath` ซึ่งเป็นสิ่งที่
#   .ai/bin/check-bypass.sh (และ Claude hook-bypass-guard.sh) ตั้งใจ block — เพราะ
#   การ set core.hooksPath เป็นวิธีปิด/หลบ git hooks ทั้งชุด (รวม secret-guard).
#   ดังนั้น agent (Claude/Codex/OpenCode) ที่อยู่หลัง guard จะรันคำสั่งนี้เองไม่ได้ตามดีไซน์
#   -> ต้องให้ "คน" copy ไปรันในเชลล์ของตัวเอง (นอก guard) ครั้งเดียวต่อ clone.

set -euo pipefail

cat <<'EOF'
=== .ai/bin one-time setup (run these yourself, in a plain shell) ===

These mutate git config / file modes, so a guarded agent cannot run them.
Copy-paste and run from the repository root:

  git config core.hooksPath .githooks
  chmod +x .githooks/* .ai/bin/*

What they do:
  1. git config core.hooksPath .githooks
       Point this repo's git hooks at the committed, shared .githooks/ directory
       (pre-commit -> secret scan + Evidence check, pre-push -> branch/force-push guard).
       Persists in .git/config (per clone — re-run after every fresh clone).
  2. chmod +x .githooks/* .ai/bin/*
       Mark the hook scripts and the check engine executable.

Verify afterwards:
  git config --get core.hooksPath        # -> .githooks
  ls -l .githooks .ai/bin                 # -> scripts are executable (rwx)
EOF
