# Lessons (promoted from retrospectives)

> Add ONLY genuinely reusable, mistake-preventing lessons here. Prune stale ones.
> The full record lives in `retrospectives/`. Keep this file lean (see §10 of the guide).

- **Pattern**: pure-logic-first — แยก logic ที่ทดสอบได้ (เช่น สูตรคำนวณ/validation) ออกเป็น pure function ใน `lib/` แล้วเขียน unit test ให้เขียวก่อนแตะ UI. — **Why**: ความถูกต้องไม่ปนกับ rendering, ปิด acceptance ที่เป็นตัวเลขได้ก่อน wire UI.
- **Pattern**: ตอนตรวจ interaction ผ่าน browser_evaluate กับ React controlled component ให้แยก "action (click/dispatch)" กับ "read DOM" เป็นคนละ evaluate call. — **Why**: React re-render เป็น async; อ่านใน call เดียวกับ click จะได้ค่าเก่า (race) → เกือบรายงานว่า UI พังทั้งที่ logic ถูก.
- **Pattern**: /spec-analyze ก่อน design คุ้มเสมอสำหรับฟีเจอร์ที่มี logic — มันจับ conflict/gap ที่ทำให้ test เขียนไม่ได้ (หน่วย/วิธีปัดเศษของผลลัพธ์, trigger คำนวณ, empty state, conflict รูป-ต้องมีเน็ต-vs-ห้าม broken). — **Why**: แก้ที่ requirements ถูกกว่าแก้โค้ดทีหลัง.
