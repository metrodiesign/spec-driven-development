# SDD framework distribution

เครื่องมือนี้ติดตั้งและตรวจ managed SDD payload จาก local Git revision โดยไม่แตะ project specs, context หรือ harness config ของ consumer

## Commands

กำหนด `SDD_FRAMEWORK_REF` เป็น full commit SHA เดียวที่ทุก consumer ใช้ และ commit นั้นต้องมีอยู่ใน local source Git history ห้ามใช้ branch หรือ tag

```sh
SDD_FRAMEWORK_REF=0123456789abcdef0123456789abcdef01234567
node scripts/sdd-framework.mjs install --source /path/to/framework --ref "$SDD_FRAMEWORK_REF" --target /path/to/project
node scripts/sdd-framework.mjs adopt --source /path/to/framework --ref "$SDD_FRAMEWORK_REF" --target /path/to/project
node scripts/sdd-framework.mjs update --source /path/to/framework --ref "$SDD_FRAMEWORK_REF" --target /path/to/project
node scripts/sdd-framework.mjs check --source /path/to/framework --ref "$SDD_FRAMEWORK_REF" --target /path/to/project
node scripts/sdd-framework.mjs validate --source /path/to/framework --ref "$SDD_FRAMEWORK_REF"

# สอง consumer ใช้ revision เดียวกัน
node scripts/sdd-framework.mjs check --source /path/to/framework --ref "$SDD_FRAMEWORK_REF" --target /path/to/consumer-a
node scripts/sdd-framework.mjs check --source /path/to/framework --ref "$SDD_FRAMEWORK_REF" --target /path/to/consumer-b
```

เมื่อ target มี lock แล้ว `install`, `update` และ `check` จะ authenticate old lock กับ `lock.sourceRevision` ซึ่งต้องยังมีอยู่ใน local Git history ของ source เดียวกัน CLI ไม่ fetch commit ที่ขาดหรือใช้ network และจะ exit nonzero โดยไม่เปลี่ยน consumer หาก authenticate ไม่ได้

Consumer ตรวจ local drift แบบ offline ด้วย CLI ที่ติดตั้งใน payload

```sh
node .ai/bin/sdd-framework.mjs status --target "$PWD"
```

## CI example

```yaml
- name: Check SDD framework
  env:
    SDD_FRAMEWORK_REF: 0123456789abcdef0123456789abcdef01234567
  run: node /path/to/framework/scripts/sdd-framework.mjs check --source /path/to/framework --ref "$SDD_FRAMEWORK_REF" --target "$GITHUB_WORKSPACE"
```

CI ต้องจัด source revision ให้พร้อมในเครื่อง เครื่องมือไม่ fetch network เอง ตัว CLI ใช้ Node.js และ Git ส่วน payload gate บางตัวใช้ Bash กับ Python ตามไฟล์ที่เรียก

## Consumer activation

ไฟล์ root front door และ harness settings เป็น consumer-owned ให้เพิ่มคำสั่งอ่าน `.ai/shared/TASK_PROTOCOL.md` ตาม convention ของ project และตั้ง Git hooks แยกต่างหากเมื่อ project ต้องการ

```sh
git config core.hooksPath .githooks
```

## Boundary

- `status` ตรวจ target set กับสำเนา manifest ที่ติดตั้งและตรวจ local drift แต่ไม่พิสูจน์ provenance ของ lock หรือป้องกันการแก้ lock กับ manifest พร้อมกันแบบ offline; ใช้ `check --source --ref` เมื่อต้องการยืนยันกับ trusted source revision
- Project specs, context, architecture, coding standards, lessons, package metadata, CI และ harness config ไม่อยู่ใน manifest
- `spec-retro`, GitHub sync, cost accounting และ pane loop เป็น optional capability
- ไม่มี config merge, registry, signature, network fetch หรือ fleet manager
