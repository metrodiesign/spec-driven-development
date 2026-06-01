# Cost จริงต่อ task — insurance-homepage

แหล่ง: `.cost.total_cost_usd` จาก payload statusLine ของ Claude Code (เก็บผ่าน ledger
`~/.claude/cost-sessions/`). เป็นค่าประมาณของ Claude Code (subscription ไม่คิดเงินจริง)
แต่เป็นเลขเดียวกับที่ `/cost` แสดง.

| task | cost $ | duration | +lines | -lines |
|----:|------:|---------|------:|------:|
| 1 | — | — | — | — |  (ปิดก่อนมี ledger / ยังไม่เสร็จ)
| 2 | — | — | — | — |  (ปิดก่อนมี ledger / ยังไม่เสร็จ)
| 3 | — | — | — | — |  (ปิดก่อนมี ledger / ยังไม่เสร็จ)
| 4 | 7.24 | 18m35s | 541 | 11 |
| 5 | 4.53 | 9m36s | 670 | 10 |
| 6 | 6.10 | 11m58s | 670 | 4 |
| 7 | 2.83 | 6m12s | 484 | 3 |
| 8 | 2.92 | 6m06s | 382 | 2 |
| 9 | 3.39 | 7m15s | 200 | 3 |

**รวม task ที่บันทึกได้: $27.01**

_task ที่มีข้อมูล: 4, 5, 6, 7, 8, 9_
_task 1-3 ปิดก่อนติดตั้ง ledger → cost จริงหายถาวร (resume reset=0, transcript-sum ไม่แม่น)_
