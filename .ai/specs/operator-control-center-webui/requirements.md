# Requirements: Operator Control Center Web UI

> Status: approved 2026-08-12, amended 2026-08-12

## Overview

ฟีเจอร์นี้ปรับ Console SPA ให้เป็นศูนย์ควบคุมสำหรับ single operator โดยจัดระบบตาม Dashboard, Core, AAL, Adapters และ Console ใช้แนวคิด three-panel, control center และ progressive disclosure จาก [Hermes WebUI](https://github.com/nesquena/hermes-webui) เป็น reference แต่คง architecture, security boundary และ React stack ของแพลตฟอร์มนี้

## Scope and Decisions

| Area | ขอบเขตที่รวม | Boundary |
|---|---|---|
| Dashboard | health, active runs, pending approvals, usage/quota, PR quality | อ่านข้อมูลจริงจาก Console API |
| Core | task state, gates, evidence, budget, audit | read-only |
| AAL | routing, breaker, rate limit, conformance, fusion | read-only |
| Adapters | registration, capabilities, model mapping, health, conformance | read-only และไม่แสดง credential |
| Console | projects, sessions, terminal, chat, loop, scheduler, issues, PR quality, governance | ใช้ governed actions ที่มี contract อยู่แล้ว |

ขอบเขตนี้ไม่รวม `scripts/`, `spikes/`, multi-user roles, การเปลี่ยน execution semantics ของ Core/AAL/Adapters, dependency ใหม่ หรือการคัดลอก source, CSS และ asset จาก Hermes WebUI

## REQ-1: Application Shell and Navigation

**User Story:** ในฐานะ platform operator ฉันต้องการ navigation ที่สะท้อนส่วนประกอบจริงของระบบ เพื่อเข้าถึงสถานะและ control ที่ต้องใช้โดยไม่เลื่อนผ่านหน้าเดียวขนาดยาว

**Acceptance Criteria (EARS):**

- 1.1 THE SYSTEM SHALL แสดง navigation หลักสำหรับ Dashboard, Core, AAL, Adapters และ Console
- 1.2 WHEN operator เลือก navigation item THE SYSTEM SHALL แสดง workspace ของ item นั้นเป็น main content
- 1.3 WHERE selected item มีรายละเอียดที่ inspect ได้ THE SYSTEM SHALL แสดงรายละเอียดใน context inspector
- 1.4 WHEN operator เปิด deep link ที่ถูกต้อง THE SYSTEM SHALL คืนค่า area, view, project และ selected item จาก URL
- 1.5 WHEN operator เปลี่ยน area หรือ selected item THE SYSTEM SHALL อัปเดต URL ให้ copy และเปิดซ้ำได้
- 1.6 IF URL อ้าง area ที่ไม่มีอยู่ THEN THE SYSTEM SHALL เปิด Dashboard และแสดงข้อความว่า link เดิมใช้ไม่ได้
- 1.7 WHILE non-critical technical detail ยังไม่ถูกเลือก THE SYSTEM SHALL ซ่อน detail นั้นด้วย progressive disclosure
- 1.8 IF state ต้องการ approval หรือเกิด error ที่ต้องแก้ THEN THE SYSTEM SHALL แสดง state นั้นโดยไม่ซ่อนไว้หลัง disclosure ที่ปิดอยู่
- 1.9 IF URL อ้าง selected item ที่ไม่มีอยู่ภายใน area ที่ถูกต้อง THEN THE SYSTEM SHALL คง area เดิมและแสดง empty inspector พร้อมข้อความว่า item ใช้ไม่ได้
- 1.10 WHEN browser Back หรือ Forward เปลี่ยน URL THE SYSTEM SHALL คืนค่า navigation state จาก URL โดยไม่สร้าง mutation
- 1.11 THE SYSTEM SHALL encode เฉพาะ area, view, project และ selected-item identifier ใน URL
- 1.12 THE SYSTEM SHALL ไม่ encode credential, token, confirmation token หรือ editor draft ใน URL

## REQ-2: Operational Dashboard

**User Story:** ในฐานะ platform operator ฉันต้องการเห็นสถานะสำคัญในหน้าเดียว เพื่อเลือกงานที่ต้องจัดการก่อนโดยไม่ตรวจแต่ละ module แยกกัน

**Acceptance Criteria (EARS):**

- 2.1 THE SYSTEM SHALL แสดง health summary ของ host และ Console services
- 2.2 THE SYSTEM SHALL แสดงจำนวน autonomous runs ที่ active
- 2.3 THE SYSTEM SHALL แสดงจำนวน approval packages ที่รอ operator
- 2.4 THE SYSTEM SHALL แสดง usage และ quota estimate พร้อม disclaimer ของแหล่งข้อมูล
- 2.5 THE SYSTEM SHALL แสดง summary ของ PR quality runs ล่าสุด
- 2.6 WHEN operator เลือก host-health หรือ usage summary THE SYSTEM SHALL เปิด Console System หรือ Console Usage view ตามลำดับ
- 2.7 WHEN dashboard แสดงค่า THE SYSTEM SHALL ใช้ข้อมูลจาก API จริงแทน mock หรือ placeholder value
- 2.8 IF dashboard data source หนึ่งล้มเหลว THEN THE SYSTEM SHALL จำกัด error state ไว้ที่ summary ของ source นั้น
- 2.9 IF dashboard data source ไม่มี record THEN THE SYSTEM SHALL แสดง empty state ที่บอกวิธีทำให้เกิด record แรก
- 2.10 WHEN dashboard data ถูกโหลดสำเร็จ THE SYSTEM SHALL แสดงเวลาที่ข้อมูลถูกอ่านล่าสุด
- 2.11 WHEN operator เลือก autonomous-runs หรือ pending-approvals summary THE SYSTEM SHALL เปิด Console Runs view
- 2.12 WHEN operator เลือก PR-quality summary THE SYSTEM SHALL เปิด Console PR Quality view
- 2.13 WHEN operator ขอ refresh Dashboard THE SYSTEM SHALL reload เฉพาะ read-only data sources โดยไม่เริ่ม domain action

## REQ-3: Core Read-Only Management

**User Story:** ในฐานะ platform operator ฉันต้องการ inspect deterministic core จาก UI เพื่อพิสูจน์ว่า run, gate และ evidence อยู่ใน state ใดโดยไม่แก้ source of truth จาก browser

**Acceptance Criteria (EARS):**

- 3.1 THE SYSTEM SHALL แสดงรายการ autonomous loop runs พร้อม task identifier และ current state
- 3.2 WHEN operator เลือก run THE SYSTEM SHALL แสดง task graph และ state transition history ของ run นั้น
- 3.3 WHEN operator เลือก task THE SYSTEM SHALL แสดง gate result แยกตาม tier
- 3.4 WHEN gate result มี evidence THE SYSTEM SHALL แสดง evidence metadata และ content reference ที่ redacted แล้ว
- 3.5 WHEN run มี budget projection THE SYSTEM SHALL แสดงค่าที่ใช้ไปและ cap ของ iterations, cost units และ wallclock
- 3.6 WHEN run มี audit events THE SYSTEM SHALL แสดง events ตาม server append sequence แทนลำดับที่ browser รับข้อมูล
- 3.7 WHILE operator อยู่ใน Core area THE SYSTEM SHALL ไม่แสดง control ที่ mutate domain state แต่ยังให้ใช้ navigation, selection, filter, search, copy และ refresh ได้
- 3.8 IF Core status field ไม่มีข้อมูลหรืออ่านไม่ได้ THEN THE SYSTEM SHALL แสดง field นั้นเป็น unavailable พร้อม reason ที่ API คืนมา
- 3.9 IF evidence reference ไม่สามารถเปิดได้ THEN THE SYSTEM SHALL คง gate verdict เดิมและแสดง evidence-unavailable state

## REQ-4: AAL Read-Only Management

**User Story:** ในฐานะ platform operator ฉันต้องการเห็น routing และ resilience state ของ AAL เพื่อเข้าใจว่า role ใดจะใช้ adapter ใดและ fallback เพราะอะไร

**Acceptance Criteria (EARS):**

- 4.1 THE SYSTEM SHALL แสดง routing role พร้อม ordered eligible adapters และ fallback order
- 4.2 THE SYSTEM SHALL แสดง breaker state ของ routing target แต่ละตัว
- 4.3 THE SYSTEM SHALL แสดง rate-limit policy และ recorded limit state ของ routing target แต่ละตัว
- 4.4 THE SYSTEM SHALL แสดง conformance P1-P8 summary จาก latest valid record ที่ authoritative source เลือกให้แต่ละ eligible adapter
- 4.5 THE SYSTEM SHALL แสดง Fusion policy และสถานะ recorded run ล่าสุดที่มีข้อมูล
- 4.6 WHEN AAL status แสดงค่าจาก config หรือ calibration record THE SYSTEM SHALL แสดง source provenance และ source timestamp
- 4.7 WHILE operator อยู่ใน AAL area THE SYSTEM SHALL ไม่แสดง control ที่ mutate domain state แต่ยังให้ใช้ navigation, selection, filter, search, copy และ refresh ได้
- 4.8 WHEN operator เปิด AAL area THE SYSTEM SHALL ไม่เริ่ม conformance run, provider call หรือ routing probe
- 4.9 IF AAL record ไม่มีอยู่ THEN THE SYSTEM SHALL แสดง empty state โดยไม่ตีความว่า target ผ่าน conformance
- 4.10 IF AAL record ไม่มี freshness metadata THEN THE SYSTEM SHALL ไม่ label record นั้นว่า live หรือ fresh

## REQ-5: Adapter Read-Only Management

**User Story:** ในฐานะ platform operator ฉันต้องการ inspect adapter แต่ละตัวเพื่อรู้ capability, model mapping และ readiness โดยไม่เปิดเผย credential หรือใช้ quota โดยไม่ตั้งใจ

**Acceptance Criteria (EARS):**

- 5.1 THE SYSTEM SHALL แสดง adapter identifier, transport type และ registration eligibility
- 5.2 WHEN operator เลือก adapter THE SYSTEM SHALL แสดง capability manifest ที่ adapter ประกาศ
- 5.3 WHEN adapter มี model mapping THE SYSTEM SHALL แสดง role-to-model mapping ที่มีผลอยู่
- 5.4 WHEN adapter มี health, calibration หรือ conformance record THE SYSTEM SHALL แสดง health, calibration และ conformance เป็นคนละ status จาก latest valid record ของแต่ละ dimension
- 5.5 WHEN recorded adapter status ถูกแสดง THE SYSTEM SHALL ระบุว่าเป็น recorded status พร้อม source provenance และ source timestamp
- 5.6 THE SYSTEM SHALL ไม่แสดง API key, token, password, private key, connection string หรือ raw credential value
- 5.7 WHEN operator เปิดหรือเปลี่ยน adapter selection THE SYSTEM SHALL ไม่ส่ง live model request หรือ connectivity probe
- 5.8 WHILE operator อยู่ใน Adapters area THE SYSTEM SHALL ไม่แสดง control ที่ mutate domain state แต่ยังให้ใช้ navigation, selection, filter, search, copy และ refresh ได้
- 5.9 IF adapter status dimension ไม่มี valid record THEN THE SYSTEM SHALL แสดงเฉพาะ dimension นั้นเป็น unknown แทน healthy
- 5.10 IF adapter record malformed THEN THE SYSTEM SHALL แสดง dimension ของ record นั้นเป็น invalid-record โดยไม่ใช้ record นั้นตัดสิน eligibility

## REQ-6: Console Workspace and Operations

**User Story:** ในฐานะ platform operator ฉันต้องการใช้ interactive และ autonomous controls เดิมผ่าน navigation ใหม่ เพื่อให้ redesign ไม่ตัด capability ที่ระบบส่งมอบแล้ว

**Acceptance Criteria (EARS):**

- 6.1 THE SYSTEM SHALL แสดง project registry พร้อม session count และ loop-managed status
- 6.2 WHEN operator เลือก project THE SYSTEM SHALL ใช้ project นั้นเป็น context ของ Sessions, Terminal, Chat และ project-scoped governance views
- 6.3 WHEN project มี sessions THE SYSTEM SHALL แสดง session identifier, first timestamp, last timestamp และ entry count
- 6.4 WHERE request มาจาก local loopback session THE SYSTEM SHALL ให้ operator เปิด, attach, detach และ reattach Terminal session ได้
- 6.5 WHERE request เป็น remote session THE SYSTEM SHALL ปิด Terminal controls และแสดงเหตุผลว่า Terminal ใช้ได้เฉพาะ local host
- 6.6 WHEN operator เปิด Chat THE SYSTEM SHALL แสดง label ว่า Chat เป็น enhanced SDK view และไม่เท่ากับ CLI parity
- 6.7 WHEN Chat ขอ tool approval THE SYSTEM SHALL ให้ operator เลือก allow หรือ deny สำหรับ request นั้น
- 6.8 WHEN operator เลือก autonomous loop run THE SYSTEM SHALL แสดง events, approvals และ deploy state ของ run นั้น
- 6.9 WHERE run state อนุญาต pause หรือ resume THE SYSTEM SHALL แสดง action ที่ตรงกับ state ปัจจุบัน
- 6.10 WHERE run ยังไม่อยู่ใน terminal state THE SYSTEM SHALL ให้ operator ส่ง kill action ผ่าน Human Plane API ได้
- 6.11 WHEN approval package รอ decision THE SYSTEM SHALL ให้ operator approve หรือ reject package นั้นผ่าน Human Plane API
- 6.12 WHEN deploy decision รอ operator THE SYSTEM SHALL ให้ operator ส่ง decision หรือ rollback ผ่าน Human Plane API ตาม state ที่อนุญาต
- 6.13 WHEN Scheduler ไม่มี child process ที่ active THE SYSTEM SHALL ให้ operator เริ่ม loop process หรือ allowlisted script ตาม contract เดิม
- 6.14 WHEN Scheduler มี child process ที่ active THE SYSTEM SHALL ให้ operator หยุด process นั้นตาม contract เดิม
- 6.15 WHEN operator ยื่น issue ที่ผ่าน validation THE SYSTEM SHALL สร้าง issue ผ่าน Console API
- 6.16 WHERE issue อยู่ใน open state THE SYSTEM SHALL ให้ operator convert เป็น goal draft หรือ reject issue ได้
- 6.17 WHEN operator เริ่ม PR quality run ด้วย repository และ pull request ที่ถูกต้อง THE SYSTEM SHALL สร้าง run ผ่าน PR Quality API
- 6.18 WHERE PR quality run ยัง active THE SYSTEM SHALL ให้ operator cancel run ได้
- 6.19 WHERE PR quality run อนุญาต override THE SYSTEM SHALL รับ override ที่มี idempotency key, current head SHA, action, reason และ finding identifiers
- 6.20 WHERE run state อนุญาต guidance injection THE SYSTEM SHALL ให้ operator ส่ง guidance พร้อมระบุว่าใช้ทันทีหรือที่ task boundary ถัดไป
- 6.21 WHEN operator เริ่ม Chat session THE SYSTEM SHALL ใช้ selected project พร้อมรับ optional resume identifier และ fork choice
- 6.22 WHILE Chat session เชื่อมต่ออยู่ THE SYSTEM SHALL แสดง streamed transcript และให้ operator ส่ง non-empty user message
- 6.23 IF Chat connection ปิดหรือล้มเหลว THEN THE SYSTEM SHALL แสดง connection state โดยไม่ส่ง pending message หรือ tool decision ซ้ำอัตโนมัติ
- 6.24 WHEN operator เลือก PR quality run THE SYSTEM SHALL แสดง deterministic failures, judged findings, coverage, cost units, head status และ override history
- 6.25 WHEN operator ขอ MCP Authenticate จาก local loopback session THE SYSTEM SHALL เปิด Terminal intent ที่ prefill ไว้และรอ explicit Start action ก่อน spawn process

## REQ-7: Governance Control Center

**User Story:** ในฐานะ platform operator ฉันต้องการจัดการ settings และ governed resources จาก control center เดียว เพื่อเห็น scope, provenance และผลของการแก้ก่อนบันทึก

**Acceptance Criteria (EARS):**

- 7.1 THE SYSTEM SHALL แสดง governance views สำหรับ Settings, Permissions, Memory, MCP, Hooks, Subagents, Skills and Plugins และ System and Retention
- 7.2 WHEN operator เปิด resource ที่มีหลาย scope THE SYSTEM SHALL บังคับให้เลือก scope ที่ resource นั้นรองรับตาม governance scope matrix ก่อน edit
- 7.3 WHEN effective settings ถูกแสดง THE SYSTEM SHALL แสดง effective value ของแต่ละ field พร้อม winning scope และ provenance
- 7.4 WHEN editable resource ถูกโหลด THE SYSTEM SHALL เก็บ base hash ที่ server คืนมาคู่กับ editor state
- 7.5 WHEN operator ขอ save resource THE SYSTEM SHALL รัน client-side syntax และ required-field validation ที่ resource นั้นประกาศก่อนส่ง write request
- 7.6 WHEN operator ขอ Hooks install, Hooks uninstall หรือ retention prune THE SYSTEM SHALL แสดง server-generated diff หรือ candidate preview ก่อนรับ confirm action
- 7.7 WHEN server คืน confirmation token THE SYSTEM SHALL ผูก token กับ diff และ base hash ที่ preview แล้ว
- 7.8 IF server ปฏิเสธ write เพราะ base hash stale THEN THE SYSTEM SHALL เก็บ local draft, แสดง current server value แยกกัน และไม่แทน editor จน operator เลือก reload หรือ discard
- 7.9 WHERE selected scope เป็น managed read-only THE SYSTEM SHALL ไม่แสดง enabled save control
- 7.10 WHEN operator ใช้ permission simulator THE SYSTEM SHALL แสดง winning decision พร้อม provenance โดยไม่ติดตั้ง rule
- 7.11 WHEN operator ทดสอบ MCP connection THE SYSTEM SHALL ใช้ transport fields ที่ผ่าน validation และไม่ persist test credential ใน browser
- 7.12 WHEN operator แก้ project MCP config THE SYSTEM SHALL ใช้ project-scoped write contract พร้อม base hash
- 7.13 WHEN operator แก้ Hooks THE SYSTEM SHALL validate config ก่อนเริ่ม install หรือ uninstall confirmation flow
- 7.14 WHEN operator สร้างหรือแก้ Subagent THE SYSTEM SHALL validate Markdown frontmatter ก่อนส่ง write request
- 7.15 WHEN operator สร้างหรือแก้ Skill THE SYSTEM SHALL ส่ง content ผ่าน scope และ base-hash contract
- 7.16 WHEN operator เปลี่ยน plugin state THE SYSTEM SHALL ใช้ enabled-plugins endpoint โดยไม่ติดตั้ง dependency ใหม่
- 7.17 WHEN operator ขอ retention prune THE SYSTEM SHALL แสดง preview ก่อนรับ confirmation
- 7.18 WHEN governance write สำเร็จ THE SYSTEM SHALL แสดง apply timing ว่ามีผลทันทีหรือมีผลในการเริ่ม session ครั้งถัดไป
- 7.19 WHEN governed write ถึง server THE SYSTEM SHALL ให้ server รัน authoritative validation แม้ client validation ผ่านแล้ว
- 7.20 WHERE base-hash write ไม่ต้องใช้ confirmation token THE SYSTEM SHALL ส่ง write หลัง validation โดยไม่สร้าง preview flow เพิ่ม

Governance scope matrix:

| Resource | Supported scope and action |
|---|---|
| Settings | user, project และ local แก้ได้; managed อ่านอย่างเดียวเมื่อ server มีข้อมูล |
| Permissions | simulate จาก selected effective inputs โดยไม่ persist rule |
| Memory | user และ project แก้ได้ |
| MCP | user อ่านอย่างเดียว; project แก้และทดสอบ connection ได้ |
| Hooks | user, project และ local แก้ได้ผ่าน two-step confirmation |
| Subagents | user และ project สร้างหรือแก้ได้ |
| Skills | user และ project สร้างหรือแก้ได้ |
| Plugins | user, project และ local เปลี่ยน enabled state ได้ |
| System and Retention | user, project และ local แก้ retention setting ได้; prune เป็น host-wide operation |

## REQ-8: Safety, Trust Boundaries, and Resilience

**User Story:** ในฐานะ platform operator ฉันต้องการให้ UI รักษา auth, consent และ deterministic authority เดิม เพื่อไม่ให้ความสะดวกของ dashboard สร้างช่องทาง bypass

**Acceptance Criteria (EARS):**

- 8.1 WHILE auth gate ยังไม่ยืนยัน session THE SYSTEM SHALL ไม่ request protected Console data
- 8.2 IF protected request คืน 401 THEN THE SYSTEM SHALL แสดง Login โดยไม่ retry mutation เดิมอัตโนมัติ
- 8.3 WHEN protected data ถูกแสดง THE SYSTEM SHALL ใช้เฉพาะ response ที่ผ่าน server-side redaction
- 8.4 THE SYSTEM SHALL ไม่เขียน credential หรือ sensitive response ลง client log หรือ browser storage
- 8.5 WHEN UI โหลด page หรือ area THE SYSTEM SHALL ไม่รัน command, spawn process, ส่ง provider request หรือเริ่ม destructive action อัตโนมัติ
- 8.6 WHEN UI แสดง issue text, transcript, evidence หรือ provider output THE SYSTEM SHALL render content เป็น escaped plain text หรือ structured text โดยไม่ execute HTML, Markdown หรือ link
- 8.7 WHEN operator ส่ง governed mutation THE SYSTEM SHALL ให้ server เป็นผู้ตัดสิน permission, confirmation, idempotency และ stale-state checks
- 8.8 WHILE governed mutation กำลัง pending THE SYSTEM SHALL ปิด action ซ้ำที่มี action, target และ base hash หรือ idempotency key เดียวกัน
- 8.9 WHEN governed mutation สำเร็จ THE SYSTEM SHALL แสดง action name และ resulting state ที่ server ยืนยัน
- 8.10 IF governed mutation ล้มเหลว THEN THE SYSTEM SHALL แสดง reason ที่แก้ไขได้โดยไม่ล้าง unsaved input
- 8.11 IF area หนึ่ง render หรือ fetch ล้มเหลว THEN THE SYSTEM SHALL รักษา application shell และ area อื่นที่ไม่เกี่ยวข้องไว้
- 8.12 THE SYSTEM SHALL ไม่เพิ่ม state-mutating endpoint สำหรับ Core, AAL หรือ Adapters ใน feature นี้
- 8.13 WHERE remote policy ปิด capability THE SYSTEM SHALL แสดง capability เป็น disabled พร้อม policy reason
- 8.14 IF non-editable client projection ขัดกับ authoritative server state THEN THE SYSTEM SHALL ใช้ server state และแจ้ง operator ว่า view ถูก refresh
- 8.15 WHEN auth state เปลี่ยนเป็น unverified THE SYSTEM SHALL ปิด authenticated WebSocket และหยุด protected request ใหม่จนกว่าจะ login สำเร็จ
- 8.16 IF auth หมดอายุระหว่าง edit THEN THE SYSTEM SHALL เก็บ non-sensitive draft ไว้ใน memory ของ tab เพื่อคืนหลัง login สำเร็จ
- 8.17 IF auth หมดอายุขณะมี credential หรือ connection-test secret ใน client memory THEN THE SYSTEM SHALL ล้าง sensitive input นั้น
- 8.18 WHEN Terminal output ถูกแสดง THE SYSTEM SHALL ใช้ terminal renderer เดิมโดยไม่ inject HTML หรือเปิด link อัตโนมัติ
- 8.19 WHEN operator ขอ run kill, deploy rollback, Scheduler stop, issue reject, PR cancel, PR override, Hooks uninstall, retention prune หรือ resource delete THE SYSTEM SHALL แสดง confirmation ที่ระบุ action และ target ก่อนส่ง request
- 8.20 WHERE server contract ต้องใช้ preview หรือ confirmation token THE SYSTEM SHALL ส่ง exact token ที่ผูกกับ preview และ current base state เท่านั้น
- 8.21 WHEN selected area, project หรือ item เปลี่ยนก่อน read request เดิมเสร็จ THE SYSTEM SHALL abort หรือ ignore response ที่เป็นของ selection เดิม
- 8.22 WHILE active Run, Scheduler หรือ PR Quality view มองเห็นอยู่ THE SYSTEM SHALL poll โดยมี request ต่อ source ได้ไม่เกินหนึ่งรายการพร้อมกันและหยุด poll เมื่อ view ถูกซ่อนหรือ unmount
- 8.23 IF read request ล้มเหลว THEN THE SYSTEM SHALL แสดง retry control และ label ข้อมูลที่โหลดสำเร็จก่อนหน้าเป็น stale พร้อม last-read timestamp
- 8.24 THE SYSTEM SHALL ไม่ retry mutation อัตโนมัติ
- 8.25 WHEN API data มี authoritative sequence THE SYSTEM SHALL เรียงข้อมูลตาม sequence นั้นแทน browser arrival order
- 8.26 WHEN recorded data ถูกแสดง THE SYSTEM SHALL แสดง source timestamp แยกจาก client last-read timestamp
- 8.27 IF recorded data ไม่มี freshness metadata THEN THE SYSTEM SHALL label freshness เป็น unknown แทน live หรือ fresh
- 8.28 WHERE collection สามารถโตได้โดยไม่จำกัด THE SYSTEM SHALL fetch และ render 50 records แรกพร้อม load-more batches ที่มีขนาดไม่เกิน 100 records
- 8.29 WHEN event collection ถูก refresh THE SYSTEM SHALL ขอเฉพาะ events หลัง authoritative cursor หรือ sequence ล่าสุดที่รับแล้ว
- 8.30 WHEN non-live read-only area เปิด THE SYSTEM SHALL fetch หนึ่งครั้งและ fetch ใหม่เมื่อ operator refresh หรือเปลี่ยน selection

## REQ-9: Theme, Localization, and Visual System

**User Story:** ในฐานะ platform operator ฉันต้องการ control center ที่อ่านได้นานและใช้ได้ทั้งไทยกับอังกฤษ เพื่อจัดการระบบจากสภาพแสงและอุปกรณ์ต่างกัน

**Acceptance Criteria (EARS):**

- 9.1 IF browser ไม่มี valid stored theme preference THEN THE SYSTEM SHALL ใช้ dark theme เป็นค่าเริ่มต้น
- 9.2 WHEN operator สลับ theme THE SYSTEM SHALL เปลี่ยนระหว่าง dark และ light theme
- 9.3 WHEN operator เลือก theme THE SYSTEM SHALL persist preference สำหรับการเปิดครั้งถัดไป
- 9.4 WHEN application เริ่ม load THE SYSTEM SHALL apply stored theme ก่อน first paint
- 9.5 THE SYSTEM SHALL กำหนด color, typography, spacing, radius และ state styles ผ่าน centralized semantic tokens
- 9.6 THE SYSTEM SHALL มีข้อความภาษาไทยและอังกฤษสำหรับทุก UI-owned label, action, empty state และ known error summary
- 9.7 WHEN operator สลับภาษา THE SYSTEM SHALL เปลี่ยนข้อความโดยไม่เปลี่ยน selected area หรือ unsaved form state
- 9.8 WHEN operator เลือกภาษา THE SYSTEM SHALL persist locale preference สำหรับการเปิดครั้งถัดไป
- 9.9 WHILE locale เป็นภาษาไทย THE SYSTEM SHALL คง command, path, identifier, state enum และ provider identifier ในรูป technical เดิม
- 9.10 WHERE motion ถูกใช้ THE SYSTEM SHALL จำกัด motion ให้สื่อ state change หรือ panel transition
- 9.11 WHILE browser ขอ reduced motion THE SYSTEM SHALL ปิด non-essential animation และ transition
- 9.12 WHEN server-authored หรือ untrusted error detail ถูกแสดง THE SYSTEM SHALL แสดง localized summary คู่กับ original technical detail โดยไม่แปล technical value
- 9.13 IF browser ไม่มี valid stored locale preference THEN THE SYSTEM SHALL ใช้ภาษาไทยเมื่อ primary browser locale เริ่มด้วย `th` และใช้ภาษาอังกฤษในกรณีอื่น
- 9.14 IF browser storage อ่านหรือเขียนไม่ได้ THEN THE SYSTEM SHALL ให้ theme และ locale controls ทำงานแบบ session-only โดยไม่ทำให้ application shell ล้มเหลว

## REQ-10: Responsive Layout and Accessibility

**User Story:** ในฐานะ platform operator ฉันต้องการใช้ control center ด้วย keyboard และหน้าจอหลายขนาด เพื่อจัดการระบบได้จาก desktop, tablet และ phone

**Acceptance Criteria (EARS):**

- 10.1 WHILE viewport width ตั้งแต่ 1200 px ขึ้นไป THE SYSTEM SHALL แสดง navigation, main workspace และ context inspector พร้อมกันเมื่อ inspector มีข้อมูล
- 10.2 WHILE viewport width ตั้งแต่ 768 px ถึง 1199 px THE SYSTEM SHALL แสดง main workspace หนึ่ง region และเปิด navigation หรือ inspector ผ่าน explicit drawer control
- 10.3 WHILE viewport width ต่ำกว่า 768 px THE SYSTEM SHALL แสดง main workspace หนึ่ง column และเปิด navigation หรือ inspector เป็น modal overlay
- 10.4 WHILE viewport width เท่ากับ 375, 768 หรือ 1440 px THE SYSTEM SHALL ไม่สร้าง horizontal overflow ที่ระดับ document
- 10.5 WHERE table หรือ terminal กว้างกว่า content region THE SYSTEM SHALL จำกัด horizontal scroll ไว้ใน component นั้น
- 10.6 THE SYSTEM SHALL ให้ทุก interactive control เข้าถึงและใช้งานได้ด้วย keyboard
- 10.7 THE SYSTEM SHALL แสดง focus indicator ที่มองเห็นได้สำหรับทุก interactive control
- 10.8 THE SYSTEM SHALL ใช้ semantic landmarks และ heading order ที่ไม่ข้ามระดับ
- 10.9 THE SYSTEM SHALL ให้ accessible name แก่ทุก button, input, navigation control และ status indicator
- 10.10 THE SYSTEM SHALL ให้ touch target ของ primary interactive controls มีขนาดอย่างน้อย 44 x 44 CSS px
- 10.11 THE SYSTEM SHALL รักษา contrast ratio ของ normal text อย่างน้อย 4.5:1
- 10.12 THE SYSTEM SHALL รักษา contrast ratio ของ large text และ non-text interactive boundaries อย่างน้อย 3:1
- 10.13 WHEN modal หรือ overlay เปิด THE SYSTEM SHALL ย้าย focus เข้า container, จำกัด focus ภายใน และคืน focus ให้ trigger เมื่อปิด
- 10.14 WHEN loading, success หรือ error state เปลี่ยนโดยไม่มี navigation THE SYSTEM SHALL ประกาศ state ผ่าน live region ที่เหมาะสม
- 10.15 IF content มี path หรือ identifier ยาวเกิน container THEN THE SYSTEM SHALL wrap หรือ truncate โดยยังมีวิธีอ่านค่าเต็มด้วย keyboard

## REQ-11: Compatibility and Delivery Constraints

**User Story:** ในฐานะ maintainer ฉันต้องการ redesign ที่ใช้ stack เดิมและไม่เปลี่ยน runtime semantics เพื่อให้ review และ regression surface เล็กที่สุด

**Acceptance Criteria (EARS):**

- 11.1 THE SYSTEM SHALL รักษา existing request fields, response fields, status-code semantics และ mutation behavior ของ Console endpoints แบบ backward-compatible
- 11.2 WHERE Core, AAL หรือ Adapter status ที่ต้องแสดงยังไม่มี Console endpoint THE SYSTEM SHALL เพิ่มเฉพาะ additive read-only endpoint
- 11.3 THE SYSTEM SHALL รักษา execution, routing, adapter transport และ deterministic decision behavior ที่มีอยู่
- 11.4 THE SYSTEM SHALL ใช้ dependencies ที่มีอยู่ใน `console/web/package.json` และ browser-native features เท่านั้น
- 11.5 WHEN package manifests ถูกเปรียบเทียบก่อนและหลัง feature THE SYSTEM SHALL ไม่มี runtime หรือ development dependency ใหม่จากงานนี้
- 11.6 WHEN UI ต้อง transform, validate หรือ derive display state แบบ non-trivial THE SYSTEM SHALL วาง logic เป็น pure function แยกจาก React presentation
- 11.7 WHEN pure display logic ถูกเพิ่มหรือเปลี่ยน THE SYSTEM SHALL มี co-located test ที่ assert observable behavior
- 11.8 WHEN implementation เสร็จ THE SYSTEM SHALL ผ่าน Console Web typecheck, tests และ production build
- 11.9 WHEN implementation เสร็จ THE SYSTEM SHALL ผ่าน browser verification บน latest stable Chromium ที่ viewport width 375, 768 และ 1440 px
- 11.10 THE SYSTEM SHALL ไม่แก้ `scripts/` หรือ `spikes/` เป็นส่วนหนึ่งของ feature นี้
- 11.11 WHEN Core, AAL หรือ Adapter projection ถูกขอ THE SYSTEM SHALL ให้ Console backend อ่าน authoritative config, event, evidence และ calibration stores แล้วคืน redacted normalized projection พร้อม provenance
- 11.12 THE SYSTEM SHALL ไม่ให้ browser อ่าน raw host files หรือ authoritative stores โดยตรง

## Edge Cases & Open Questions

| Case | Required behavior |
|---|---|
| ไม่มี project, run, adapter record หรือ conformance record | แสดง empty หรือ unknown state ตาม REQ ที่เป็นเจ้าของข้อมูล ห้ามแสดง healthy จากการไม่มีข้อมูล |
| API บาง area unavailable | application shell และ area อื่นยังใช้ได้ |
| remote session | Terminal และ local-only action ถูก disable พร้อมเหตุผล |
| auth หมดอายุระหว่าง form edit | กลับ Login โดยไม่ retry mutation และไม่ส่งข้อมูลไปปลายทางอื่น |
| base hash หรือ PR head stale | คง local input, แสดง authoritative state แยกกัน และรอ explicit reload หรือ discard |
| path, command หรือ identifier ยาว | ไม่ทำ document overflow และยังอ่านค่าเต็มด้วย keyboard ได้ |
| untrusted transcript หรือ evidence มี markup | แสดงเป็น data โดยไม่เพิ่ม execution authority |
| recorded health เก่า | แสดง timestamp และห้ามเรียกว่า live status |
| adapter มี record บาง dimension เท่านั้น | แสดง status แยก dimension และใช้ unknown เฉพาะ dimension ที่ไม่มี valid record |
| selection เปลี่ยนระหว่าง read request | abort หรือ ignore response ของ selection เดิม |
| auth หมดอายุระหว่าง editor เปิด | เก็บเฉพาะ non-sensitive draft ใน memory, ล้าง credential และไม่ retry mutation |
| browser storage ใช้ไม่ได้ | theme และ locale ทำงานแบบ session-only |
| collection ใหญ่ | โหลด 50 records แรกและ load more ครั้งละไม่เกิน 100 records |
| MCP Authenticate deep link ถูกเปิด | แสดง prefilled intent และรอ explicit Start ก่อน spawn process |
| destructive action ถูกเลือก | แสดง action และ target เพื่อรับ confirmation ก่อน request |

Open questions: ไม่มี ผู้ใช้ยืนยันค่าแนะนำจาก requirements analysis ทั้งหมดเมื่อ 2026-08-12

Analysis anchor: repository HEAD `c808ef4`. ไฟล์นี้ยัง untracked ตอน audit จึงไม่มี
file-history commit; exact pre-amendment content ใช้ SHA-256
`0d73d5a6a100c5f6182434055e49bbc028ba18f2f84785d923bf6bceb6a8222a` เพิ่มเป็น anchor.

| Finding | Category | Decision | Rationale | Anchor |
|---|---|---|---|---|
| AN-01 | Logical inconsistency | Accepted: แยก adapter status ตาม dimension | กัน health record กลบ conformance ที่หายหรือ invalid | `c808ef4` |
| AN-02 | Logical inconsistency | Accepted: แยก server value จาก local draft | รักษา authoritative state โดยไม่ทำ unsaved work หาย | `c808ef4` |
| AN-03 | Ambiguity | Accepted: Core run หมายถึง autonomous loop run | กัน run taxonomy ชนกับ PR Quality | `c808ef4` |
| AN-04 | Ambiguity | Accepted: ใช้ authoritative sequence/source timestamp | กัน browser arrival order สร้าง current state ผิด | `c808ef4` |
| AN-05 | Ambiguity | Accepted: read-only ห้าม domain mutation | navigation, filter, copy และ refresh ไม่เปลี่ยน source of truth | `c808ef4` |
| AN-06 | Ambiguity | Accepted: ระบุ dashboard destination map | ทำ card navigation ทดสอบได้ | `c808ef4` |
| AN-07 | Ambiguity | Accepted: เพิ่ม governance scope matrix | กัน UI เสนอ scope/action ที่ endpoint ไม่รองรับ | `c808ef4` |
| AN-08 | Ambiguity | Accepted: client validation + authoritative server validation | คง two-step flow เฉพาะ contract ที่ต้องใช้ | `c808ef4` |
| AN-09 | Conflicting constraints | Accepted: แปล UI-owned summary แต่คง technical detail | รักษา localization และ API compatibility พร้อมกัน | `c808ef4` |
| AN-10 | Conflicting constraints | Accepted: เก็บ non-sensitive draft ใน memory | รองรับ re-auth โดยไม่ persist credential หรือ replay mutation | `c808ef4` |
| AN-11 | Gap | Accepted: preserve omitted Console capabilities | กัน redesign ทำ Loop, Chat, PR Quality หรือ MCP flow หาย | `c808ef4` |
| AN-12 | Gap | Accepted: bounded polling, retry และ stale-response guard | กัน duplicate request และ selection race | `c808ef4` |
| AN-13 | Gap | Accepted: escaped plain/structured text | ทำ untrusted rendering testable โดยไม่เพิ่ม sanitizer dependency | `c808ef4` |
| AN-14 | Gap | Accepted: confirm destructive/high-impact action | ลด accidental mutation และใช้ server token เมื่อมี | `c808ef4` |
| AN-15 | Gap | Accepted: responsive ranges | ครอบทุก width พร้อมคง acceptance viewports เดิม | `c808ef4` |
| AN-16 | Gap | Accepted: URL allowlist + browser history behavior | กัน sensitive state รั่วและกำหนด invalid-link behavior | `c808ef4` |
| AN-17 | Gap | Accepted: invalid preference/storage fallback | กัน initialization failure ทำ shell ล้ม | `c808ef4` |
| AN-18 | Gap | Accepted: page 50, batch สูงสุด 100 | กัน unbounded fetch/render โดยไม่เพิ่ม virtualization dependency | `c808ef4` |
| AN-19 | Unstated assumption | Accepted: backend owns authoritative projection | รักษา trust boundary และ server-side redaction | `c808ef4` |
| AN-20 | Unstated assumption | Accepted: latest stable Chromium | ทำ browser verification target ชัดโดยไม่ขยาย browser matrix | `c808ef4` |
