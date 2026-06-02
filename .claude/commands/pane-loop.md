---
description: รัน pane-loop orchestrator — 1 task = 1 iTerm pane interactive (รัน /spec-implement → /spec-retro → /clear ต่อ task)
argument-hint: <feature-name> [task-ids...]
allowed-tools: Bash, Read
---

รัน orchestrator `scripts/pane-loop.sh` ด้วย args ที่ผู้ใช้ให้: `$ARGUMENTS`

ขั้นตอน:

1. ก่อนรัน — ตรวจว่าไม่มี pane-loop ค้างอยู่ (background task ที่ยังรัน). ถ้ามี ให้แจ้งและหยุด อย่ารันซ้ำ (pane จะชนกัน, tasks share tree เดียว).
2. รัน `bash scripts/pane-loop.sh $ARGUMENTS` ผ่าน Bash tool แบบ `run_in_background: true`.
   - ห้ามใช้ `!`-prefix execution — script เป็น long-running (รอ task ขึ้น `[x]`, timeout ต่อ task default 2400s) ต้องเป็น background.
3. `sleep ~18s` แล้ว Read ไฟล์ output ของ background task — ยืนยันว่า:
   - parse task ถูก (บรรทัด `Feature: <name> | task: ...`)
   - เปิด pane ได้ (บรรทัด `::: task N — เปิด pane interactive` + `พิมพ์ /spec-implement N`)
     ถ้าเห็น error (`เปิด pane ไม่สำเร็จ`, `ไม่พบ tasks.md`, `ไม่มี task ที่จะรัน`) → รายงานและหยุด.
4. รายงานลำดับ task ที่จะรัน + วิธีดูความคืบหน้า (ดู iTerm pane สด, หรือ tail ไฟล์ output). แจ้งว่าจะ notify เมื่อจบทุก task.

หมายเหตุข้อจำกัด:

- ต้องมี **iTerm2** เปิดอยู่ (script ใช้ AppleScript `current session of current window`).
- task ids = **space-separated** (`12 13 14`) ไม่รองรับ range (`12-15`). ไม่ใส่ ids = ทำทุก task ค้าง.
- default `--dangerously-skip-permissions` (hands-free, scope repo นี้). override ได้ด้วย env `CLAUDE_FLAGS=""`.
- task ที่ `[x]` แล้วถูกข้ามอัตโนมัติ; ถ้า task ไม่ขึ้น `[x]` ใน timeout → script หยุดและ **เปิด pane ค้างไว้ให้ตรวจ**.
