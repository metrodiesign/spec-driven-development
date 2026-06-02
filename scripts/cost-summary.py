#!/usr/bin/env python3
"""สรุป cost จริงต่อ task จาก ledger (~/.claude/cost-sessions/) -> ตาราง markdown ที่
retrospectives/cost-<feature>.md. cost = .cost.total_cost_usd จาก Claude Code
(authoritative). task ที่ปิดก่อนมี ledger = ไม่มีข้อมูล.

Generic: project/feature/จำนวน task auto-detect. ค่าคงที่/regex ที่ผูกกับ workflow
อยู่ใน cost_lib.py (แก้ที่เดียว).
"""
import os
from cost_lib import detect_feature, all_task_ids, task_costs, render_breakdown

MY_SESSION = os.environ.get("MY_SESSION", "")  # orchestrator session id to exclude
FEATURE = detect_feature()
TASKS = f".claude/specs/{FEATURE}/tasks.md"
OUT = f"retrospectives/cost-{FEATURE}.md"

costs = task_costs(exclude_session=MY_SESSION)
ALL = all_task_ids(TASKS)

L = [f"# Cost จริงต่อ task — {FEATURE}",
     "",
     "แหล่ง: `.cost.total_cost_usd` จาก payload statusLine ของ Claude Code (เก็บผ่าน ledger",
     "`~/.claude/cost-sessions/`). เป็นค่าประมาณของ Claude Code (subscription ไม่คิดเงินจริง)",
     "แต่เป็นเลขเดียวกับที่ `/cost` แสดง.",
     "",
     "| task | cost $ | duration | +lines | -lines |",
     "|----:|------:|---------|------:|------:|"]
tot = 0.0
for t in ALL:
    if t in costs:
        c, dur, la, lr, sid = costs[t]
        tot += c
        m = dur // 60000
        s = (dur % 60000) // 1000
        L.append(f"| {t} | {c:.2f} | {m}m{s:02d}s | {la:,} | {lr:,} |")
    else:
        L.append(f"| {t} | — | — | — | — |  (ปิดก่อนมี ledger / ยังไม่เสร็จ)")
have = sorted(costs)
missing = [t for t in ALL if t not in costs]
L += ["", f"**รวม task ที่บันทึกได้: ${tot:.2f}**",
      "", f"_task ที่มีข้อมูล: {', '.join(str(t) for t in have) or '—'}_"]
if missing:
    L.append(f"_task ที่ไม่มีข้อมูล: {', '.join(str(t) for t in missing)} "
             "(ปิดก่อนติดตั้ง ledger -> cost จริงหายถาวร; resume reset=0, transcript-sum ไม่แม่น)_")

# breakdown ละเอียดต่อ task (per-model + cache) ใต้ตารางสรุป
L += ["", "## Breakdown ละเอียดต่อ task", ""]
for t in have:
    c, _, _, _, sid = costs[t]
    L += render_breakdown(sid, c, heading=f"task {t} — ${c:.2f}") + [""]

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w", encoding="utf-8").write("\n".join(L) + "\n")
print("\n".join(L))
print(f"\n-> เขียน {OUT}")
