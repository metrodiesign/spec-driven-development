# Handoff: Task 69 — ปิด P0-02 (ปลด real-macOS blocker แก้ regression 4 ข้อ)

> จาก: Claude session 2026-08-02/03  ถึง: agent Phase 0 คนถัดไป  วันที่: 2026-08-03

## สรุปงาน

ปิด Task 2 (P0-02) หลังรัน external real-macOS suite ที่ blocked มาตั้งแต่ Task 07
ได้จริงเป็นครั้งแรก การรันครั้งแรกล้ม 4 ข้อ จึงแก้ production 2 จุด
และ test fixture 2 จุด แล้วรันใหม่จนเขียวทั้งหมด

## สถานะปัจจุบัน

`Task 2 = [x]` — Evidence block เต็มอยู่ใน `tasks.md`

## สิ่งที่ real run เปิดโปง

รัน `PHASE0_REAL_MACOS_TESTS=1` นอก managed sandbox (flag นี้ปลด skip ของ probe
ที่ต้องใช้ `sandbox-exec` จริงแบบไม่ซ้อน)

1. `DoD#2c`, `DoD#2d`, `DoD#3` — ได้ `command_failed` แทน `sandbox_violation`
   สาเหตุ: `denyNetworkSandbox` ไม่เคย implement `observeDirectResult` เลย
   ทำให้ `source: 'enforcement_owned_direct'` ไม่มี producer ใน production
   (มีแต่ fake backend ใน test) — REQ-2.5 ไม่ได้ถูก implement บน backend จริง
2. real offline `package_install` — `exit=null signal=SIGKILL`
   สาเหตุ: approved-source roots เป็น kill-on-write; pnpm probe staging ใน
   source dir แล้ว handle `EPERM` ได้ แต่ตายเมื่อโดน `SIGKILL`

## การแก้ฝั่ง production

- `core/src/security/sandbox.ts`
  - เพิ่ม `observeDirectResult`: direct-child `SIGKILL` ที่ core ไม่ได้สั่ง
    ถูก attribute เป็น `{source:'enforcement_owned_direct', operation:'unknown'}`
    (wait status คือ parent-owned kernel state ไม่ใช่ child output จึงไม่ขัด
    REQ-2.22; core-initiated timeout/cancel/output-limit ถูกจำแนกก่อนหน้าแล้ว)
  - เพิ่ม `offlineInstall.gracefulDenyRoots`: ลด approved-source roots จาก
    kill-on-write เป็น plain deny (ยังเขียนไม่ได้) เฉพาะ policy-approved install
  - guard: reject graceful root ที่ครอบ protected root
- `core/src/executor/command-executor.ts`
  - install path ส่ง gracefulDenyRoots แทนการใส่ source roots ใน protectedRoots
  - `validatePnpmModulesMetadata` derive `pendingBuilds` จาก frozen approved
    source bytes (build scripts หรือ `binding.gyp`) แทนการเหมาทุก package
  - `typedEvidence` ผูก `offlineInstallProfile` ระดับ command
- `core/src/security/command-runner.ts` — pass-through `offlineInstall`

## การแก้ระหว่างทางที่ถูกปฏิเสธ (บันทึกไว้เพราะเคยอยู่ใน tree จริง)

เคยเพิ่ม `(allow network* (local unix))(allow network* (remote unix))` โดยเข้าใจผิด
ว่า pnpm ต้องใช้ unix socketpair adversarial review พิสูจน์ว่า

- เปิด DNS exfil จริงผ่าน mDNSResponder (unique label resolve ได้)
- ต่อ `/var/run/docker.sock` ได้จริง (Docker API หนีได้ทั้ง network และ filesystem)
- node IPC socketpair ทำงานได้อยู่แล้วใต้ plain deny — เหตุผลที่ยกมา justify เป็นเท็จ

ถอนออกทั้งหมด สาเหตุจริงคือ FS kill-on-write ล้วน ๆ profile สุดท้ายไม่มี network
relaxation ใด ๆ (ยืนยันด้วย probe: DNS, raw-IP TCP, UDP, unix-socket ทั้งหมด rc=137)

## การตรวจสอบ

- focused P0-02 (`PHASE0_REAL_MACOS_TESTS=1`): `252` tests, `252` pass, `0` skip
- full core: `576` tests, `576` pass, `0` fail, `0` skip (เดิมมี `9` external skip)
- full console-backend: `394/394` (EPERM ที่เคยบันทึกเป็น managed-sandbox artifact)
- full AAL: `148/148`
- `pnpm typecheck` (6 projects), `pnpm lint`, vendor check, spec-trace `144` — ผ่าน

## การเปลี่ยนฝั่ง CI

macOS platform job export `PHASE0_REAL_MACOS_TESTS=1` แล้ว มิฉะนั้น probe เหล่านี้
จะ skip เงียบใน gate ทั้งที่ runner เป็น macOS ที่ไม่ซ้อน sandbox

## Residual (ไม่เปลี่ยน)

- descendant ที่สร้าง session ใหม่ยังกิน CPU และ process lifetime ได้หลัง cleanup
- denial-observation scope = `direct_only`; descendant denial ที่ parent กลืน
  ยังคง `observedViolation: null`
- child ที่ self-`SIGKILL` และ external/OOM kill ถูก reject แบบระมัดระวัง
  (fail-closed false positive ไม่ใช่ false success)

## Blocker Phase 0 ที่เหลือ ณ เวลานั้น

- Task 8 (P0-08): ยังไม่มี operator-supplied golden fixture bytes — ห้ามสร้างเอง
  (ภายหลัง operator ส่งมาแล้ว ดู `task-72-p0-08-close.md`)
- Task 10 (P0-10): ปิดไม่ได้จนกว่า Task 8 จะปลด
