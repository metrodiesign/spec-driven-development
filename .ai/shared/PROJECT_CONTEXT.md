> Canonical source for ALL agents (Claude loads via .claude/rules stub; Codex/OpenCode/Pi read directly).
> แก้ที่นี่ที่เดียว — single source of truth.

# Product Overview

## Purpose

แพลตฟอร์ม self-hosted ตัวเดียวที่รันบนเครื่องของเจ้าของบัญชีเอง ใช้ Claude Code เป็น
substrate ในการทำงานวิศวกรรมซอฟต์แวร์สองแบบบนฐานเดียว: **Interactive mode** (binary
`claude` ตัวจริงผ่าน PTY สตรีมขึ้นเว็บ = 100% CLI parity สำหรับงานที่มนุษย์นำ) และ
**Autonomous mode** (โมเดลเสนอ structured action, deterministic core ลงมือและตรวจเองใน
sandbox ด้วย golden tests, มนุษย์อนุมัติที่ระดับ task/risk) — อ้างอิง
`unified-platform-spec.md` §1.1

## Target Users

เจ้าของบัญชี Claude Max 20x subscription รายเดียวที่ต้องการใช้โควตาของตัวเองขับงาน
engineering ทั้งแบบมีคนนำและแบบรันเองไม่มีคนเฝ้า บนเครื่องของตัวเอง — เป็น single-operator
โดยเจตนา ไม่มีกลุ่มผู้ใช้หลายคนหรือ role ผู้ใช้ (§1.3)

## Problem It Solves

การรัน Claude Code แบบ autonomous ปลอดภัยต้องแยก "โมเดลเสนอ" ออกจาก "ระบบลงมือและตัดสินว่า
สำเร็จ" (propose/dispose) มิฉะนั้นไม่มีทางรับประกันว่างานที่ถูก mark ว่าเสร็จนั้นถูกต้องจริง
บน frozen artifact แพลตฟอร์มนี้ให้ deterministic core เป็นคนลงมือและตรวจ ทำให้ได้ทั้งความ
สะดวกของ interactive CLI parity และความปลอดภัยของ autonomous loop บน substrate เดียวโดยไม่
ต้องเลือกอย่างใดอย่างหนึ่ง (§1.1, §1.2)

## Key Features

- Interactive surface ที่เป็น binary `claude` ตัวจริงผ่าน PTY (100% CLI parity, INV-17)
- Autonomous propose/dispose loop: core executor ลงมือใน sandbox + gate ladder + golden tests
- Ring 0 deterministic core ที่ปลอด vendor name (INV-7) เพื่อ testability และ quota-survivability
- Egress default-deny ทุก `RUN_COMMAND` ใน autonomous mode + secret scan แบบ block (INV-14)
- Console เป็น operator surface เดียวสำหรับ sessions, usage, governance และ approval package
- SDD integration: เชื่อม spec artifacts กับ Goal Contract เป็น traceability สองทาง (Phase 5)

## Business Objectives

- ความปลอดภัยของ autonomous mode วัดจาก fault-injection DoD ผ่านครบ (โมเดลโกหกว่าสำเร็จ,
  action นอกสิทธิ์, แอบออก network ฯลฯ) ก่อนต่อโมเดลจริงในแต่ละ phase
- Interactive parity วัดจากการรัน slash command / plan mode / attach-detach PTY ได้เท่า CLI
- แต่ละ phase "เสร็จ" เมื่อผ่าน DoD (fault-injection + calibration + security checklist)
  ไม่ใช่แค่ "เขียนโค้ดครบ" (§0, §14)

## Non-Goals

- ไม่เป็น multi-user: ไม่มี endpoint สร้างผู้ใช้เพิ่ม ไม่มี role ผู้ใช้ (single-operator, INV-15)
- ไม่แตะ/เก็บ/proxy credential token ของ Claude Code — auth ผ่าน credential chain เดิมเท่านั้น (INV-12)
- ไม่เป็นผลิตภัณฑ์ของ Anthropic — เป็นเครื่องมือ third-party ที่รันบนเครื่อง user เอง
- ไม่ bridge auth ไปเครื่องมืออื่น (§1.3)
