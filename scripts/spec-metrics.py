#!/usr/bin/env python3
"""spec-metrics.py — per-feature SDD process metrics: task/session cost, wall-clock
span, PR mentions, rework signals (sdd-spec-metrics). Reuses cost_lib.py for ALL ledger
parsing (REQ-1.3, no second cost parser) — this script only adds feature enumeration,
git-history heuristics, and the report shape.

Every monetary figure is an estimate from the local cost ledger (~/.claude/cost-sessions/)
— API-equivalent value, NOT an actual bill (same disclaimer discipline as the platform).
Attribution imprecision (documented, not hidden): a session's cost attributes to a
feature by intersecting the session's recorded task ids against that feature's
all_task_ids() — task ids are small integers reused across features (feature A's task 3
and feature B's task 3 are indistinguishable to the ledger), so a session record can, in
principle, intersect more than one feature's id set. Accepted per this spec's own edge
case: baseline value over false precision.

usage: spec-metrics.py                 # all features, markdown table
       spec-metrics.py --json          # same data, JSON array + totals object
       spec-metrics.py --feature <f>   # one feature + per-task breakdown
exit 0 always on a produced report (missing data is REPORTED, not fatal)
exit 1 only on unusable repo state (no .ai/specs at all)
"""
import glob, json, os, re, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cost_lib import all_task_ids, session_costs, task_costs, ledger_for  # noqa: E402

DISCLAIMER = ("estimates from local ledger — API-equivalent value, not an actual bill. "
              "baseline value is low until a few more features ship with metrics on.")

CHECKBOX_RE = re.compile(r"^-\s*\[([ xX])\]\s*(\d+)", re.M)
STATUS_RE = re.compile(r"^>\s*Status:\s*approved\s+(\d{4}-\d{2}-\d{2})", re.M)


def _git(*args):
    try:
        out = subprocess.run(["git", *args], capture_output=True, text=True, check=True)
        return out.stdout.strip()
    except Exception:
        return None


def _feature_dirs():
    out = []
    for d in sorted(glob.glob(".ai/specs/*/")):
        name = os.path.basename(d.rstrip("/"))
        if name == "archive":
            continue
        out.append((name, d.rstrip("/"), False))
    for d in sorted(glob.glob(".ai/specs/archive/*/")):
        out.append((os.path.basename(d.rstrip("/")), d.rstrip("/"), True))
    return out


def _task_counts(tasks_path):
    if not os.path.exists(tasks_path):
        return None
    txt = open(tasks_path, encoding="utf-8").read()
    matches = CHECKBOX_RE.findall(txt)
    if not matches:
        return None
    done = sum(1 for state, _ in matches if state.lower() == "x")
    return dict(total=len(matches), done=done)


def _span_days(feature_dir):
    out = _git("log", "--follow", "--format=%ct", "--", feature_dir)
    if not out:
        return None
    ts = [int(x) for x in out.splitlines() if x.strip()]
    if not ts:
        return None
    return round((max(ts) - min(ts)) / 86400.0, 1)


def _pr_mentions(feature):
    out = _git("log", "--oneline", "--grep", feature)
    if out is None:
        return None
    return len([l for l in out.splitlines() if l.strip()])


def _rework(feature, req_path, design_path):
    fix_out = _git("log", "--oneline", "--grep", feature, "-i", "--grep", "fix", "--all-match")
    fix_prs = len([l for l in (fix_out or "").splitlines() if l.strip()])
    post_approval_edits = None
    for p in (req_path, design_path):
        if not p or not os.path.exists(p):
            continue
        txt = open(p, encoding="utf-8", errors="ignore").read()
        m = STATUS_RE.search(txt)
        if not m:
            continue
        since = m.group(1)
        out = _git("log", "--since", since, "--oneline", "--", p)
        count = max(0, len((out or "").splitlines()) - 1)  # minus the stamp commit itself
        post_approval_edits = (post_approval_edits or 0) + count
    return dict(fix_prs=fix_prs, post_approval_edits=post_approval_edits)


def _done_task_ids(tasks_path):
    if not os.path.exists(tasks_path):
        return set()
    txt = open(tasks_path, encoding="utf-8").read()
    return {int(tid) for state, tid in CHECKBOX_RE.findall(txt) if state.lower() == "x"}


def _cost_for_feature(all_sessions, all_ids, done_ids):
    # match sessions against ALL ids (a session can exist for a not-yet-done task, e.g.
    # an interrupted attempt) but judge completeness against DONE ids only — an
    # in-progress feature's not-yet-started tasks naturally have no session yet, and
    # that is not the "missing ledger data" gap REQ-2.1 means to flag.
    all_id_set = set(all_ids)
    matching = [s for s in all_sessions if all_id_set & set(s["ids"])]
    covered = set()
    for s in matching:
        covered |= set(s["ids"])
    total = sum(s["cost"] for s in matching)
    complete = set(done_ids) <= covered
    return dict(value=round(total, 2), complete=complete), len(matching)


def build_row(feature, feature_dir, archived, all_sessions):
    tasks_path = os.path.join(feature_dir, "tasks.md")
    tasks = _task_counts(tasks_path)
    req_path = os.path.join(feature_dir, "requirements.md")
    design_path = os.path.join(feature_dir, "design.md")

    row = dict(feature=feature, archived=archived,
               tasks=(tasks or "n/a"),
               span_days=_span_days(feature_dir),
               pr_mentions=_pr_mentions(feature),
               rework=_rework(feature, req_path, design_path))

    if all_sessions is None:
        row["cost_usd"] = "n/a"
        row["sessions"] = "n/a"
    elif tasks is None:
        row["cost_usd"] = "n/a"
        row["sessions"] = "n/a"
    else:
        ids = all_task_ids(tasks_path) if os.path.exists(tasks_path) else []
        done_ids = _done_task_ids(tasks_path)
        cost, n_sessions = _cost_for_feature(all_sessions, ids, done_ids)
        row["cost_usd"] = cost
        row["sessions"] = n_sessions
    return row


def _ledger_present():
    from cost_lib import LEDGER
    return os.path.isdir(LEDGER)


def per_task_breakdown(tasks_path):
    exclude = os.environ.get("MY_SESSION", "")
    tc = task_costs(exclude_session=exclude)
    out = []
    for t in all_task_ids(tasks_path):
        rec = tc.get(t)
        out.append(dict(task=t, cost_usd=(round(rec[0], 2) if rec else "n/a")))
    return out


def render_markdown(rows, totals, feature_breakdown=None):
    L = [f"# Spec Effectiveness Metrics", "", f"_{DISCLAIMER}_", ""]
    L += ["| feature | archived | tasks (done/total) | cost $ | sessions | span (days) | "
          "PR mentions | fix-PRs | post-approval edits |",
          "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        tasks = r["tasks"]
        tasks_s = "n/a" if tasks == "n/a" else f"{tasks['done']}/{tasks['total']}"
        cost = r["cost_usd"]
        cost_s = "n/a" if cost == "n/a" else (f"{cost['value']:.2f}" if cost["complete"]
                                               else f">= {cost['value']:.2f} (incomplete)")
        rw = r["rework"]
        L.append(f"| {r['feature']} | {r['archived']} | {tasks_s} | {cost_s} | "
                 f"{r['sessions']} | {r['span_days'] if r['span_days'] is not None else 'n/a'} | "
                 f"{r['pr_mentions'] if r['pr_mentions'] is not None else 'n/a'} | "
                 f"{rw['fix_prs']} | "
                 f"{rw['post_approval_edits'] if rw['post_approval_edits'] is not None else 'n/a'} |")
    L.append("")
    L.append(f"**totals**: features={totals['features']}, "
             f"cost=${totals['cost_usd']:.2f}{' (incomplete)' if not totals['cost_complete'] else ''}, "
             f"sessions={totals['sessions']}")
    if feature_breakdown is not None:
        L += ["", "## Per-task breakdown", "", "| task | cost $ |", "|---|---|"]
        for t in feature_breakdown:
            L.append(f"| {t['task']} | {t['cost_usd']} |")
    return "\n".join(L) + "\n"


def compute_totals(rows):
    cost_total = 0.0
    complete = True
    sessions_total = 0
    for r in rows:
        c = r["cost_usd"]
        if c != "n/a":
            cost_total += c["value"]
            complete = complete and c["complete"]
        s = r["sessions"]
        if isinstance(s, int):
            sessions_total += s
    return dict(features=len(rows), cost_usd=round(cost_total, 2),
                cost_complete=complete, sessions=sessions_total)


def main(argv):
    as_json = "--json" in argv
    feature_arg = None
    if "--feature" in argv:
        i = argv.index("--feature")
        if i + 1 >= len(argv):
            print("usage: spec-metrics.py --feature <name>", file=sys.stderr)
            return 1
        feature_arg = argv[i + 1]

    features = _feature_dirs()
    if not features and not os.path.isdir(".ai/specs"):
        print("spec-metrics: no .ai/specs directory found — unusable repo state", file=sys.stderr)
        return 1

    if feature_arg:
        features = [f for f in features if f[0] == feature_arg]
        if not features:
            print(f"spec-metrics: no such feature '{feature_arg}'", file=sys.stderr)
            return 1

    all_sessions = session_costs(exclude_session=os.environ.get("MY_SESSION", "")) \
        if _ledger_present() else None

    rows = [build_row(name, d, archived, all_sessions) for name, d, archived in features]
    totals = compute_totals(rows)

    breakdown = None
    if feature_arg:
        tasks_path = os.path.join(features[0][1], "tasks.md")
        if os.path.exists(tasks_path) and all_sessions is not None:
            breakdown = per_task_breakdown(tasks_path)

    if as_json:
        print(json.dumps(dict(disclaimer=DISCLAIMER, rows=rows, totals=totals,
                               per_task=breakdown), indent=2))
    else:
        print(render_markdown(rows, totals, breakdown), end="")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
