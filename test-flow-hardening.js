#!/usr/bin/env node
"use strict";

/**
 * Integration test: flow-hardening regressions.
 *
 * Covers:
 *   1. [regression] Review output with [REVIEW_PASS] must NOT trigger needs_input
 *      even when the output text contains words that heuristics match.
 *   2. [regression] Review output with [REVIEW_FAIL] must NOT trigger needs_input.
 *   3. [orchestrated] Full orchestrated loop: implement → review(pass) → review_pass.
 *   4. [orchestrated] Orchestrated loop: implement → review(fail) → patch → re-review(pass)
 *      → review_pass at iter 2.
 *   5. [orchestrated] Orchestrated loop always-fail → escalated at maxIter.
 *   6. [context_reset] context_reset events emitted for each new Claude session.
 *   7. [v4 forensic] "blocks promotion to needs_input." prose false-positive.
 *   8. [v4 forensic] AskUserQuestion mentioned in prose report (not a real denial).
 *   9. [v4 positive] Real AskUserQuestion permission denial → needs_input.
 *
 * Task sequence:
 *   Pull 1 → review task (mode:review, NO reviewLoop) with REVIEW_PASS output
 *             → must yield review_pass (not needs_input)
 *   Pull 2 → review task (mode:review, NO reviewLoop) with REVIEW_FAIL output
 *             → must yield review_fail (not needs_input)
 *   Pull 3 → orchestratedLoop task (pass on first review) → review_pass (iter 1)
 *   Pull 4 → orchestratedLoop task (fail→pass, maxIter=3) → review_pass (iter 2)
 *   Pull 5 → orchestratedLoop task (always fail, maxIter=2) → escalated (iter 2)
 *   Pull 6+ → empty → trigger finish
 *
 * Mock claude behaviour (detected via prompt content):
 *   • Prompt contains "ORCHESTRATED-PASS-FIRST"  → output REVIEW_PASS immediately
 *   • Prompt contains "ORCHESTRATED-FAIL-PASS"   → first review: REVIEW_FAIL; re-review: REVIEW_PASS
 *   • Prompt contains "ORCHESTRATED-ALWAYS-FAIL" → always REVIEW_FAIL
 *   • Prompt contains "## Review Findings"        → patch: success
 *   • Prompt contains "review-loop-context"       → re-review after patch: REVIEW_PASS (for fail→pass)
 *   • Prompt contains "SIMPLE-REVIEW-PASS"        → REVIEW_PASS (plain review, heuristic bait words)
 *   • Prompt contains "SIMPLE-REVIEW-FAIL"        → REVIEW_FAIL (plain review, heuristic bait words)
 *   • Otherwise                                   → implement success
 *
 * Usage: node test-flow-hardening.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-fh-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-fh-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// The mock claude script handles all scenarios deterministically.
// Heuristic bait: SIMPLE-REVIEW-* outputs include the word "NEEDS_INPUT" and "question"
// in non-marker context to verify the heuristic is suppressed in review mode.
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// ── Plain review with heuristic bait (false needs_input regression tests) ──

if (prompt.includes("SIMPLE-REVIEW-PASS")) {
  // Output contains heuristic bait: NEEDS_INPUT token and the word "question"
  // but the actual verdict is REVIEW_PASS. Worker must not trigger needs_input.
  out("Review complete. No NEEDS_INPUT required. The question of code quality is answered: all checks pass.\\n\\n[REVIEW_PASS]\\nAll security and quality requirements are satisfied.");
}

if (prompt.includes("SIMPLE-REVIEW-FAIL")) {
  // Output contains heuristic bait but verdict is REVIEW_FAIL.
  out("Review found issues. NEEDS_INPUT is not applicable here. The question is whether to patch now or later — but for the review, the answer is clear:\\n\\n[REVIEW_FAIL severity=major]\\nAuthentication bypass in session handler.\\n[/REVIEW_FAIL]");
}

// ── Orchestrated loop scenarios ──

if (prompt.includes("ORCHESTRATED-PASS-FIRST")) {
  if (prompt.includes("mode: review") || prompt.includes("[review]")) {
    // Review phase of pass-first orchestrated task
    out("All looks good.\\n\\n[REVIEW_PASS]\\nImplementation is correct and complete.");
  }
  // Implement phase
  out("Implementation complete for ORCHESTRATED-PASS-FIRST.");
}

if (prompt.includes("ORCHESTRATED-FAIL-PASS")) {
  // Always-fail scenario check MUST come before review-loop-context check
  // (review-loop-context is added to re-review snippets)
  if (prompt.includes("## Review Findings")) {
    // Patch run
    out("Patch applied. All findings addressed for ORCHESTRATED-FAIL-PASS.");
  }
  if (prompt.includes("review-loop-context")) {
    // Re-review after patch → pass
    out("Re-reviewed. Issues resolved.\\n\\n[REVIEW_PASS]\\nAll previously identified issues have been fixed.");
  }
  if (prompt.includes("mode: review") || prompt.includes("[review]")) {
    // First review → fail with structured findings
    const findings = [{id:"F1",severity:"critical",file:"api.js",issue:"Missing auth check",risk:"Unauthorized access",required_fix:"Add JWT validation middleware",acceptance_check:"401 returned on unauthenticated requests"}];
    out("Found critical issues.\\n\\n[REVIEW_FAIL severity=critical]\\nMissing authentication.\\n[REVIEW_FINDINGS_JSON]" + JSON.stringify(findings) + "[/REVIEW_FINDINGS_JSON]\\n[/REVIEW_FAIL]");
  }
  // Implement phase
  out("Implementation complete for ORCHESTRATED-FAIL-PASS.");
}

if (prompt.includes("ORCHESTRATED-ALWAYS-FAIL")) {
  if (prompt.includes("## Review Findings")) {
    // Patch run
    out("Patch attempted for ORCHESTRATED-ALWAYS-FAIL.");
  }
  if (prompt.includes("mode: review") || prompt.includes("[review]")) {
    const findings = [{id:"F1",severity:"major",file:"render.js",issue:"XSS",risk:"Session hijack",required_fix:"Escape output",acceptance_check:"No innerHTML with user data"}];
    out("Still failing.\\n\\n[REVIEW_FAIL severity=major]\\nXSS not fixed.\\n[REVIEW_FINDINGS_JSON]" + JSON.stringify(findings) + "[/REVIEW_FINDINGS_JSON]\\n[/REVIEW_FAIL]");
  }
  // Implement phase
  out("Implementation complete for ORCHESTRATED-ALWAYS-FAIL.");
}

// ── Implement tasks with [NEEDS_INPUT] in non-ask positions (false-trigger regression) ──

if (prompt.includes("IMPL-FALSE-TRIGGER-FENCE")) {
  // Output embeds a [NEEDS_INPUT] block inside a triple-backtick code fence
  // (documentation/example). Worker must NOT trigger needs_input — status: completed.
  out("Here is the integration guide.\\n\\n\`\`\`\\n[NEEDS_INPUT]\\nquestion: Which environment do you want to target?\\noptions: dev, staging, prod\\n[/NEEDS_INPUT]\\n\`\`\`\\n\\nThe above marker syntax is used when the worker needs clarification. Implementation complete.");
}

if (prompt.includes("IMPL-FALSE-TRIGGER-PROSE")) {
  // Output mentions [NEEDS_INPUT] inline in a sentence (not at start of line).
  // Worker must NOT trigger needs_input — status: completed.
  out("Implementation complete. Note: the worker supports the [NEEDS_INPUT]question: ask here[/NEEDS_INPUT] syntax inline, but this task does not require user input.");
}

if (prompt.includes("IMPL-FALSE-TRIGGER-EMPTY")) {
  // Output has [NEEDS_INPUT]...[/NEEDS_INPUT] at start of line but with NO question field.
  // Worker must NOT trigger needs_input — status: completed.
  out("[NEEDS_INPUT]\\ncontext: This is just informational, no question asked.\\n[/NEEDS_INPUT]\\n\\nImplementation done.");
}

// ── v2 false-positive regression tests ──

if (prompt.includes("IMPL-FALSE-FENCED-JSON")) {
  // Output contains a fenced JSON block with a "question" key — report/config data,
  // NOT a real ask. Previously matched by heuristic step B.
  out("Implementation complete. Here is the validation report:\\n\\n\`\`\`json\\n{\\"question\\": \\"What is your preferred config format?\\", \\"status\\": \\"answered\\", \\"answer\\": \\"YAML\\"}\\n\`\`\`\\n\\nAll config files generated.");
}

if (prompt.includes("IMPL-FALSE-PLAIN-JSON")) {
  // Output contains a plain JSON object with "question" key in prose — e.g., a FAQ item.
  // Previously matched by heuristic step C.
  out("Implementation complete. FAQ entry added: {\\"question\\": \\"How do I reset my password?\\", \\"answer\\": \\"Use the /reset endpoint\\"}. Done.");
}

if (prompt.includes("IMPL-FALSE-HEURISTIC-TOKEN")) {
  // Output mentions NEEDS_INPUT and question as prose words — documentation text.
  // Previously matched by heuristic step D.
  out("Implementation complete. Note: the NEEDS_INPUT mechanism can be used to pose a question to the user when clarification is needed. This task did not require any user input.");
}

if (prompt.includes("IMPL-COMPLETED-FULL-REPORT")) {
  // Completed task with full report output, exitCode=0, no structured ask at all.
  // Must stay as terminal completed — never needs_input.
  out("# Implementation Report\\n\\n## Changes Made\\n- Added authentication middleware\\n- Updated route handlers\\n- Added unit tests (14 passing)\\n\\n## Summary\\nAll requirements implemented successfully. No further action needed.");
}

// ── v4 forensic regression fixture ──
// Observed in production: Claude output mentioned NEEDS_INPUT in prose discussing
// how the worker handles blocking scenarios. Old heuristic step D matched
// "NEEDS_INPUT" + "question" as prose tokens and extracted the arbitrary text
// "blocks promotion to needs_input." as the question field. This false-positive
// was the exact regression that prompted the forensic investigation.

if (prompt.includes("IMPL-FALSE-BLOCKS-PROSE")) {
  out("Implementation complete. The NEEDS_INPUT mechanism blocks promotion to needs_input. The question of whether to use markers or tool calls is addressed in the design doc. No further action needed.");
}

if (prompt.includes("IMPL-FALSE-AUQ-IN-REPORT")) {
  // Output contains AskUserQuestion as a string mention (e.g., in a report about
  // tool usage), NOT as a real permission_denials JSONL entry. Must not trigger.
  out("# Tool Usage Report\\n\\nTools used: Read, Write, Bash, AskUserQuestion (0 calls)\\n\\nThe AskUserQuestion tool was available but not invoked. No questions needed. Task completed successfully.");
}

// ── v3 false-positive regression tests ──

if (prompt.includes("IMPL-REAL-NEEDS-INPUT")) {
  // Positive test: real structured [NEEDS_INPUT] ask outside fences, with question.
  // Worker MUST trigger needs_input with correct question/options.
  out("I need clarification before proceeding.\\n\\n[NEEDS_INPUT]\\nquestion: Which database engine should I use?\\noptions: PostgreSQL, MySQL, SQLite\\ncontext: The project has no existing database configuration.\\n[/NEEDS_INPUT]");
}

if (prompt.includes("IMPL-FALSE-MARKER-IN-HEADING")) {
  // Output mentions [NEEDS_INPUT] in a markdown heading — not a real ask block.
  // The marker is part of documentation, not line-anchored block syntax.
  out("# How [NEEDS_INPUT] Works\\n\\nThe NEEDS_INPUT marker is used when the worker needs user clarification.\\nquestion: This is just explaining the field names.\\noptions: These are not real options.\\n\\nImplementation complete.");
}

if (prompt.includes("IMPL-FALSE-MULTI-FENCE")) {
  // Output has multiple code fences, one containing [NEEDS_INPUT] block.
  // Worker must NOT trigger needs_input.
  out("## Integration Guide\\n\\n\\\`\\\`\\\`yaml\\nconfig:\\n  timeout: 30\\n\\\`\\\`\\\`\\n\\nExample needs_input block:\\n\\n\\\`\\\`\\\`\\n[NEEDS_INPUT]\\nquestion: Which region?\\noptions: us-east, eu-west\\n[/NEEDS_INPUT]\\n\\\`\\\`\\\`\\n\\nDone.");
}

if (prompt.includes("IMPL-REAL-AUQ-DENIAL")) {
  // Positive test: real AskUserQuestion permission denial in JSONL output.
  // Worker MUST trigger needs_input with correct question/options.
  const denial = {
    type: "result",
    subtype: "success",
    result: "I need to ask the user a question before proceeding.",
    is_error: false,
    permission_denials: [{
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [{
          question: "Which authentication provider should I integrate?",
          options: [
            { label: "Auth0", description: "Managed auth service" },
            { label: "Firebase Auth", description: "Google auth service" },
            { label: "Custom JWT", description: "Roll your own" }
          ]
        }]
      }
    }]
  };
  process.stdout.write(JSON.stringify(denial));
  process.exit(0);
}

if (prompt.includes("IMPL-FALSE-PRODUCTION-COMPOUND")) {
  // Production-realistic false positive: a long implementation report that mentions
  // NEEDS_INPUT, AskUserQuestion, and "question" in prose/documentation context.
  // This compounds all known false-positive vectors into one output. The worker
  // MUST NOT emit a needs_input event or set needs_input status.
  out("# Implementation Report\\n\\n## Changes Made\\n- Refactored parseNeedsInput to use strict-only detection\\n- The NEEDS_INPUT marker blocks promotion to needs_input unless isStructuredAsk is true\\n- Removed heuristic steps B/C/D that caused false positives\\n\\n## Technical Details\\nThe [NEEDS_INPUT] syntax is now line-anchored. The question field must be present.\\nPreviously, prose like \\"the question of whether to use AskUserQuestion\\" triggered false notifications.\\nThe AskUserQuestion tool is checked only in permission_denials JSONL, not in prose.\\n\\n## Validation\\n- question: all edge cases covered\\n- options: three detection paths tested\\n- NEEDS_INPUT: 12 false-positive scenarios pass\\n\\nNo further action needed. All requirements met.");
}

// Default: generic success (shouldn't be reached in these tests)
out("Task completed successfully.");
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ───────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/flow-hardening-test" };

// Task 1: plain review — output has [REVIEW_PASS] + heuristic bait → must be review_pass
const TASK_SIMPLE_REVIEW_PASS = {
  taskId: "fh-simple-review-pass-001",
  mode: "review",
  scope: SCOPE,
  instructions: "Review code for SIMPLE-REVIEW-PASS scenario.",
};

// Task 2: plain review — output has [REVIEW_FAIL] + heuristic bait → must be review_fail
const TASK_SIMPLE_REVIEW_FAIL = {
  taskId: "fh-simple-review-fail-001",
  mode: "review",
  scope: SCOPE,
  instructions: "Review code for SIMPLE-REVIEW-FAIL scenario.",
};

// Task 3: orchestrated loop — implement passes, review passes immediately
const TASK_ORCH_PASS_FIRST = {
  taskId: "fh-orch-pass-first-001",
  mode: "implement",
  orchestratedLoop: true,
  maxReviewIterations: 3,
  scope: SCOPE,
  instructions: "ORCHESTRATED-PASS-FIRST: implement and review a simple feature.",
  patchInstructions: "Fix issues from ORCHESTRATED-PASS-FIRST review.",
};

// Task 4: orchestrated loop — review fails first, passes after one patch
const TASK_ORCH_FAIL_PASS = {
  taskId: "fh-orch-fail-pass-001",
  mode: "implement",
  orchestratedLoop: true,
  maxReviewIterations: 3,
  scope: SCOPE,
  instructions: "ORCHESTRATED-FAIL-PASS: implement and review authentication.",
  patchInstructions: "Fix all issues from ORCHESTRATED-FAIL-PASS review.",
};

// Task 5: orchestrated loop — always fails → escalated
const TASK_ORCH_ALWAYS_FAIL = {
  taskId: "fh-orch-always-fail-001",
  mode: "implement",
  orchestratedLoop: true,
  maxReviewIterations: 2,
  scope: SCOPE,
  instructions: "ORCHESTRATED-ALWAYS-FAIL: implement and review rendering module.",
  patchInstructions: "Fix XSS in ORCHESTRATED-ALWAYS-FAIL.",
};

// Task 6: implement — [NEEDS_INPUT] inside code fence → must be completed (not needs_input)
const TASK_IMPL_FENCE = {
  taskId: "fh-impl-false-trigger-fence-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-TRIGGER-FENCE: write integration guide with example marker syntax.",
};

// Task 7: implement — [NEEDS_INPUT] inline in prose sentence → must be completed
const TASK_IMPL_PROSE = {
  taskId: "fh-impl-false-trigger-prose-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-TRIGGER-PROSE: describe the needs_input feature inline.",
};

// Task 8: implement — [NEEDS_INPUT] block at start of line but NO question field → must be completed
const TASK_IMPL_EMPTY = {
  taskId: "fh-impl-false-trigger-empty-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-TRIGGER-EMPTY: output needs_input block without question.",
};

// Task 9: implement — fenced JSON with "question" key (report data) → must be completed
const TASK_IMPL_FENCED_JSON = {
  taskId: "fh-impl-false-fenced-json-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-FENCED-JSON: generate config report with fenced JSON.",
};

// Task 10: implement — plain JSON with "question" key in prose (FAQ) → must be completed
const TASK_IMPL_PLAIN_JSON = {
  taskId: "fh-impl-false-plain-json-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-PLAIN-JSON: add FAQ entry with JSON in output.",
};

// Task 11: implement — NEEDS_INPUT + question as prose words (docs) → must be completed
const TASK_IMPL_HEURISTIC = {
  taskId: "fh-impl-false-heuristic-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-HEURISTIC-TOKEN: describe the needs_input mechanism in docs.",
};

// Task 12: implement — full report, exitCode=0, no structured ask → terminal completed
const TASK_IMPL_FULL_REPORT = {
  taskId: "fh-impl-completed-report-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-COMPLETED-FULL-REPORT: implement auth middleware with full report.",
};

// Task 13: [v3 positive] implement — real [NEEDS_INPUT] block → must be needs_input
const TASK_IMPL_REAL_NI = {
  taskId: "fh-impl-real-needs-input-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-REAL-NEEDS-INPUT: implement feature needing clarification.",
};

// Task 14: [v3 false-positive] implement — [NEEDS_INPUT] in markdown heading → completed
const TASK_IMPL_HEADING = {
  taskId: "fh-impl-false-heading-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-MARKER-IN-HEADING: document the needs_input mechanism.",
};

// Task 15: [v3 false-positive] implement — [NEEDS_INPUT] in multiple code fences → completed
const TASK_IMPL_MULTI_FENCE = {
  taskId: "fh-impl-false-multi-fence-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-MULTI-FENCE: write integration guide with multiple fences.",
};

// Task 16: [v4 forensic] — exact observed regression: "blocks promotion to needs_input."
const TASK_IMPL_BLOCKS_PROSE = {
  taskId: "fh-impl-false-blocks-prose-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-BLOCKS-PROSE: describe the needs_input blocking mechanism.",
};

// Task 17: [v4 forensic] — AskUserQuestion mentioned in report prose (not real denial)
const TASK_IMPL_AUQ_REPORT = {
  taskId: "fh-impl-false-auq-report-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-AUQ-IN-REPORT: generate tool usage report.",
};

// Task 18: [v4 positive] — real AskUserQuestion permission denial → needs_input
const TASK_IMPL_REAL_AUQ = {
  taskId: "fh-impl-real-auq-denial-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-REAL-AUQ-DENIAL: implement feature needing auth provider choice.",
};

// Task 19: [v5 regression] Production-compound false positive: report with all known
// false-positive vectors combined — proves no needs_input event emitted.
const TASK_IMPL_PRODUCTION_COMPOUND = {
  taskId: "fh-impl-false-production-compound-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "IMPL-FALSE-PRODUCTION-COMPOUND: implement needs_input hardening with full report.",
};

// ── State ──────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }

// ── Mock orchestrator ──────────────────────────────────────────────────────────

const PULL_SEQUENCE = [
  TASK_SIMPLE_REVIEW_PASS,
  TASK_SIMPLE_REVIEW_FAIL,
  TASK_ORCH_PASS_FIRST,
  TASK_ORCH_FAIL_PASS,
  TASK_ORCH_ALWAYS_FAIL,
  TASK_IMPL_FENCE,
  TASK_IMPL_PROSE,
  TASK_IMPL_EMPTY,
  TASK_IMPL_FENCED_JSON,
  TASK_IMPL_PLAIN_JSON,
  TASK_IMPL_HEURISTIC,
  TASK_IMPL_FULL_REPORT,
  TASK_IMPL_REAL_NI,
  TASK_IMPL_HEADING,
  TASK_IMPL_MULTI_FENCE,
  TASK_IMPL_BLOCKS_PROSE,
  TASK_IMPL_AUQ_REPORT,
  TASK_IMPL_REAL_AUQ,
  TASK_IMPL_PRODUCTION_COMPOUND,
];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const auth = req.headers.authorization;
    if (auth !== "Bearer test-token") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (req.url === "/api/worker/pull") {
      pullCount++;
      if (pullCount <= PULL_SEQUENCE.length) {
        const task = PULL_SEQUENCE[pullCount - 1];
        console.log(color(36, `\n[orch] → pull ${pullCount}: ${task.taskId} (mode=${task.mode} orchestratedLoop=${!!task.orchestratedLoop})`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      // finish triggered by result count, not by timer
      return;
    }

    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      const statusColor = {
        claimed: 36, started: 36, progress: 33,
        needs_input: 31, review_pass: 32, review_fail: 31,
        review_loop_fail: 31, escalated: 35, completed: 32,
        failed: 31, timeout: 31, context_reset: 34,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} [${ev.taskId}] — ${(ev.message || "").slice(0, 100)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "review_pass" ? 32
        : result.status === "review_fail" ? 31
        : result.status === "escalated" ? 35
        : result.status === "needs_input" ? 31 : 37;
      console.log(color(statusColor, `\n[orch] ← result: taskId=${result.taskId} status=${result.status}`));
      if (result.meta?.reviewIteration !== undefined) {
        console.log(color(37, `[orch]    reviewIteration=${result.meta.reviewIteration}/${result.meta.reviewMaxIterations}`));
      }
      if (result.meta?.escalationReason) {
        console.log(color(35, `[orch]    escalationReason: ${result.meta.escalationReason}`));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (receivedResults.length >= PULL_SEQUENCE.length) {
        process.nextTick(() => finish());
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

// ── Finish + assertions ────────────────────────────────────────────────────────

let _finished = false;
function finish() {
  if (_finished) return;
  _finished = true;
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST RESULTS — Flow Hardening"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) { byTask[r.taskId] = r; }

  const eventsByTask = {};
  for (const e of receivedEvents) {
    if (!eventsByTask[e.taskId]) eventsByTask[e.taskId] = [];
    eventsByTask[e.taskId].push(e);
  }

  const checks = [];

  // ── 1. Simple review pass: must NOT trigger needs_input ──
  const rSRP = byTask["fh-simple-review-pass-001"];
  checks.push({
    name: "[regression] review PASS output → status review_pass (not needs_input)",
    pass: rSRP && rSRP.status === "review_pass",
    detail: rSRP ? `status=${rSRP.status}` : "no result",
  });

  // Confirm no needs_input event was emitted for this task
  const srpNI = (eventsByTask["fh-simple-review-pass-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[regression] review PASS output → no needs_input event emitted",
    pass: !srpNI,
    detail: srpNI ? `FOUND needs_input event (bad!)` : "correct: not found",
  });

  // ── 2. Simple review fail: must NOT trigger needs_input ──
  const rSRF = byTask["fh-simple-review-fail-001"];
  checks.push({
    name: "[regression] review FAIL output → status review_fail (not needs_input)",
    pass: rSRF && rSRF.status === "review_fail",
    detail: rSRF ? `status=${rSRF.status}` : "no result",
  });

  const srfNI = (eventsByTask["fh-simple-review-fail-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[regression] review FAIL output → no needs_input event emitted",
    pass: !srfNI,
    detail: srfNI ? `FOUND needs_input event (bad!)` : "correct: not found",
  });

  // ── 3. Orchestrated loop: pass on first review ──
  const rOPF = byTask["fh-orch-pass-first-001"];
  checks.push({
    name: "[orchestrated:pass-first] → review_pass",
    pass: rOPF && rOPF.status === "review_pass",
    detail: rOPF ? `status=${rOPF.status}` : "no result",
  });
  checks.push({
    name: "[orchestrated:pass-first] review_pass at iter 1",
    pass: rOPF && rOPF.meta?.reviewIteration === 1,
    detail: rOPF ? `reviewIteration=${rOPF.meta?.reviewIteration}` : "no result",
  });

  // context_reset events emitted for implement + review phases
  const crEventsOPF = (eventsByTask["fh-orch-pass-first-001"] || []).filter(e => e.status === "context_reset");
  checks.push({
    name: "[orchestrated:pass-first] context_reset events emitted (≥2: implement + review)",
    pass: crEventsOPF.length >= 2,
    detail: `context_reset count=${crEventsOPF.length}`,
  });

  // no needs_input for orchestrated task
  const opfNI = (eventsByTask["fh-orch-pass-first-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[orchestrated:pass-first] no spurious needs_input",
    pass: !opfNI,
    detail: opfNI ? "FOUND needs_input (bad!)" : "correct: not found",
  });

  // ── 4. Orchestrated loop: fail → patch → pass ──
  const rOFP = byTask["fh-orch-fail-pass-001"];
  checks.push({
    name: "[orchestrated:fail-pass] → review_pass",
    pass: rOFP && rOFP.status === "review_pass",
    detail: rOFP ? `status=${rOFP.status}` : "no result",
  });
  checks.push({
    name: "[orchestrated:fail-pass] review_pass at iter 2",
    pass: rOFP && rOFP.meta?.reviewIteration === 2,
    detail: rOFP ? `reviewIteration=${rOFP.meta?.reviewIteration}` : "no result",
  });

  // review_loop_fail event emitted for first failed iteration
  const rlfOFP = (eventsByTask["fh-orch-fail-pass-001"] || []).find(e => e.status === "review_loop_fail");
  checks.push({
    name: "[orchestrated:fail-pass] review_loop_fail event emitted for iter 1",
    pass: !!rlfOFP,
    detail: rlfOFP ? `msg=${(rlfOFP.message || "").slice(0, 80)}` : "not found",
  });

  // context_reset events: implement + review(1) + patch + review(2) = 4
  const crEventsOFP = (eventsByTask["fh-orch-fail-pass-001"] || []).filter(e => e.status === "context_reset");
  checks.push({
    name: "[orchestrated:fail-pass] context_reset events (≥4: impl+rev+patch+re-rev)",
    pass: crEventsOFP.length >= 4,
    detail: `context_reset count=${crEventsOFP.length}`,
  });

  // structuredFindings propagated via review_loop_fail event
  checks.push({
    name: "[orchestrated:fail-pass] review_loop_fail event carries structuredFindings",
    pass: rlfOFP && Array.isArray(rlfOFP.meta?.structuredFindings) && rlfOFP.meta.structuredFindings.length > 0,
    detail: rlfOFP ? `structuredFindings count=${rlfOFP.meta?.structuredFindings?.length ?? "missing"}` : "no event",
  });

  // ── 5. Orchestrated loop: always-fail → escalated ──
  const rOAF = byTask["fh-orch-always-fail-001"];
  checks.push({
    name: "[orchestrated:always-fail] → escalated",
    pass: rOAF && rOAF.status === "escalated",
    detail: rOAF ? `status=${rOAF.status}` : "no result",
  });
  checks.push({
    name: "[orchestrated:always-fail] escalated after iter 2 (maxIter=2)",
    pass: rOAF && rOAF.meta?.reviewIteration === 2,
    detail: rOAF ? `reviewIteration=${rOAF.meta?.reviewIteration}` : "no result",
  });
  checks.push({
    name: "[orchestrated:always-fail] meta.escalationReason present",
    pass: rOAF && typeof rOAF.meta?.escalationReason === "string" && rOAF.meta.escalationReason.length > 0,
    detail: rOAF ? `reason="${rOAF.meta?.escalationReason}"` : "no result",
  });

  const escalatedEv = (eventsByTask["fh-orch-always-fail-001"] || []).find(e => e.status === "escalated");
  checks.push({
    name: "[orchestrated:always-fail] escalated event emitted",
    pass: !!escalatedEv,
    detail: escalatedEv ? `msg=${(escalatedEv.message || "").slice(0, 80)}` : "not found",
  });

  // ── 6. Implement: [NEEDS_INPUT] inside code fence → completed, not needs_input ──
  const rFence = byTask["fh-impl-false-trigger-fence-001"];
  checks.push({
    name: "[false-trigger:fence] [NEEDS_INPUT] in code fence → status completed",
    pass: rFence && rFence.status === "completed",
    detail: rFence ? `status=${rFence.status}` : "no result",
  });
  const fenceNI = (eventsByTask["fh-impl-false-trigger-fence-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[false-trigger:fence] no needs_input event emitted",
    pass: !fenceNI,
    detail: fenceNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 7. Implement: [NEEDS_INPUT] inline in prose → completed, not needs_input ──
  const rProse = byTask["fh-impl-false-trigger-prose-001"];
  checks.push({
    name: "[false-trigger:prose] [NEEDS_INPUT] inline in sentence → status completed",
    pass: rProse && rProse.status === "completed",
    detail: rProse ? `status=${rProse.status}` : "no result",
  });
  const proseNI = (eventsByTask["fh-impl-false-trigger-prose-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[false-trigger:prose] no needs_input event emitted",
    pass: !proseNI,
    detail: proseNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 8. Implement: [NEEDS_INPUT] at line start but no question field → completed ──
  const rEmpty = byTask["fh-impl-false-trigger-empty-001"];
  checks.push({
    name: "[false-trigger:empty] [NEEDS_INPUT] block without question → status completed",
    pass: rEmpty && rEmpty.status === "completed",
    detail: rEmpty ? `status=${rEmpty.status}` : "no result",
  });
  const emptyNI = (eventsByTask["fh-impl-false-trigger-empty-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[false-trigger:empty] no needs_input event emitted",
    pass: !emptyNI,
    detail: emptyNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 9. Implement: fenced JSON with "question" key → completed, not needs_input ──
  const rFencedJson = byTask["fh-impl-false-fenced-json-001"];
  checks.push({
    name: "[false-trigger:fenced-json] fenced JSON with question key → status completed",
    pass: rFencedJson && rFencedJson.status === "completed",
    detail: rFencedJson ? `status=${rFencedJson.status}` : "no result",
  });
  const fencedJsonNI = (eventsByTask["fh-impl-false-fenced-json-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[false-trigger:fenced-json] no needs_input event emitted",
    pass: !fencedJsonNI,
    detail: fencedJsonNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 10. Implement: plain JSON with "question" key → completed, not needs_input ──
  const rPlainJson = byTask["fh-impl-false-plain-json-001"];
  checks.push({
    name: "[false-trigger:plain-json] plain JSON with question key → status completed",
    pass: rPlainJson && rPlainJson.status === "completed",
    detail: rPlainJson ? `status=${rPlainJson.status}` : "no result",
  });
  const plainJsonNI = (eventsByTask["fh-impl-false-plain-json-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[false-trigger:plain-json] no needs_input event emitted",
    pass: !plainJsonNI,
    detail: plainJsonNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 11. Implement: NEEDS_INPUT + question as prose → completed, not needs_input ──
  const rHeuristic = byTask["fh-impl-false-heuristic-001"];
  checks.push({
    name: "[false-trigger:heuristic] NEEDS_INPUT+question in prose → status completed",
    pass: rHeuristic && rHeuristic.status === "completed",
    detail: rHeuristic ? `status=${rHeuristic.status}` : "no result",
  });
  const heuristicNI = (eventsByTask["fh-impl-false-heuristic-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[false-trigger:heuristic] no needs_input event emitted",
    pass: !heuristicNI,
    detail: heuristicNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 12. Implement: full report + exitCode=0 + no structured ask → terminal completed ──
  const rFullReport = byTask["fh-impl-completed-report-001"];
  checks.push({
    name: "[completed-report] exitCode=0 full report → status completed (terminal)",
    pass: rFullReport && rFullReport.status === "completed",
    detail: rFullReport ? `status=${rFullReport.status}` : "no result",
  });
  const fullReportNI = (eventsByTask["fh-impl-completed-report-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[completed-report] no needs_input event (never converted)",
    pass: !fullReportNI,
    detail: fullReportNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });
  // Verify completed event WAS emitted (terminal status)
  const fullReportCompleted = (eventsByTask["fh-impl-completed-report-001"] || []).find(e => e.status === "completed");
  checks.push({
    name: "[completed-report] completed event emitted (confirms terminal status)",
    pass: !!fullReportCompleted,
    detail: fullReportCompleted ? "correct: completed event found" : "not found",
  });

  // ── 13. [v3 positive] Real [NEEDS_INPUT] block → must trigger needs_input ──
  const rRealNI = byTask["fh-impl-real-needs-input-001"];
  checks.push({
    name: "[v3:positive] real [NEEDS_INPUT] block → status needs_input",
    pass: rRealNI && rRealNI.status === "needs_input",
    detail: rRealNI ? `status=${rRealNI.status}` : "no result",
  });
  checks.push({
    name: "[v3:positive] question field populated correctly",
    pass: rRealNI && rRealNI.question === "Which database engine should I use?",
    detail: rRealNI ? `question=${rRealNI.question}` : "no result",
  });
  checks.push({
    name: "[v3:positive] options field populated",
    pass: rRealNI && Array.isArray(rRealNI.options) && rRealNI.options.length > 0,
    detail: rRealNI ? `options=${JSON.stringify(rRealNI.options)}` : "no result",
  });
  checks.push({
    name: "[v3:positive] context field populated",
    pass: rRealNI && rRealNI.context === "The project has no existing database configuration.",
    detail: rRealNI ? `context=${rRealNI.context}` : "no result",
  });
  const realNIEvent = (eventsByTask["fh-impl-real-needs-input-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[v3:positive] needs_input event emitted",
    pass: !!realNIEvent,
    detail: realNIEvent ? "correct: needs_input event found" : "not found",
  });

  // ── 14. [v3 false-positive] [NEEDS_INPUT] in markdown heading → completed ──
  const rHeading = byTask["fh-impl-false-heading-001"];
  checks.push({
    name: "[v3:heading] [NEEDS_INPUT] in heading → status completed",
    pass: rHeading && rHeading.status === "completed",
    detail: rHeading ? `status=${rHeading.status}` : "no result",
  });
  const headingNI = (eventsByTask["fh-impl-false-heading-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[v3:heading] no needs_input event emitted",
    pass: !headingNI,
    detail: headingNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 15. [v3 false-positive] [NEEDS_INPUT] in multiple code fences → completed ──
  const rMultiFence = byTask["fh-impl-false-multi-fence-001"];
  checks.push({
    name: "[v3:multi-fence] [NEEDS_INPUT] across fences → status completed",
    pass: rMultiFence && rMultiFence.status === "completed",
    detail: rMultiFence ? `status=${rMultiFence.status}` : "no result",
  });
  const multiFenceNI = (eventsByTask["fh-impl-false-multi-fence-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[v3:multi-fence] no needs_input event emitted",
    pass: !multiFenceNI,
    detail: multiFenceNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 16. [v4 forensic] "blocks promotion to needs_input." prose → completed, NOT needs_input ──
  const rBlocksProse = byTask["fh-impl-false-blocks-prose-001"];
  checks.push({
    name: "[v4:forensic] 'blocks promotion to needs_input' prose → status completed",
    pass: rBlocksProse && rBlocksProse.status === "completed",
    detail: rBlocksProse ? `status=${rBlocksProse.status}` : "no result",
  });
  const blocksProseNI = (eventsByTask["fh-impl-false-blocks-prose-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[v4:forensic] no needs_input event for prose-only NEEDS_INPUT mention",
    pass: !blocksProseNI,
    detail: blocksProseNI ? "FOUND needs_input event (bad! — this was the observed regression)" : "correct: not found",
  });

  // ── 17. [v4 forensic] AskUserQuestion mentioned in report prose → completed, NOT needs_input ──
  const rAuqReport = byTask["fh-impl-false-auq-report-001"];
  checks.push({
    name: "[v4:forensic] AskUserQuestion in prose report → status completed",
    pass: rAuqReport && rAuqReport.status === "completed",
    detail: rAuqReport ? `status=${rAuqReport.status}` : "no result",
  });
  const auqReportNI = (eventsByTask["fh-impl-false-auq-report-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[v4:forensic] no needs_input event for AskUserQuestion prose mention",
    pass: !auqReportNI,
    detail: auqReportNI ? "FOUND needs_input event (bad!)" : "correct: not found",
  });

  // ── 18. [v4 positive] Real AskUserQuestion permission denial → must trigger needs_input ──
  const rRealAuq = byTask["fh-impl-real-auq-denial-001"];
  checks.push({
    name: "[v4:positive] real AskUserQuestion denial → status needs_input",
    pass: rRealAuq && rRealAuq.status === "needs_input",
    detail: rRealAuq ? `status=${rRealAuq.status}` : "no result",
  });
  checks.push({
    name: "[v4:positive] AUQ question field populated",
    pass: rRealAuq && rRealAuq.question === "Which authentication provider should I integrate?",
    detail: rRealAuq ? `question=${rRealAuq.question}` : "no result",
  });
  checks.push({
    name: "[v4:positive] AUQ options populated from tool_input",
    pass: rRealAuq && Array.isArray(rRealAuq.options) && rRealAuq.options.length === 3,
    detail: rRealAuq ? `options=${JSON.stringify(rRealAuq.options)}` : "no result",
  });
  const realAuqEvent = (eventsByTask["fh-impl-real-auq-denial-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[v4:positive] needs_input event emitted for real AUQ denial",
    pass: !!realAuqEvent,
    detail: realAuqEvent ? "correct: needs_input event found" : "not found",
  });

  // ── 19. [v5 regression] Production-compound false positive → completed, zero needs_input events ──
  const rProdCompound = byTask["fh-impl-false-production-compound-001"];
  checks.push({
    name: "[v5:production-compound] report with all false-positive vectors → status completed",
    pass: rProdCompound && rProdCompound.status === "completed",
    detail: rProdCompound ? `status=${rProdCompound.status}` : "no result",
  });
  const prodCompoundNI = (eventsByTask["fh-impl-false-production-compound-001"] || []).find(e => e.status === "needs_input");
  checks.push({
    name: "[v5:production-compound] zero needs_input events emitted (false notification eliminated)",
    pass: !prodCompoundNI,
    detail: prodCompoundNI ? "FOUND needs_input event (bad! — false notification)" : "correct: not found",
  });
  const prodCompoundCompleted = (eventsByTask["fh-impl-false-production-compound-001"] || []).find(e => e.status === "completed");
  checks.push({
    name: "[v5:production-compound] completed event emitted (correct terminal status)",
    pass: !!prodCompoundCompleted,
    detail: prodCompoundCompleted ? "correct: completed event found" : "not found",
  });
  // Verify result body does NOT contain hoisted needs_input fields
  checks.push({
    name: "[v5:production-compound] result body has no hoisted question/needsInputAt fields",
    pass: rProdCompound && rProdCompound.question === undefined && rProdCompound.needsInputAt === undefined,
    detail: rProdCompound
      ? `question=${rProdCompound.question}, needsInputAt=${rProdCompound.needsInputAt}`
      : "no result",
  });

  // ── Print results ──
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon}  ${c.name}`);
    console.log(`         ${color(37, c.detail)}`);
    if (!c.pass) allPass = false;
  }

  console.log(color(36, "\n" + "=".repeat(60)));
  if (allPass) {
    console.log(color(32, "ALL CHECKS PASSED"));
  } else {
    console.log(color(31, "SOME CHECKS FAILED"));
  }
  console.log(color(36, "=".repeat(60) + "\n"));

  if (worker) worker.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
  process.exit(allPass ? 0 : 1);
}

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(color(36, `[orch] mock orchestrator on http://localhost:${PORT}`));
  console.log(color(36, `[orch] mock claude: ${mockClaudePath}`));
  console.log(color(36, `[orch] mock repo:   ${mockRepoDir}`));
  console.log(color(36, "[orch] spawning worker...\n"));

  worker = spawn("node", ["worker.js"], {
    cwd: path.join(__dirname),
    env: {
      ...process.env,
      REPORT_SCHEMA_STRICT: "false",
      REPORT_CONTRACT_ENABLED: "false",
      ORCH_BASE_URL: `http://localhost:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-fh",
      POLL_INTERVAL_MS: "500",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "30000",
      CLAUDE_BYPASS_PERMISSIONS: "false",
      NEEDS_INPUT_DEBUG: "true",
      MAX_PARALLEL_WORKTREES: "1",
    },
    stdio: "inherit",
  });

  worker.on("close", (code) => {
    console.log(color(37, `\n[orch] worker exited with code ${code}`));
  });

  setTimeout(() => {
    console.log(color(31, "\n[orch] TIMEOUT — test took too long, aborting"));
    if (worker) worker.kill("SIGKILL");
    server.close();
    try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
    try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
    process.exit(1);
  }, 120000);
});
