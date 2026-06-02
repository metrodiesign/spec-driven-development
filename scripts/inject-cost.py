#!/usr/bin/env python3
"""ฉีด cost จริง (จาก ledger) เข้าท้ายไฟล์ retrospective ของแต่ละ task. idempotent
(มี marker แล้วข้าม). ค่าคงที่/regex ที่ผูกกับ workflow อยู่ใน cost_lib.py (แก้ที่เดียว).

หมายเหตุ map retro->task: ใช้ลำดับ mtime ของไฟล์ retro = task 1..N (สมมติ 1 retro/task,
เขียนเรียงตามลำดับ task, glob ครอบเฉพาะ run นี้). ถ้า workflow ทำหลาย retro/task หรือ
ปน feature ในโฟลเดอร์เดียว index จะเลื่อนแบบเงียบ — ดู §จุดที่ 3 ของการวิเคราะห์ coupling.
"""
import glob, os
from cost_lib import task_costs, render_breakdown

RETRO_GLOB = "retrospectives/*/*/*.md"
MARK = "## Cost (จริง — Claude Code ledger)"

cost = task_costs()

# retro files (run window) sorted by mtime = task order
retros = sorted(glob.glob(RETRO_GLOB), key=lambda p: os.stat(p).st_mtime)
for i, rf in enumerate(retros):
    task = i + 1
    body = open(rf, encoding="utf-8").read()
    if MARK in body:
        continue  # idempotent
    if task in cost:
        c, dur, la, lr, sid = cost[task]
        m = dur // 60000
        s = (dur % 60000) // 1000
        bd = "\n".join(render_breakdown(sid, c, heading="Breakdown ต่อ model"))
        sec = (f"\n{MARK}\n\n"
               f"- cost: **${c:.2f}** (ค่าประมาณ Claude Code; subscription ไม่คิดเงินจริง)\n"
               f"- duration: {m}m{s:02d}s\n"
               f"- lines: +{la:,} / -{lr:,}\n"
               f"- แหล่ง: `.cost.total_cost_usd` payload statusLine -> ledger\n\n"
               f"{bd}\n")
    else:
        sec = (f"\n{MARK}\n\n"
               f"- cost: ไม่บันทึก (session ปิดก่อนติดตั้ง ledger; resume reset=0, transcript-sum ไม่แม่น)\n")
    open(rf, "a", encoding="utf-8").write(sec)
    print(f"task {task}: ฉีดเข้า {os.path.basename(rf)}  "
          f"({'$%.2f' % cost[task][0] if task in cost else 'n/a'})")
