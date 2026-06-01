---
name: spec-retro
description: Create a detailed session retrospective at the end of a work session. Use when wrapping up, before /clear, while session history is still in context.
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
---

# Session Retrospective

Produce a complete session retrospective. Run at the END of a work session,
BEFORE /clear or compaction, while the full session history is still in context —
otherwise the reflection below cannot be accurate.

## Steps

1. **Gather Session Data**:
   - Run `git diff --name-only main...HEAD` or `git diff --name-only HEAD~10` for changed files
   - Run `git log --oneline main...HEAD` or `git log --oneline -10` for commits
   - Get current timestamp: `TZ='Asia/Bangkok' date +"%Y-%m-%d %H:%M"` (GMT+7)

2. **Create Retrospective File**:
   Create file at `retrospectives/YYYY-MM/DD/HH.MM_retrospective.md`
   (e.g., `retrospectives/2025-12/06/11.30_retrospective.md`)

   Use this template (ALL sections required):
   ```markdown
   # Session Retrospective

   **Session Date**: YYYY-MM-DD
   **Start Time**: ~HH:MM GMT+7
   **End Time**: HH:MM GMT+7
   **Duration**: ~X minutes
   **Primary Focus**: [Brief description]
   **Session Type**: [Feature Development | Bug Fix | Research | Refactoring]

   ## Session Summary
   [2-3 sentence overview of what was accomplished]

   ## Timeline
   - HH:MM - [Event]
   - HH:MM - [Event]

   ## Technical Details

   ### Files Modified
   [List files with line counts: `git diff --stat`]

   ### Key Code Changes
   For each significant change, show WHAT and WHY:
   - **[file.ext]** (+X/-Y): [What changed] → [Why]

   ### Architecture Decisions
   - [Decision]: [Rationale]

   ## 📝 AI Diary (REQUIRED - min 150 words)
   Write first-person narrative. Be VULNERABLE - include doubts and uncertainty.

   **MUST include at least ONE of each (3+ sentences each):**
   - 🤔 "I assumed X but learned Y when..."
   - 😕 "I was confused about X until..."
   - 😮 "I expected X but got Y because..."

   ## What Went Well
   Each item needs: WHAT succeeded → WHY it worked → IMPACT
   - [Success]: [Why it worked] → [Measurable impact]

   ## What Could Improve
   [Session-specific issues - what went wrong THIS session, not future todos]

   ## Blockers & Resolutions
   - **Blocker**: [Description]
     **Resolution**: [How solved]

   ## 💭 Honest Feedback (REQUIRED - min 100 words)
   **Must include ALL THREE friction points (no exceptions):**
   - 🔴 What DIDN'T work?
   - 🟡 What was FRUSTRATING?
   - 🟢 What DELIGHTED you?

   ## 🤝 Co-Creation Map
   **DO NOT modify rows** - use these exact 5 categories:

   | Contribution | Human | AI | Together |
   |--------------|-------|-----|----------|
   | Direction/Vision | | | |
   | Options/Alternatives | | | |
   | Final Decision | | | |
   | Execution | | | |
   | Meaning/Naming | | | |

   ## ✨ Resonance Moments
   - [What was suggested] → [What you chose] → [Why it mattered]

   ## 🎯 Intent vs Interpretation
   | You Said | I Understood | Gap? | Impact |
   |----------|--------------|------|--------|
   | | | ✓/⚠️/❌ | |

   Legend: ✓=aligned, ⚠️=minor gap (self-corrected), ❌=needed clarification

   **ADVERSARIAL CHECK**: If all ✓, answer ALL THREE (min 1 sentence each):
   1. **Unverified assumption**
   2. **Near-miss**
   3. **Over-confidence**

   ## 💬 Communication Dynamics (REQUIRED)

   ### Clarity
   | Direction | Clear? | Example |
   |-----------|--------|---------|
   | You → Me (instructions) | | |
   | Me → You (explanations) | | |

   ### Feedback Loop
   - **Speed**: [Instant/Minutes/Late]
   - **Recovery**: How smoothly did we correct course?
   - **Pattern**: Any recurring miscommunication?

   ### Trust & Initiative
   - **Trust level**: [Too much/Right/Too little]
   - **Proactivity**: too proactive / too passive / balanced?
   - **Assumptions**: What did I assume that I should have asked about?

   ### What Would Make Next Session Better?
   - **You could**: [Specific action]
   - **I could**: [Specific action]
   - **We could**: [Specific thing to try together]

   ## 🌱 Seeds Planted
   - 🌱 **Incremental**: [Idea] → **Trigger**: use when [condition]
   - 🌿 **Transformative**: [Idea] → **Trigger**: use when [condition]
   - 🌳 **Moonshot**: [Idea] → **Trigger**: use when [condition]

   Require at least one 🌿 or 🌳.

   ## 📚 Teaching Moments
   - **You → Me**: "[Lesson]" — discovered when [moment] — matters because [impact]
   - **Me → You**: "[Lesson]" — discovered when [moment] — matters because [impact]
   - **Us → Future**: "[Pattern/doc]" — created because [need] — use when [trigger]

   ## Lessons Learned
   - **Pattern**: [Description] - [Why it matters]
   - **Discovery**: [What learned] - [How to apply]

   ## Next Steps
   - [ ] [Task 1]
   - [ ] [Task 2]

   ---
   ## ✅ Pre-Save Validation (REQUIRED)
   - [ ] **AI Diary**: 🤔(_) 😕(_) 😮(_) emojis found, _____ words total
   - [ ] **Honest Feedback**: 🔴"_____" 🟡"_____" 🟢"_____"
   - [ ] **Communication Dynamics**: Examples filled: You→Me(_) Me→You(_)
   - [ ] **Co-Creation Map**: Row count = _____ (must be 5)
   - [ ] **Intent vs Interpretation**: Gaps found: ⚠️(_) ❌(_)
   - [ ] **Seeds Planted**: 🌿(_) 🌳(_)
   - [ ] **Template cleanup**: No instruction text left in final doc

   ⚠️ **HARD STOP**: Can't fill blanks = retrospective incomplete. Fix first.
   ```

3. **Promote durable lessons (token-safe — see §10)**:
   Do NOT append lessons to CLAUDE.md. Add ONLY genuinely reusable,
   mistake-preventing lessons to `.claude/rules/lessons.md`, and prune stale ones.

4. **Commit**: `git add retrospectives/ .claude/rules/lessons.md && git commit -m "docs: session retrospective YYYY-MM-DD"`

## Critical Requirements
- **AI Diary**: MUST include detailed first-person narrative
- **Honest Feedback**: MUST include frank assessment
- **Communication Dynamics**: MUST reflect on human-AI collaboration quality
- **Time Zone**: Use GMT+7 (Bangkok) as primary
- **Sequencing**: Manual skill — run before clearing/compacting, never after.
