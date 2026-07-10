export const meta = {
  name: 'review-fanout',
  description: 'Multi-angle diff review: finder fan-out, per-candidate adversarial verify, gap sweep',
  whenToUse: 'High-effort code review of a commit/range without hand-rolling Agent spawns and mailbox collection',
  phases: [
    { title: 'Find', detail: '10 finder angles over the diff' },
    { title: 'Verify', detail: 'one 3-state verifier per deduped candidate' },
    { title: 'Sweep', detail: 'fresh reviewer hunts only gaps, then verify' },
  ],
}

// args: { target?: string, repo?: string } — target defaults to HEAD~1 (last commit)
const target = (args && args.target) || 'HEAD~1'
const repoLine = (args && args.repo) ? `Repo: ${args.repo}. ` : ''

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          summary: { type: 'string' },
          failure_scenario: { type: 'string' },
        },
        required: ['file', 'summary', 'failure_scenario'],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
}

const common = `${repoLine}Review scope: the diff from \`git diff ${target}\` (run it yourself; read enclosing functions of changed hunks as needed). You are ONE angle in a recall-first multi-angle review — surface up to 8 candidates for YOUR angle only; verification happens later.`

const ANGLES = [
  { key: 'line-scan', prompt: 'Line-by-line scan: for every changed line ask what input/state/timing makes it wrong — inverted conditions, off-by-one, null deref, missing await, falsy-zero, copy-paste wrong variable, swallowed errors, unescaped regex.' },
  { key: 'removed-behavior', prompt: 'Removed-behavior audit: for every deleted/replaced line, name the invariant it enforced and find where the new code re-establishes it. Missing = candidate (dropped guard, narrowed validation, deleted covering test).' },
  { key: 'cross-file', prompt: 'Cross-file trace: for each changed function/export, grep callers and check for broken call sites (new precondition, changed return shape, new exception, ordering). Also check callees changed in the same diff.' },
  { key: 'pitfalls', prompt: 'Language pitfalls for the diff\'s stack: JS/TS falsy-zero, == coercion, missing await, unhandled rejections, sort lexicographic, JSON.parse unguarded, React stale closures/missing error boundaries, Node fs races, EventEmitter unhandled error, socket/timer leaks.' },
  { key: 'wrapper', prompt: 'Wrapper/proxy correctness: for each wrapper/adapter/decorator touched, check every method routes to the wrapped instance (no registry re-entry/recursion), forwards everything callers use, keys/invalidates caches correctly, and fakes match the real contract.' },
  { key: 'reuse', prompt: 'Reuse (cleanup): flag new code re-implementing an existing helper — grep shared/util modules and adjacent files; name the helper to call instead. failure_scenario = concrete duplication cost.' },
  { key: 'simplify', prompt: 'Simplification (cleanup): redundant/derivable state, copy-paste variants, dead code, speculative abstraction or config nobody reads. Name the simpler form. failure_scenario = concrete cost.' },
  { key: 'efficiency', prompt: 'Efficiency (cleanup): repeated I/O, N+1 reads, sequential awaits of independent ops, unbounded growth, O(n^2) folds on growing data, hot-path blocking work. Name the cheaper alternative. failure_scenario = concrete cost.' },
  { key: 'altitude', prompt: 'Altitude (cleanup): fixes patched per-call-site where one guard in the shared function fixes all callers; special cases layered on generic infrastructure; repeated route-handler preambles that should be middleware. Name the deeper fix.' },
  { key: 'conventions', prompt: 'Conventions: read the CLAUDE.md files governing the changed paths (user ~/.claude/CLAUDE.md incl. imports, repo root, per-directory). Flag ONLY violations where you can quote the exact rule and the exact violating line (emoji in .md, .only/.skip in tests, secrets, floating dep pins).' },
]

phase('Find')
const found = await parallel(ANGLES.map((a) => () =>
  agent(`${common}\n\nANGLE ${a.key}: ${a.prompt}\n\nReturn your candidates via structured output. Empty findings array if none.`,
    { label: `find:${a.key}`, phase: 'Find', schema: FINDINGS_SCHEMA })))

const candidates = found.filter(Boolean).flatMap((r) => r.findings)
const seen = new Map()
for (const c of candidates) {
  const k = `${c.file}:${c.line ?? 0}`
  if (!seen.has(k) || (c.failure_scenario || '').length > (seen.get(k).failure_scenario || '').length) seen.set(k, c)
}
const deduped = [...seen.values()]
log(`${candidates.length} candidates, ${deduped.length} after dedup`)

phase('Verify')
const verifyOne = (c) =>
  agent(`${repoLine}You are a code-review verifier for the diff \`git diff ${target}\`. Read the actual files.\n\nCANDIDATE: ${JSON.stringify(c)}\n\nReturn exactly one verdict: CONFIRMED (name triggering inputs/state, quote the line), PLAUSIBLE (mechanism real, trigger uncertain — state what would confirm), or REFUTED (factually wrong or guarded elsewhere — quote the proving line). Check spec/requirements docs if the candidate touches speced behavior.`,
    { label: `verify:${c.file}`, phase: 'Verify', schema: VERDICT_SCHEMA })
      .then((v) => ({ ...c, verdict: v?.verdict, verdict_reason: v?.reason }))

const verified = (await parallel(deduped.map((c) => () => verifyOne(c)))).filter(Boolean)
const surviving = verified.filter((c) => c.verdict === 'CONFIRMED' || c.verdict === 'PLAUSIBLE')
log(`${surviving.length}/${verified.length} survived verification`)

phase('Sweep')
const sweep = await agent(`${repoLine}Final gap-sweep of \`git diff ${target}\`. Here is the verified list — find ONLY defects not on it (moved code that dropped a guard, second-tier footguns, setup/teardown asymmetry, flipped config defaults, error-path resource cleanup):\n${surviving.map((c) => `- ${c.file}:${c.line} ${c.summary}`).join('\n')}\n\nUp to 8 new candidates; empty array if none — do not pad.`,
  { label: 'sweep', phase: 'Sweep', schema: FINDINGS_SCHEMA })
const sweepVerified = (await parallel((sweep?.findings || []).map((c) => () => verifyOne(c)))).filter(Boolean)
const sweepSurviving = sweepVerified.filter((c) => c.verdict === 'CONFIRMED' || c.verdict === 'PLAUSIBLE')
log(`sweep added ${sweepSurviving.length}`)

const all = [...surviving, ...sweepSurviving]
return { target, findings: all, refuted: verified.filter((c) => c.verdict === 'REFUTED') }
