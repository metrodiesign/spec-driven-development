#!/usr/bin/env python3
"""Spec-to-Goal generator (platform-phase5-stage1) — แปลง approved SDD spec เป็น
`goal.draft.yaml` แบบ one-way, human-gated.

อ่านเฉพาะ `.ai/specs/<feature>/requirements.md` + `tasks.md` แล้วเขียนไฟล์ draft
เดียวจบ — ไม่ freeze, ไม่ start run, ไม่เรียก platform CLI ใดๆ (REQ-4.6).
Parsing semantics ทั้งหมด reuse จาก `spec_trace.py` (import เป็น library):
`parse_requirements` / `expand_refs` / `iter_task_blocks` — single source,
ไม่มีวัน drift จากตัวตรวจ traceability (REQ-2.3).

Draft ที่มี verification ค้าง (unresolved) ถูก emit ให้ `acceptance_criteria`
เป็น array ว่าง — `freezeContract` ปฏิเสธเชิงโครงสร้างทันที (REQ-4.4) — โดยเก็บ
เกณฑ์ทั้งหมดไว้ใน `pending_acceptance_criteria` ให้ human activate เอง.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import spec_trace

USAGE = "usage: scripts/spec-to-goal.sh <feature> [--force] [--specs-dir <path>]"

# marker ภายใน task block — ลำดับใดก็ได้; segment ของ marker ตัดท้ายที่ marker ถัดไป
MARKER_RE = re.compile(r"Satisfies:|Verify:|Depends on:|Batch:")

# §11.1 budget scaffold — pin ตาม console/backend/src/issues.ts `goalDraftYaml`
# (ค่าซ้ำโดยเจตนา: tooling ห้าม import runtime code ข้าม layer)
BUDGET_LINE = (
    "budget: { max_iterations_per_task: 8, max_hypotheses_per_failure: 3, "
    "max_total_tasks: 30, max_parallel_agents: 3, max_cost_units_per_task: 500, "
    "max_wallclock_per_task_min: 30 }"
)

BANNER_UNRESOLVED = [
    "# HUMAN: (1) review pending_acceptance_criteria + fill every TODO verification",
    "#        (2) rename pending_acceptance_criteria -> acceptance_criteria",
    "#            and delete the empty acceptance_criteria line below",
    '#            WARNING: freezeContract does NOT reject "TODO" strings — renaming',
    "#            without doing step (1) produces a freezable contract with fake",
    "#            verifications; steps are advisory ordering, the only structural",
    "#            gate is the empty acceptance_criteria below",
    "#        (3) set risk (L0-L4), decide golden flags, set approval_policy",
    "#        (4) write goal.objective (one sentence) + fill scope/forbidden",
]

BANNER_RESOLVED = [
    "# HUMAN: (1) review acceptance_criteria — every verification was prefilled from the spec",
    "#        (2) set risk (L0-L4), decide golden flags, set approval_policy",
    "#        (3) write goal.objective (one sentence) + fill scope/forbidden",
]


def fail(msg):
    """refusal ทุกจุด: เหตุผลบรรทัดเดียวบน stderr + exit code 1 (REQ-5.3)."""
    print(msg, file=sys.stderr)
    return 1


def title_from_h1(text, fallback):
    """goal.title จาก H1 (REQ-3.2): strip prefix 'Requirements' + separator นำหน้า
    (':' / '—' / '-') — รองรับทั้ง `# Requirements: <name>` และ `# Requirements — <name>`."""
    for line in text.splitlines():
        if line.startswith("# "):
            t = line[2:].strip()
            if t.startswith("Requirements"):
                t = t[len("Requirements"):]
            return t.lstrip(" :—-").strip() or fallback
    return fallback


def task_maps(tasks_text, criteria_by_req):
    """คืน list ของ (satisfies_refs, verify_cmd) หนึ่งรายการต่อ task block.

    เดินไฟล์ด้วย `spec_trace.iter_task_blocks` (นิยาม block เดียวกับตัวตรวจ
    coverage — REQ-2.3); ภายใน block: การ scan หยุดที่ `Evidence:` ตัวแรก —
    transcript ของ task ที่ทำเสร็จแล้วต้องไม่รั่วเข้า verification และเนื้อใน
    transcript (ที่อาจ quote marker เอง) ต้องไม่ถูก parse (PR #102 Codex P2);
    ก่อนถึงจุดนั้น: segment ของแต่ละ marker ตัดท้ายที่ marker ถัดไป, Satisfies
    ขยายผ่าน `expand_refs` (dash range / N.M / REQ-N ทั้งตัว), Verify copy
    verbatim (strip ปลายเท่านั้น — ไม่ตีความว่าเป็น command จริงไหม).
    """
    maps = []
    for block in spec_trace.iter_task_blocks(tasks_text):
        block = block.split("Evidence:", 1)[0]
        markers = list(MARKER_RE.finditer(block))
        refs = set()
        verify_cmd = ""
        for j, m in enumerate(markers):
            end = markers[j + 1].start() if j + 1 < len(markers) else len(block)
            segment = block[m.end():end]
            if m.group(0) == "Satisfies:":
                refs |= spec_trace.expand_refs(segment, criteria_by_req)
            elif m.group(0) == "Verify:" and not verify_cmd:
                verify_cmd = segment.strip()
        maps.append((refs, verify_cmd))
    return maps


def build_acs(criteria, maps):
    """AC หนึ่งตัวต่อเกณฑ์ (REQ-2.1/2.2); verification resolved เมื่อมี task cover
    ตัวเดียวพอดีและ task นั้นมี Verify ไม่ว่าง (REQ-2.4) — นอกนั้น None (REQ-2.5)."""
    acs = []
    for major, minor, text in criteria:
        covers = [cmd for refs, cmd in maps if (major, minor) in refs]
        verification = covers[0] if len(covers) == 1 and covers[0] else None
        acs.append({"id": f"AC-{major}.{minor}", "description": text,
                    "verification": verification})
    return acs


def ac_line(ac):
    # scalar ทุกตัวผ่าน json.dumps — JSON string เป็น valid YAML double-quoted
    # scalar (precedent: issues.ts ใช้ JSON.stringify ด้วยเหตุผลเดียวกัน; REQ-3.7)
    verification = ac["verification"] if ac["verification"] is not None else "TODO"
    return (f"  - {{ id: {json.dumps(ac['id'])}, "
            f"description: {json.dumps(ac['description'], ensure_ascii=False)}, "
            f"verification: {json.dumps(verification, ensure_ascii=False)} }}")


def emit(feature, title, acs, src_path, sha, head_commit, generated_at):
    unresolved = sum(1 for a in acs if a["verification"] is None)
    goal_id = re.sub(r"[^A-Za-z0-9-]", "-", feature).upper() + "-001"
    lines = [
        "# spec-to-goal draft — DO NOT run as-is",
        f"# source: {src_path}",
        f"# requirements_sha256: {sha}",
        f"# head_commit: {head_commit}",
        f"# generated_at: {generated_at}",
    ]
    lines += BANNER_UNRESOLVED if unresolved else BANNER_RESOLVED
    lines += [
        f"goal: {{ id: {json.dumps(goal_id)}, "
        f"title: {json.dumps(title, ensure_ascii=False)}, objective: \"TODO\" }}",
        'risk: "TODO"',
        "scope:",
        '  include: ["TODO"]',
        '  exclude: ["TODO"]',
        "constraints:",
        '  forbidden: ["TODO"]',
    ]
    if unresolved:
        # REQ-4.4: active array ว่าง = freezeContract ปฏิเสธไฟล์ทั้งใบเชิงโครงสร้าง
        lines.append("acceptance_criteria: []   "
                     "# gate: freezeContract rejects empty — activate per HUMAN step (2)")
        lines.append("pending_acceptance_criteria:")
    else:
        # REQ-4.5: resolved ครบ — เกณฑ์ทั้งหมด active, ผ่าน freezeContract ได้ทันที
        lines.append("acceptance_criteria:")
    lines += [ac_line(a) for a in acs]
    lines += [
        BUDGET_LINE,
        "approval_policy:",
        '  require_human_approval: ["TODO"]',
        "",
    ]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="spec-to-goal", usage=USAGE,
        description="Generate goal.draft.yaml from an approved REQ-form spec.")
    parser.add_argument("feature")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--specs-dir", default=None)
    args = parser.parse_args(argv)

    # --- gate chain: paths -> header -> parse -> structural (1.5 -> 1.7 -> 1.8) ---
    specs_dir = Path(args.specs_dir) if args.specs_dir \
        else Path(__file__).resolve().parent.parent / ".ai" / "specs"
    feature_dir = specs_dir / args.feature
    req_path = feature_dir / "requirements.md"
    if not req_path.is_file():
        return fail(f"error: {req_path} not found — {USAGE}")

    raw = req_path.read_bytes()
    # hash + decode จาก buffer เดียวกัน — ห้าม read_text().encode() (newline
    # translation ทำ sha256 anchor เพี้ยนบนไฟล์ CRLF/BOM; REQ-3.5)
    sha = hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8")

    status_line = next((ln for ln in text.splitlines() if ln.startswith("> Status:")), None)
    if status_line is None:
        return fail('error: requirements.md has no "> Status:" header line — '
                    "approve the spec first (no bypass)")
    if not status_line.startswith("> Status: approved"):
        return fail(f'error: requirements.md status is "{status_line.strip()}" — '
                    "spec must be approved before generating a goal draft (no bypass)")

    criteria, has_headings = spec_trace.parse_requirements(text)
    if not has_headings:
        return fail("error: no '## REQ-' headings found — only REQ-form feature "
                    "specs are supported (bugfix F-/B- specs are not)")

    seen = set()
    for major, minor, _ in criteria:
        if (major, minor) in seen:
            return fail(f"error: duplicate criterion id {major}.{minor} in requirements.md")
        seen.add((major, minor))

    # rescan heading เอง — parse_requirements ไม่คืนรายการ heading, REQ ที่ว่าง
    # จะหายเงียบจาก criteria ถ้าไม่เทียบกลับ (REQ-1.8)
    heading_majors = [int(m.group(1)) for ln in text.splitlines()
                      if (m := spec_trace.REQ_HEADING_RE.match(ln))]
    criteria_majors = {major for major, _, _ in criteria}
    empty_reqs = [n for n in heading_majors if n not in criteria_majors]
    if empty_reqs:
        return fail(f"error: REQ-{empty_reqs[0]} has no criterion lines "
                    "('- N.M ...') under it")

    # --- tasks.md -> per-task maps (absent = warn + ทุกตัว unresolved; REQ-1.6) ---
    criteria_by_req = {}
    for major, minor, _ in criteria:
        criteria_by_req.setdefault(major, set()).add(minor)
    tasks_path = feature_dir / "tasks.md"
    if tasks_path.is_file():
        maps = task_maps(tasks_path.read_text(encoding="utf-8"), criteria_by_req)
    else:
        print(f"warning: {tasks_path} not found — every verification left unresolved",
              file=sys.stderr)
        maps = []
    acs = build_acs(criteria, maps)

    # --- provenance (REQ-3.5) ---
    head_commit = "unknown"
    try:
        proc = subprocess.run(["git", "-C", str(feature_dir), "rev-parse", "HEAD"],
                              capture_output=True, text=True)
        if proc.returncode == 0:
            head_commit = proc.stdout.strip()
    except OSError:
        pass
    if head_commit == "unknown":
        print('warning: git rev-parse HEAD failed — head_commit recorded as "unknown"',
              file=sys.stderr)
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # --- output gate หลัง validation ทั้งหมด (user เห็น error ของ spec ก่อนเรื่อง --force) ---
    out_path = feature_dir / "goal.draft.yaml"
    if out_path.exists() and not args.force:
        return fail(f"error: {out_path} already exists — pass --force to overwrite")

    content = emit(args.feature, title_from_h1(text, args.feature), acs,
                   str(req_path), sha, head_commit, generated_at)

    # atomic write: temp ในโฟลเดอร์เดียวกัน + os.replace — ไม่มี partial file
    # ค้างให้ชน REQ-4.2 รอบถัดไป
    tmp_name = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=feature_dir,
                                         prefix=".goal.draft.", suffix=".tmp",
                                         delete=False) as tmp:
            tmp_name = tmp.name
            tmp.write(content)
        os.replace(tmp_name, out_path)
    except BaseException:
        if tmp_name is not None and os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise

    resolved = sum(1 for a in acs if a["verification"] is not None)
    print(f"wrote {out_path} — {len(acs)} acceptance criteria, "
          f"{resolved} resolved / {len(acs) - resolved} unresolved verifications")
    return 0


if __name__ == "__main__":
    sys.exit(main())
