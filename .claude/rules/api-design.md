---
paths:
  - "src/app/api/**/*"
  - "src/server/**/*"
---
# API Design Standards
- ทุก endpoint return รูปแบบ error เดียวกัน: { error: { code, message } }
- ใช้ HTTP status code ตามมาตรฐาน
- validate input ที่ชั้น handler ก่อนเสมอ
