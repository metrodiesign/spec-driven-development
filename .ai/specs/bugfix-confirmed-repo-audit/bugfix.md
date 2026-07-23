# Bugfix: Confirmed repository audit defects
> Status: approved 2026-07-23

## Scope

แก้เฉพาะ defect 8 กลุ่มที่ยืนยันใน Phase 1:

1. bypass guard ไม่ normalize รูปแบบ executable ของ `git`
2. destructive guard ตรวจ `WHERE` รวมหลาย `DELETE` span
3. consent diff preview สูญเสียลำดับและจำนวนบรรทัดซ้ำ
4. session, JWT และ pending OIDC token ยังใช้ได้ตรง boundary หมดอายุ
5. auth config ไม่บังคับ mode `0600` และยอมรับ required value ว่าง
6. ESLint สแกน local harness worktree ที่ Git ignore
7. CI ไม่มี production dependency audit และ security documentation ไม่ตรง repo
8. tracked source มี literal NUL ทำให้ secret scan เตือน

ห้ามเพิ่ม dependency ใหม่ ห้ามแก้ `pnpm-lock.yaml` และห้ามแก้ reported-only candidates:

- `scripts/spec-slice.sh`
- `adapters/src/codex-live.ts`
- `scripts/spec-archive.sh`
- retention behavior ใน `console/backend/src/app.ts`

## Current Behavior (Defect)

### D1 — bypass guard fail-open

WHEN ส่ง command string `git commit --no-verify` เข้า `.ai/bin/check-bypass.sh` THEN guard คืน exit `2`
แต่ command string ที่ทำงานเทียบเท่า `\git commit --no-verify`, `"git" commit --no-verify` และ
`/usr/bin/git commit --no-verify` คืน exit `0`

Repro ที่รันแล้ว:

```text
raw rc=2
backslash_git rc=0
quoted_git rc=0
absolute_git rc=0
```

### D2 — destructive guard รวมผลข้าม SQL statement

WHEN ส่ง safe `DELETE FROM ... WHERE ...` และ unsafe `DELETE FROM ...` ใน input เดียวเข้า
`.ai/bin/check-destructive.sh` THEN `WHERE` จาก statement แรกทำให้ input ทั้งก้อนคืน exit `0`

Repro ที่รันแล้ว:

```text
safe rc=0
unsafe rc=2
mixed_safe_then_unsafe rc=0
```

### D3 — diff preview ซ่อน content change

WHEN เรียก `jsonDiffPreview("a\nb", "b\na")` THEN function คืน
`{"removed":[],"added":[]}` แม้ลำดับเปลี่ยน

WHEN เรียก `jsonDiffPreview("a\na", "a")` THEN function คืน
`{"removed":[],"added":[]}` แม้จำนวนบรรทัดซ้ำเปลี่ยน

### D4 — auth expiry ใช้ inclusive-valid boundary

WHEN mint session ที่หมดอายุเวลา `6000` แล้วเรียก `verifySession` ด้วย `now=6000` THEN function
ยังคืน principal และคืน `null` เมื่อ `now=6001`

WHEN verify OIDC JWT ที่ `exp === now / 1000` THEN function ยังคืน principal

WHEN callback ใช้ pending OIDC token ที่ `exp === now` THEN flow ยังเรียก token endpoint

Repro ที่รันแล้ว:

```text
session_eq_exp principal
session_after_exp null
jwt_eq_exp principal
jwt_after_exp null
pending_eq_exp_token_calls 1
pending_after_exp_token_calls 0
```

### D5 — auth config permission และ value validation ไม่ครบ

WHEN `loadAuthConfig` อ่าน JSON ที่ field type ถูกแต่ required value ว่าง THEN function คืน
`AuthConfig` แทน `null`

WHEN `loadAuthConfig` อ่าน config file ที่ mode ไม่ใช่ `0600` THEN function ไม่มี permission check
และถือ config ว่า valid ทำให้ `hasAuthProvider` เป็น `true`

Phase 1 ยืนยันจาก executable path และ test ปัจจุบัน: `provider.test.ts` สร้าง config โดยไม่กำหนด
mode `0600` แล้ว assertion คาดว่า loader ต้องรับ config ดังกล่าว

### D6 — full lint ขึ้นกับ ignored local state

WHEN `.claude/worktrees/**` มี nested harness workflow แล้วรัน
`CI=true ./node_modules/.bin/eslint .` THEN ESLint สแกนไฟล์ที่ Git ignore และ fail:

```text
.claude/worktrees/agent-adf93ded41dcc353b/.claude/workflows/review-fanout.js
106:1  error  Parsing error: 'return' outside of function
```

WHEN lint เฉพาะ tracked source scopes THEN ESLint ผ่าน

### D7 — dependency policy ไม่มี CI enforcement และ documentation ไม่ตรงจริง

WHEN ตรวจ `.github/workflows/ci.yml` THEN workflow มี install, typecheck, lint และ tests แต่ไม่มี
`pnpm audit` หรือ equivalent แม้ workspace มี `package.json`, `pnpm-lock.yaml` และ runtime
dependencies

WHEN ตรวจ `.ai/shared/SECURITY_RULES.md` และ CI header comment THEN documentation ยังระบุว่า repo
ไม่มี application code, package manifest, runtime dependency และ lint script

### D8 — secret scan รับ literal NUL ผ่าน command substitution

WHEN รัน `scripts/ci-secret-scope.sh push develop` THEN scan ผ่านแต่ shell เตือน:

```text
.ai/bin/check-secrets.sh: line 60: warning: command substitution: ignored null byte in input
```

tracked literal NUL อยู่ใน `console/backend/src/govern.ts` ภายใน glob sentinel

## Expected Behavior

- F1 WHEN bypass guard รับ command ที่ executable token resolve เป็น `git` ไม่ว่ามี shell quoting,
  escaping หรือ absolute path THE SYSTEM SHALL block skip-verification flags ด้วย exit `2`
- F2 WHEN destructive guard รับหลาย `DELETE FROM` statements THE SYSTEM SHALL ตรวจทุก statement
  แยกกันและ block input หาก statement ใดไม่มี `WHERE`
- F3 WHEN proposed content เปลี่ยนเฉพาะลำดับบรรทัด THE SYSTEM SHALL แสดง non-empty deterministic
  line diff โดยคง `{ removed, added }` API
- F4 WHEN proposed content เปลี่ยนเฉพาะจำนวนบรรทัดซ้ำ THE SYSTEM SHALL แสดงจำนวน removed หรือ
  added occurrences ตรงกับการเปลี่ยนจริง
- F5 WHEN session token มี `now >= exp` THE SYSTEM SHALL reject token ด้วย `null`
- F6 WHEN OIDC ID token มี `now / 1000 >= exp` THE SYSTEM SHALL reject token ด้วย `null`
- F7 WHEN pending OIDC token มี `now >= exp` THE SYSTEM SHALL reject callback ก่อนเรียก token
  endpoint
- F8 WHEN auth config file mode ไม่เท่ากับ `0600` THE SYSTEM SHALL ถือ config ว่า invalid
- F9 WHEN auth config required string ใดเป็น empty string THE SYSTEM SHALL ถือ config ว่า invalid
- F10 IF remote startup ไม่มี valid auth config THEN THE SYSTEM SHALL refuse startup ผ่าน
  `decideStartup` path เดิม
- F11 WHEN full lint รันใน clone ที่มี `.claude/worktrees/**` THE SYSTEM SHALL lint tracked source
  โดยไม่ parse local harness worktree
- F12 WHEN CI install workspace ที่มี runtime dependencies THE SYSTEM SHALL run blocking
  production dependency audit ที่ severity threshold `high`
- F13 THE SYSTEM SHALL document CI, package manifests, lint และ runtime dependency state ให้ตรง
  repository ปัจจุบัน
- F14 WHEN full-tree secret scan อ่าน tracked source THE SYSTEM SHALL จบโดยไม่มี null-byte warning

## Unchanged Behavior

- B1 WHEN harmless prose กล่าวถึง skip-verification flag โดยไม่มี executable `git` command
  THE SYSTEM SHALL CONTINUE TO allow prose
- B2 WHEN ทุก `DELETE FROM` statement ใน input มี `WHERE` ของตัวเอง THE SYSTEM SHALL CONTINUE TO
  allow input
- B3 WHEN single-statement `DELETE FROM` ไม่มี `WHERE` THE SYSTEM SHALL CONTINUE TO block input
- B4 WHEN content มี ordinary added และ removed lines THE SYSTEM SHALL CONTINUE TO คืน removed และ
  added lines ตามลำดับของ source แต่ละฝั่ง
- B5 WHEN consent token ถูกสร้างจาก proposed content THE SYSTEM SHALL CONTINUE TO bind token กับ
  exact `baseHash` และ exact content
- B6 WHEN session, JWT หรือ pending OIDC token มี `now < exp` THE SYSTEM SHALL CONTINUE TO accept
  token ที่ผ่าน signature และ claim checks อื่น
- B7 WHEN token malformed, tampered หรือมี claim ผิด THE SYSTEM SHALL CONTINUE TO reject แบบ
  generic โดยไม่ throw
- B8 WHEN auth config เป็น valid Basic config, mode `0600` และ required values non-empty
  THE SYSTEM SHALL CONTINUE TO load config
- B9 WHEN auth config เป็น valid OIDC config, mode `0600` และ required values non-empty
  THE SYSTEM SHALL CONTINUE TO pin issuer เป็น `https://accounts.google.com`
- B10 WHEN auth config missing หรือ JSON malformed THE SYSTEM SHALL CONTINUE TO คืน `null`
- B11 WHEN lint รันกับ tracked source THE SYSTEM SHALL CONTINUE TO report tracked lint violations
- B12 WHEN CI รัน THE SYSTEM SHALL CONTINUE TO execute vendor check, install, typecheck, lint,
  scoped/full tests, guard tests, lessons coverage, secret scan และ spec trace
- B13 WHEN dependency audit พบเฉพาะ advisory ต่ำกว่า `high` THE SYSTEM SHALL CONTINUE TO ไม่ fail
  audit step
- B14 WHEN permission glob มี `*` หรือ `**` THE SYSTEM SHALL CONTINUE TO match path ตาม semantics
  ปัจจุบัน
- B15 WHEN secret scan พบ secret pattern จริง THE SYSTEM SHALL CONTINUE TO fail closed
- B16 WHEN reported-only candidate อยู่ใน scope scan THE SYSTEM SHALL CONTINUE TO leave
  `scripts/spec-slice.sh`, `adapters/src/codex-live.ts`, `scripts/spec-archive.sh` และ retention
  behavior unchanged
- B17 WHEN implementation เสร็จ THE SYSTEM SHALL CONTINUE TO ใช้ dependency graph และ lockfile เดิม
  โดยไม่เพิ่ม dependency หรือแก้ `pnpm-lock.yaml`
