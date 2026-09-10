#!/usr/bin/env python3
"""ตัวตรวจ requirements traceability (deterministic) สำหรับ spec ใต้ .ai/specs/<feature>/.

ตรวจ 3 เรื่อง:
1. coverage — เกณฑ์ (criterion) ทุกข้อใน requirements.md (บรรทัด `- N.M ...` ใต้หัวข้อ
   `## REQ-N:`) ต้องถูกอ้างถึงทั้งใน design.md (เฉพาะ section `## Requirement Traceability`)
   และใน tasks.md (เฉพาะบรรทัด `Satisfies:`). รูปแบบอ้างอิงที่ขยายให้:
     - id เปล่า:        15.1, 15.3
     - ช่วง dash:       17.1-17.4  -> 17.1, 17.2, 17.3, 17.4
     - prefix:          REQ-1.2
     - ทั้ง REQ:        REQ-1 / REQ-1 (all criteria) -> ทุกเกณฑ์ของ REQ-1
   วงเล็บกำกับ เช่น `(partial)` ไม่ทำให้ parse พัง.
2. EARS lint — ทุกเกณฑ์ต้องตรงรูปประโยคภาษาไทย `ระบบต้อง ...` หรือรูปมีเงื่อนไข
   `เมื่อ` / `ขณะที่` / `ในกรณีที่` / `หาก` หรือรูปภาษาอังกฤษเดิม
   (ดูข้อความเต็มของเกณฑ์รวมบรรทัดต่อเนื่องที่ indent).
3. sliceability — spec ที่ยังมี unchecked task ต้องมี traceability table ซึ่งมี column
   `REQ`/`Satisfies` และ `Section`; ค่า `Section` ต้องตรงกับ real `##` heading แบบ exact match.

requirements.md ที่ไม่มีหัวข้อ `## REQ-N:` เลย (เช่น bugfix spec) -> ข้ามการตรวจ, exit 0.
เกณฑ์ตกหล่น/EARS ไม่ผ่าน -> รายงานเป็นภาษาไทยแล้ว exit 1; ครบหมด -> 1 บรรทัด OK, exit 0.
"""
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

REQ_HEADING_RE = re.compile(r"^## REQ-(\d+):")
CRITERION_RE = re.compile(r"^- (\d+)\.(\d+) ")
# บรรทัดที่ "เกือบ" เป็นเกณฑ์ (เช่น `- 2.3. text`) — ใช้เตือนกัน criterion หายเงียบ
NEAR_MISS_RE = re.compile(r"^- \d+\.\d+")
# อ้างอิงเกณฑ์: ลองช่วง dash ก่อน แล้วค่อย id เดี่ยว แล้วค่อยทั้ง REQ (ลำดับสำคัญ)
# guard ขอบ token: ห้ามมีตัวอักษร/ตัวเลข/จุด ติดหน้า และห้ามมีตัวอักษร/ตัวเลข ติดหลัง
# (กัน prose เช่น "v2.2" / "2.2s" นับเป็นการอ้างเกณฑ์ 2.2) — `,` `.` `-` ตามหลังยังผ่าน
REF_RE = re.compile(
    r"(?<![A-Za-z0-9_.])"
    r"(?:"
    r"(?:REQ-)?(?P<a1>\d+)\.(?P<b1>\d+)\s*[-–]\s*(?:REQ-)?(?P<a2>\d+)\.(?P<b2>\d+)"
    r"|(?:REQ-)?(?P<a>\d+)\.(?P<b>\d+)"
    r"|REQ-(?P<whole>\d+)(?!\.\d)"
    r")"
    r"(?![A-Za-z0-9])"
)
EARS_KEYWORD_RE = re.compile(r"(?<![A-Za-z])(?:WHEN|WHILE|WHERE)(?![A-Za-z])")
EARS_IF_RE = re.compile(r"(?<![A-Za-z])IF(?![A-Za-z])")
EARS_THEN_RE = re.compile(r"(?<![A-Za-z])THEN(?![A-Za-z])")
THAI_EARS_RE = re.compile(
    r"^(?:"
    r"ระบบต้อง\s*\S.*"
    r"|(?:เมื่อ|ขณะที่|ในกรณีที่|หาก)\s*\S.*?\s+ระบบต้อง\s*\S.*"
    r")$"
)

ROOT_TASK_RE = re.compile(r"^- \[([ xX])\]\s*(\d+)\.\s+(.+?)\s*$")
CHILD_TASK_RE = re.compile(r"^  - \[([ xX])\]\s*(\d+)\.(\d+)\s+(.+?)\s*$")
CHECKBOX_RE = re.compile(r"^[ \t]*- \[[ xX]\]")
META_LINE_RE = re.compile(r"^(?:-\s+)?(Satisfies|Verify|Depends on|Batch):\s*(.*)$")
META_TOKEN_RE = re.compile(r"(?:^|\s)(Satisfies|Verify|Depends on|Batch):")
EVIDENCE_LINE_RE = re.compile(r"^(?:-\s+)?Evidence:\s*(.*)$", re.IGNORECASE)
FENCE_RE = re.compile(r"^[ \t]*(`{3,}|~{3,})")


class TaskHierarchyError(ValueError):
    """tasks.md ผิด grammar hierarchy; ข้อความระบุบรรทัดและ task ID."""


@dataclass
class TaskNode:
    ordinal: str
    line: int
    checked: bool
    headline: str
    satisfies: list[str] = field(default_factory=list)
    verify: str = ""
    depends: list[str] = field(default_factory=list)
    batch: str = ""
    evidence_line: int | None = None


@dataclass
class TaskRoot(TaskNode):
    children: list[TaskNode] = field(default_factory=list)


def _metadata_values(text: str):
    markers = list(META_TOKEN_RE.finditer(text))
    values = []
    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(text)
        values.append((marker.group(1), text[marker.end():end].strip()))
    return values


def _metadata(line: str):
    """คืนข้อความ metadata บน owner-detail line; `- ` หน้า marker เป็น optional."""
    stripped = line.lstrip(" ")
    if META_LINE_RE.match(stripped) is None:
        return None
    return stripped[2:] if stripped.startswith("- ") else stripped


def _headline_metadata(text: str):
    """แยก headline จาก legacy metadata ที่อยู่บนบรรทัด checkbox เดียวกัน."""
    marker = META_TOKEN_RE.search(text)
    if marker is None:
        return text, None
    return text[:marker.start()].strip(), text[marker.start():].strip()


def _apply_metadata(owner: TaskNode, values):
    for marker, value in values:
        if marker == "Satisfies":
            owner.satisfies.append(value)
        elif marker == "Verify" and not owner.verify:
            owner.verify = value
        elif marker == "Depends on":
            owner.depends.append(value)
        elif marker == "Batch" and not owner.batch:
            owner.batch = value


def parse_task_hierarchy(tasks_text: str) -> list[TaskRoot]:
    """Parse root `N.` และ child `N.M` แบบสองระดับ พร้อม validate fail-closed.

    Blank lines ไม่ปิด root. Fenced blocks และเนื้อหาใต้ Evidence เป็น opaque.
    Root metadata อยู่ indent 2; child metadataอยู่ indent 4. Flat legacy ที่ไม่มี
    children ยังรับ continuation indentation เดิมได้.
    """
    roots: list[TaskRoot] = []
    root_ids: set[str] = set()
    child_ids: set[str] = set()
    current_root: TaskRoot | None = None
    current_child: TaskNode | None = None
    fence_char = ""
    fence_length = 0
    evidence_indent: int | None = None
    pending_owner: TaskNode | None = None
    pending_metadata: list[str] = []
    pending_indent = 0

    def flush_metadata():
        nonlocal pending_owner, pending_metadata, pending_indent
        if pending_owner is not None:
            _apply_metadata(pending_owner, _metadata_values(" ".join(pending_metadata)))
        pending_owner = None
        pending_metadata = []
        pending_indent = 0

    def add_metadata(owner: TaskNode, text: str, indent: int):
        nonlocal pending_owner, pending_indent
        if pending_owner is not owner:
            flush_metadata()
            pending_owner = owner
            pending_indent = indent
        pending_metadata.append(text.strip())

    for line_no, line in enumerate(tasks_text.splitlines(), start=1):
        stripped = line.lstrip(" ")
        indent = len(line) - len(stripped)

        if evidence_indent is not None:
            evidence_bullet = (indent == evidence_indent and stripped.startswith("- ")
                               and not CHECKBOX_RE.match(line))
            if not stripped or indent > evidence_indent or evidence_bullet:
                continue
            evidence_indent = None

        fence_match = FENCE_RE.match(line)
        if fence_match:
            flush_metadata()
            delimiter = fence_match.group(1)
            if not fence_char:
                fence_char, fence_length = delimiter[0], len(delimiter)
            elif delimiter[0] == fence_char and len(delimiter) >= fence_length:
                fence_char, fence_length = "", 0
            continue
        if fence_char:
            continue

        root_match = ROOT_TASK_RE.match(line)
        if root_match:
            flush_metadata()
            ordinal = root_match.group(2)
            if len(ordinal) > 1 and ordinal.startswith("0"):
                raise TaskHierarchyError(f"line {line_no}: root task ID {ordinal} has a leading zero")
            if ordinal in root_ids:
                raise TaskHierarchyError(f"line {line_no}: duplicate root task ID {ordinal}")
            headline, metadata = _headline_metadata(root_match.group(3))
            current_root = TaskRoot(
                ordinal=ordinal,
                line=line_no,
                checked=root_match.group(1).lower() == "x",
                headline=headline,
            )
            roots.append(current_root)
            root_ids.add(ordinal)
            current_child = None
            if metadata is not None:
                add_metadata(current_root, metadata, 0)
            continue

        child_match = CHILD_TASK_RE.match(line)
        if child_match:
            flush_metadata()
            ordinal = f"{child_match.group(2)}.{child_match.group(3)}"
            if ((len(child_match.group(2)) > 1 and child_match.group(2).startswith("0")) or
                    (len(child_match.group(3)) > 1 and child_match.group(3).startswith("0"))):
                raise TaskHierarchyError(f"line {line_no}: child task ID {ordinal} has a leading zero")
            if current_root is None:
                raise TaskHierarchyError(f"line {line_no}: orphan child task ID {ordinal}")
            if child_match.group(2) != current_root.ordinal:
                raise TaskHierarchyError(
                    f"line {line_no}: child task ID {ordinal} does not belong to "
                    f"root {current_root.ordinal}")
            if ordinal in child_ids:
                raise TaskHierarchyError(f"line {line_no}: duplicate child task ID {ordinal}")
            if current_root.evidence_line is not None:
                raise TaskHierarchyError(
                    f"line {line_no}: child task ID {ordinal} appears after root Evidence")
            headline, metadata = _headline_metadata(child_match.group(4))
            current_child = TaskNode(
                ordinal=ordinal,
                line=line_no,
                checked=child_match.group(1).lower() == "x",
                headline=headline,
            )
            current_root.children.append(current_child)
            child_ids.add(ordinal)
            if metadata is not None:
                add_metadata(current_child, metadata, 4)
            continue

        if CHECKBOX_RE.match(line):
            flush_metadata()
            tail = stripped.split("]", 1)[1].strip() if "]" in stripped else ""
            token = tail.split(maxsplit=1)[0] if tail else "<missing>"
            reason = "task nesting deeper than N.M" if indent > 2 or token.count(".") > 1 \
                else "invalid task ID or indentation"
            raise TaskHierarchyError(f"line {line_no}: {reason}: {token}")

        evidence = EVIDENCE_LINE_RE.match(stripped)
        if evidence and current_root is not None:
            flush_metadata()
            owner: TaskNode | None = None
            if current_root.children:
                if indent == 2:
                    owner = current_root
                elif indent == 4 and current_child is not None:
                    owner = current_child
            elif indent > 0:
                owner = current_root
            if owner is not None:
                owner.evidence_line = line_no
                evidence_indent = indent
                continue

        if current_root is None or not stripped:
            flush_metadata()
            continue

        owner: TaskNode | None = None
        if current_root.children:
            if indent == 2:
                owner = current_root
            elif indent == 4 and current_child is not None:
                owner = current_child
        elif indent > 0:
            owner = current_root
        metadata = _metadata(line)
        continuation_indent = 1 if pending_indent == 0 else pending_indent
        if (metadata is None and pending_owner is not None and indent >= continuation_indent
                and not stripped.startswith("- ")):
            pending_metadata.append(stripped)
            continue
        if owner is None:
            flush_metadata()
            continue
        if metadata is not None:
            add_metadata(owner, metadata, indent)
            continue
        flush_metadata()

    flush_metadata()
    if fence_char:
        raise TaskHierarchyError("line EOF: unclosed fenced block in tasks.md")
    return roots


def root_task_ids(tasks_text: str, checked: bool | None = None) -> list[str]:
    """คืน root execution IDs ตามลำดับ; optional filter ตาม checkbox state."""
    return [
        root.ordinal for root in parse_task_hierarchy(tasks_text)
        if checked is None or root.checked == checked
    ]


def root_task_block(tasks_text: str, ordinal: str) -> str:
    """คืน root subtree แบบ verbatim โดยใช้ parser line boundaries."""
    lines = tasks_text.splitlines()
    roots = parse_task_hierarchy(tasks_text)
    for index, root in enumerate(roots):
        if root.ordinal == ordinal:
            end = roots[index + 1].line - 1 if index + 1 < len(roots) else len(lines)
            return "\n".join(lines[root.line - 1:end])
    return ""


def task_checkbox_lines(tasks_text: str, checked: bool | None = None) -> list[tuple[int, str]]:
    """คืน checkbox จริงของ root/child พร้อมเลขบรรทัด; fence/Evidence ถูก parser กรองแล้ว."""
    lines = tasks_text.splitlines()
    nodes = [node for root in parse_task_hierarchy(tasks_text) for node in [root, *root.children]]
    return [
        (node.line, lines[node.line - 1]) for node in nodes
        if checked is None or node.checked == checked
    ]


def root_task_done(tasks_text: str, ordinal: str) -> bool:
    """จริงเมื่อพบ root ที่ปิดแล้วและ children ทุกตัวปิดแล้ว."""
    return any(
        root.ordinal == ordinal and root.checked and all(child.checked for child in root.children)
        for root in parse_task_hierarchy(tasks_text)
    )


def parse_requirements(text):
    """คืน (criteria, has_headings).

    criteria = list ของ (major:int, minor:int, full_text:str) ตามลำดับในไฟล์ —
    เฉพาะบรรทัด `- N.M ` ที่อยู่ใต้หัวข้อ `## REQ-N:`; full_text รวมบรรทัดต่อเนื่อง
    ที่ indent (join เป็นช่องว่างเดียว) เพื่อให้ lint เห็นคีย์เวิร์ดที่ถูกตัดขึ้นบรรทัดใหม่.
    """
    criteria = []
    has_headings = False
    in_req_section = False
    current = None  # (major, minor, [lines])

    def flush():
        nonlocal current
        if current is not None:
            major, minor, lines = current
            criteria.append((major, minor, re.sub(r"\s+", " ", " ".join(lines)).strip()))
            current = None

    for line in text.splitlines():
        if line.startswith("#"):
            flush()
            if REQ_HEADING_RE.match(line):
                in_req_section = True
                has_headings = True
            elif not line.startswith("###"):
                in_req_section = False  # หัวข้อระดับ 1-2 ที่ไม่ใช่ REQ = จบ section
            # หัวข้อระดับ 3+ (###) เป็นหัวข้อย่อยใน REQ — คง section เดิม
            continue
        m = CRITERION_RE.match(line)
        if m and in_req_section:
            flush()
            current = (int(m.group(1)), int(m.group(2)), [line[m.end():]])
            continue
        if in_req_section and NEAR_MISS_RE.match(line):
            print("คำเตือน: บรรทัดคล้ายเกณฑ์แต่ไม่ตรงรูปแบบ '- N.M <ข้อความ>' "
                  f"(จะไม่ถูกนับ): {line.strip()}", file=sys.stderr)
        if current is not None:
            if line.strip() and line.startswith(" "):
                current[2].append(line.strip())
            else:
                flush()  # บรรทัดว่าง / bullet อื่น / ข้อความชิดซ้าย = จบเกณฑ์
    flush()
    return criteria, has_headings


def expand_refs(segment, criteria_by_req):
    """ขยายข้อความอ้างอิงเป็น set ของ (major, minor).

    criteria_by_req = dict major -> set(minor) ของเกณฑ์จริง (ใช้ขยายรูปทั้ง REQ).
    """
    covered = set()
    for m in REF_RE.finditer(segment):
        if m.group("a1"):  # ช่วง dash เช่น 17.1-17.4
            a1, b1, a2, b2 = (int(m.group(g)) for g in ("a1", "b1", "a2", "b2"))
            if a1 == a2:
                covered.update((a1, minor) for minor in range(min(b1, b2), max(b1, b2) + 1))
            else:  # ช่วงข้าม REQ ไม่นิยาม — นับเฉพาะปลายทั้งสอง
                covered.update({(a1, b1), (a2, b2)})
        elif m.group("a"):  # id เดี่ยว (มี/ไม่มี prefix REQ-)
            covered.add((int(m.group("a")), int(m.group("b"))))
        else:  # ทั้ง REQ เช่น REQ-1
            major = int(m.group("whole"))
            covered.update((major, minor) for minor in criteria_by_req.get(major, ()))
    return covered


def design_traceability_text(design_text):
    """คืนเนื้อหา `## Requirement Traceability` นอก fenced code block หรือ None."""
    lines = []
    started = False
    fenced = False
    for line in design_text.splitlines():
        if line.startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        if not started:
            if line.strip() == "## Requirement Traceability":
                started = True
            continue
        if line.startswith("## "):
            break
        lines.append(line)
    return "\n".join(lines) if started else None


def table_cells(row):
    """คืน cell ที่ trim แล้วของ GFM row; รองรับ row ที่ไม่มี trailing pipe."""
    cells = row.split("|")[1:]
    if row.rstrip().endswith("|"):
        cells = cells[:-1]
    return [cell.strip() for cell in cells]


def traceability_slice_problems(trace, design_text, criteria_by_req):
    """คืนปัญหา contract ที่ทำให้ `spec-slice` resolve design section ไม่ได้."""
    table_rows = [line for line in trace.splitlines() if line.startswith("|")]
    if not table_rows:
        return ["ไม่พบ table header ที่มี column 'REQ' หรือ 'Satisfies' และ 'Section'"]

    headers = table_cells(table_rows[0])
    req_col = headers.index("REQ") if "REQ" in headers else (
        headers.index("Satisfies") if "Satisfies" in headers else None)
    section_col = headers.index("Section") if "Section" in headers else None
    found = []
    if req_col is None:
        found.append("ไม่มี column 'REQ' หรือ 'Satisfies' ที่ spec-slice รองรับ")
    if section_col is None:
        found.append("Section column หาย")
    if found:
        return found

    headings = set()
    fenced = False
    for line in design_text.splitlines():
        if line.startswith("```"):
            fenced = not fenced
            continue
        if not fenced and line.startswith("## "):
            headings.add(line[3:].strip())

    column_covered = set()
    for row_number, row in enumerate(table_rows[1:], start=2):
        if "---" in row:
            continue
        cells = table_cells(row)
        req_value = cells[req_col] if req_col < len(cells) else ""
        if not REF_RE.search(req_value):
            continue
        column_covered.update(expand_refs(req_value, criteria_by_req))
        section = cells[section_col] if section_col < len(cells) else ""
        if not section:
            found.append(f"row {row_number} ({req_value}): Section ว่าง")
        elif section not in headings:
            found.append(f"row {row_number} ({req_value}): '{section}' ไม่มี ## heading "
                         "ที่ตรงกันแบบ exact match")
    expected = {(major, minor) for major, minors in criteria_by_req.items() for minor in minors}
    missing = sorted(expected - column_covered)
    if missing:
        found.append("REQ/Satisfies column ไม่ครอบ criterion: "
                     + ", ".join(f"{major}.{minor}" for major, minor in missing))
    return found


def iter_task_blocks(tasks_text):
    """Compatibility wrapper: yield root execution blocks จาก structured parser."""
    for root in parse_task_hierarchy(tasks_text):
        markers = [f"- [{'x' if root.checked else ' '}] {root.ordinal}. {root.headline}"]
        markers.extend(f"Satisfies: {value}" for value in root.satisfies)
        markers.extend(f"Satisfies: {value}" for child in root.children
                       for value in child.satisfies)
        if root.verify:
            markers.append(f"Verify: {root.verify}")
        markers.extend(f"Depends on: {value}" for value in root.depends)
        if root.batch:
            markers.append(f"Batch: {root.batch}")
        yield " ".join(markers)


def satisfies_text(tasks_text):
    """รวม Satisfies ของ root และ children เป็น coverage ของ root execution units."""
    return "\n".join(
        value
        for root in parse_task_hierarchy(tasks_text)
        for value in root.satisfies + [ref for child in root.children for ref in child.satisfies]
    )


def ears_ok(text):
    if "THE SYSTEM SHALL" in text:
        return True
    if EARS_KEYWORD_RE.search(text):
        return True
    if EARS_IF_RE.search(text) and EARS_THEN_RE.search(text):
        return True
    return bool(THAI_EARS_RE.fullmatch(text.strip()))


def run(feature, specs_dir):
    """ตรวจ feature เดียว; print ผลแล้วคืน exit code."""
    feature_dir = specs_dir / feature
    if not feature_dir.is_dir():
        existing = ", ".join(sorted(p.name for p in specs_dir.iterdir() if p.is_dir())) \
            if specs_dir.is_dir() else "-"
        print(f"ไม่พบ feature '{feature}' ใต้ {specs_dir} (ที่มี: {existing})", file=sys.stderr)
        print("ใช้: scripts/spec-trace.sh <feature>", file=sys.stderr)
        return 1

    req_path = feature_dir / "requirements.md"
    if not req_path.is_file():
        if (feature_dir / "bugfix.md").is_file():
            print(f"'{feature}' เป็น bugfix spec (มี bugfix.md ไม่มี requirements.md) — "
                  "ข้ามการตรวจ traceability")
            return 0
        print(f"ไม่พบไฟล์ {req_path}", file=sys.stderr)
        print("ใช้: scripts/spec-trace.sh <feature>", file=sys.stderr)
        return 1

    criteria, has_headings = parse_requirements(req_path.read_text(encoding="utf-8"))
    if not has_headings:
        print(f"requirements.md ของ '{feature}' ไม่ใช่รูปแบบ REQ-based "
              "(ไม่มีหัวข้อ '## REQ-N:') — ข้ามการตรวจ traceability")
        return 0
    if not criteria:
        print(f"requirements.md ของ '{feature}' มีหัวข้อ REQ แต่ไม่พบเกณฑ์รูปแบบ '- N.M ...' เลย",
              file=sys.stderr)
        return 1

    problems = []  # list ของ (หัวข้อกลุ่ม, [บรรทัดรายการ])

    # --- EARS lint ---
    ears_bad = [f"{maj}.{mnr}: {text[:80]}" for maj, mnr, text in criteria if not ears_ok(text)]
    if ears_bad:
        problems.append(("EARS lint ไม่ผ่าน (ใช้ 'ระบบต้อง <พฤติกรรม>', "
                         "'<เมื่อ|ขณะที่|ในกรณีที่|หาก><เงื่อนไข> ระบบต้อง <พฤติกรรม>' "
                         "หรือรูป EARS ภาษาอังกฤษ):", ears_bad))

    criteria_by_req = {}
    for maj, mnr, _ in criteria:
        criteria_by_req.setdefault(maj, set()).add(mnr)
    all_ids = [(maj, mnr) for maj, mnr, _ in criteria]

    # --- coverage: design.md ---
    design_path = feature_dir / "design.md"
    if not design_path.is_file():
        print(f"ไม่พบไฟล์ {design_path} (spec แบบ REQ-based ต้องมี design.md)", file=sys.stderr)
        return 1
    design_text = design_path.read_text(encoding="utf-8")
    trace = design_traceability_text(design_text)
    if trace is None:
        problems.append(("design.md ไม่มี section '## Requirement Traceability' — "
                         "ถือว่าทุกเกณฑ์ยังไม่ถูกอ้าง:", [f"{a}.{b}" for a, b in all_ids]))
    else:
        design_covered = expand_refs(trace, criteria_by_req)
        missing = [f"{a}.{b}" for a, b in all_ids if (a, b) not in design_covered]
        if missing:
            problems.append(("เกณฑ์ที่ไม่ถูกอ้างใน design.md (section Requirement Traceability):",
                             missing))

    # --- coverage: tasks.md ---
    tasks_path = feature_dir / "tasks.md"
    if not tasks_path.is_file():
        print(f"ไม่พบไฟล์ {tasks_path} (spec แบบ REQ-based ต้องมี tasks.md)", file=sys.stderr)
        return 1
    tasks_text = tasks_path.read_text(encoding="utf-8")
    try:
        roots = parse_task_hierarchy(tasks_text)
        tasks_covered = expand_refs("\n".join(
            value for root in roots
            for value in root.satisfies + [ref for child in root.children for ref in child.satisfies]
        ), criteria_by_req)
    except TaskHierarchyError as error:
        print(f"tasks.md hierarchy ไม่ถูกต้อง: {error}", file=sys.stderr)
        return 1
    missing = [f"{a}.{b}" for a, b in all_ids if (a, b) not in tasks_covered]
    if missing:
        problems.append(("เกณฑ์ที่ไม่ถูกอ้างใน tasks.md (บรรทัด Satisfies:):", missing))

    # Closed specs ไม่ต้อง retrofit; active work ต้องรับรองว่า spec-slice ใช้ table ได้จริง.
    if trace is not None and any(not root.checked for root in roots):
        slice_problems = traceability_slice_problems(trace, design_text, criteria_by_req)
        if slice_problems:
            problems.append(("Requirement Traceability ใช้กับ spec-slice ไม่ได้:",
                             slice_problems))

    if problems:
        print(f"[{feature}] traceability ไม่ครบ (เกณฑ์ทั้งหมด {len(criteria)} ข้อ):")
        for header, items in problems:
            print(f"\n{header}")
            for item in items:
                print(f"  - {item}")
        return 1

    print(f"OK: '{feature}' เกณฑ์ {len(criteria)} ข้อ ถูกอ้างครบใน design.md และ tasks.md, "
          "EARS lint ผ่านทุกข้อ")
    return 0


def main(argv):
    if len(argv) not in (2, 3):
        print("ใช้: scripts/spec-trace.sh <feature> [<specs-dir>]   "
              "(feature = โฟลเดอร์ใต้ specs-dir, default .ai/specs)",
              file=sys.stderr)
        return 1
    specs_dir = Path(argv[2]) if len(argv) == 3 \
        else Path(__file__).resolve().parent.parent / ".ai" / "specs"
    return run(argv[1], specs_dir)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
