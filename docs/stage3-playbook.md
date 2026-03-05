# Stage 3 Playbook — Review Context Package & Handoff Policy

Stage 3 defines the **contract between the orchestrator and the reviewer prompt**: what information Claude receives when performing a review, how the prompt is structured to minimize anchoring bias, and what Definition of Done (DoD) governs a `review_pass` verdict.

---

## Goals

1. Give the reviewer Claude a **clean, complete context package** — no implementation history, no iteration count, no prior reviewer opinions.
2. Use an **anti-bias reviewer prompt** that instructs Claude to evaluate the code on its own merits.
3. Establish **handoff flags** that the orchestrator sets when transitioning from `implement`/`patch` to `review`.
4. Define a clear **Definition of Done** so `[REVIEW_PASS]` has an unambiguous meaning.

---

## 1. Clean Review Context Package

When the orchestrator (or worker) builds the prompt for a `review` mode task, it must include exactly the following — no more, no less.

### Required fields

| Field | Source | Notes |
|---|---|---|
| `instructions` | Original task instructions | The full original task goal, verbatim |
| `constraints` | Original task constraints | The full original constraint list, verbatim |
| `contextSnippets` | `review` specific snippets | Code diffs, relevant files, test output |
| `reviewTarget` | Task field | Absolute or repo-relative path(s) of files/commits to review |
| `acceptanceCriteria` | Task field | The DoD checklist (see §4) |

### Excluded fields (must NOT be injected)

| Excluded | Reason |
|---|---|
| `previousReviewFindings` | Reviewer must not be anchored to prior verdicts |
| Iteration count (`reviewIteration`) | Hides loop history to avoid "fatigue bias" |
| Any Claude output from prior runs | Prevents confirmation bias |
| Implementation timeline / author info | Keeps review author-blind |

The `previousReviewFindings` field is injected **only** into `implement` (patch) mode prompts. It must never appear in a `review` mode prompt.

---

## 2. Anti-Bias Reviewer Prompt

The reviewer system prompt must open with the following block (adapt wording, but preserve semantics):

```
You are a rigorous code reviewer. You have NOT seen this code before.
Evaluate it solely on correctness, security, and adherence to the stated
requirements. Do not assume prior fixes are correct. Do not be lenient
because the code "looks mostly right". Your verdict must be based entirely
on the code as it exists right now.
```

### Required prompt sections (in order)

1. **Anti-bias preamble** — the block above.
2. **Task goal** — injected from `task.instructions`.
3. **Constraints** — injected from `task.constraints` as a bulleted list.
4. **Acceptance criteria** — injected from `task.acceptanceCriteria` or the standard DoD checklist (§4).
5. **Files / diff to review** — injected from `task.contextSnippets` or `task.reviewTarget`.
6. **Output format instructions** — see §5.

### Anti-anchoring rules

- Do **not** include phrases like "you reviewed this before" or "previously you found".
- Do **not** state how many patch iterations have occurred.
- Do **not** include the original `[REVIEW_FAIL]` text from prior iterations.

---

## 3. Handoff Flags

The orchestrator sets these fields on the task object when transitioning to a `review` mode run. The worker reads them when building the prompt.

| Flag | Type | Set by | Meaning |
|---|---|---|---|
| `mode` | string | orchestrator | Must be `"review"` |
| `reviewTarget` | string or string[] | orchestrator | Path(s) or commit range being reviewed |
| `acceptanceCriteria` | string[] | orchestrator | DoD checklist items (see §4) |
| `reviewLoop` | boolean | orchestrator | `true` if the review-patch cycle should loop automatically |
| `maxReviewIterations` | number | orchestrator | Max allowed loop iterations (default 3) |
| `reviewIteration` | number | worker (internal) | Current iteration counter — **not injected into reviewer prompt** |
| `previousReviewFindings` | object[] | worker (patch mode only) | Structured findings — **not injected into reviewer prompt** |

The worker enforces: if `mode === "review"` and `previousReviewFindings` is present on the task, it silently drops it from the reviewer prompt build. It is only used to construct the patch prompt.

---

## 4. Definition of Done (DoD)

A `[REVIEW_PASS]` verdict is valid only when **all** of the following conditions hold:

### Functional correctness
- [ ] All stated task requirements are implemented and verifiable in the code.
- [ ] No regression: existing tests (if present) pass or are correctly updated.
- [ ] Edge cases described in constraints are handled.

### Security
- [ ] No OWASP Top 10 vulnerabilities introduced (injections, XSS, broken auth, etc.).
- [ ] No secrets, credentials, or tokens committed.
- [ ] No use of unsafe APIs without justification (e.g. `eval`, `innerHTML`).

### Code quality
- [ ] No obviously dead or unreachable code.
- [ ] Error paths are handled at system boundaries (user input, external APIs).
- [ ] No TODO/FIXME left in code paths that block the task goal.

### Scope
- [ ] Changes are limited to the stated task scope (no unrelated refactors, no feature additions).
- [ ] No auto-merges, force-pushes, or CI bypass markers introduced.

### Docs-and-tests (if applicable)
- [ ] If the task created or changed a public API, the relevant docs are updated.
- [ ] If the task added logic, at least a smoke test exists.

If any item is not met, the reviewer **must** emit `[REVIEW_FAIL]` with structured findings (see `FINDINGS_SCHEMA.md`).

---

## 5. Reviewer Output Format

The reviewer must emit exactly one of these two outputs:

**Pass:**
```
[REVIEW_PASS]
<One-paragraph summary of what was verified and confirmed correct.>
```

**Fail:**
```
[REVIEW_FAIL severity=<critical|major|minor>]
<Plain-text summary of all issues found.>
[REVIEW_FINDINGS_JSON]
[
  {
    "id": "F1",
    "severity": "critical",
    "file": "<relative path>",
    "issue": "<one-sentence description>",
    "risk": "<impact if left unresolved>",
    "required_fix": "<specific change required>",
    "acceptance_check": "<verifiable condition that proves fix was applied>"
  }
]
[/REVIEW_FINDINGS_JSON]
[/REVIEW_FAIL]
```

The `severity` on `[REVIEW_FAIL]` must reflect the **highest** severity among all findings.

See `FINDINGS_SCHEMA.md` for full field definitions and loop policy.

---

## 6. Smoke Checklist (1-task verification)

Run this check after any changes to the review prompt or handoff logic:

```
[ ] 1. Submit a task with mode=review and at least one deliberate bug in contextSnippets.
       Expected: Claude emits [REVIEW_FAIL] with at least one finding that identifies the bug.
       worker status → review_fail

[ ] 2. Submit a task with mode=review and clean (correct) code.
       Expected: Claude emits [REVIEW_PASS] with a summary.
       worker status → review_pass

[ ] 3. Verify previousReviewFindings does NOT appear in the review prompt by checking
       NEEDS_INPUT_DEBUG=true logs for "previousReviewFindings injection" — it must be absent.

[ ] 4. Submit a reviewLoop=true task with a bug that requires one patch iteration.
       Expected event sequence:
         claimed → progress/validate → review_loop_fail → review_pass (iter 2)
       meta.reviewIteration on final review_pass event must equal 2.
```
