#!/usr/bin/env node
"use strict";

/**
 * Smoke test: Telegram notifier UX polish (Stage 4)
 *
 * Validates:
 *   1. shouldSuppress — correct suppression of technical/noisy events
 *   2. formatMessage  — correct user-facing labels and content per status
 *   3. Before/After behavior table printed to stdout as evidence
 */

// Stub env vars so notifier.js loads without crashing
process.env.NOTIFIER_SECRET    = "test-secret";
process.env.TELEGRAM_BOT_TOKEN = "123:test";
process.env.TELEGRAM_CHAT_ID   = "9999";

const { shouldSuppress, formatMessage, STATUS_LABELS } = require("./notifier/notifier");

let pass = 0;
let fail = 0;

function check(description, actual, expected) {
  const ok = actual === expected;
  if (ok) {
    console.log(`  ✓ ${description}`);
    pass++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    fail++;
  }
}

function checkIncludes(description, actual, substr) {
  const ok = typeof actual === "string" && actual.includes(substr);
  if (ok) {
    console.log(`  ✓ ${description}`);
    pass++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected to include: ${JSON.stringify(substr)}`);
    console.error(`    actual: ${JSON.stringify(actual)}`);
    fail++;
  }
}

function checkNotIncludes(description, actual, substr) {
  const ok = typeof actual === "string" && !actual.includes(substr);
  if (ok) {
    console.log(`  ✓ ${description}`);
    pass++;
  } else {
    console.error(`  ✗ ${description}`);
    console.error(`    expected NOT to include: ${JSON.stringify(substr)}`);
    console.error(`    actual: ${JSON.stringify(actual)}`);
    fail++;
  }
}

// ── BEFORE/AFTER TABLE ──────────────────────────────────────────────────────

console.log("\n=== Stage 4 — Telegram UX Polish: Before vs After ===\n");

const allEvents = [
  // status             phase            suppressed_before  suppressed_after
  ["claimed",           "pull",          false,             false],
  ["started",           "validate",      false,             true ],   // NEW: suppress
  ["progress",          "plan",          false,             true ],   // NEW: suppress
  ["progress",          "validate",      false,             true ],   // NEW: suppress
  ["progress",          "git",           false,             true ],   // NEW: suppress
  ["progress",          "claude",        false,             true ],   // NEW: suppress
  ["keepalive",         "claude",        false,             true ],   // NEW: suppress
  ["risk",              "claude",        false,             true ],   // NEW: suppress
  ["progress",          "review_loop",   false,             true ],   // NEW: suppress
  ["review_loop_fail",  "report",        false,             false],
  ["review_pass",       "report",        false,             false],
  ["review_fail",       "report",        false,             false],
  ["escalated",         "report",        false,             false],
  ["needs_input",       "claude",        false,             false],
  ["progress",          "report",        false,             true ],   // NEW: suppress
  ["completed",         "report",        false,             false],
  ["failed",            "report",        false,             false],
  ["timeout",           "claude",        false,             false],
  ["rejected",          "validate",      false,             false],
  ["resumed",           "report",        false,             false],
];

console.log("  Event                       Phase           Before  After");
console.log("  " + "─".repeat(65));
for (const [status, phase, before, after] of allEvents) {
  const ev = { status, phase };
  const actualAfter = shouldSuppress(ev);
  const beforeStr = before ? "SEND  " : "SEND  ";  // before: everything sent
  const afterStr  = actualAfter ? "SUPPRESS" : "SEND    ";
  const change    = !before && actualAfter ? " ← filtered" : "";
  const row = `  ${(status + "/" + phase).padEnd(30)}${beforeStr}  ${afterStr}${change}`;
  console.log(row);
  // Verify against expectation
  if (actualAfter !== after) {
    console.error(`  ^^^ MISMATCH: expected shouldSuppress=${after}, got ${actualAfter}`);
    fail++;
  } else {
    pass++;
  }
}
console.log();

// ── SECTION 1: shouldSuppress ───────────────────────────────────────────────

console.log("── shouldSuppress ─────────────────────────────────────────────");

// Must suppress
check("started/validate",        shouldSuppress({ status: "started",   phase: "validate"     }), true);
check("keepalive/claude",        shouldSuppress({ status: "keepalive", phase: "claude"       }), true);
check("risk/claude",             shouldSuppress({ status: "risk",      phase: "claude"       }), true);
check("progress/plan",           shouldSuppress({ status: "progress",  phase: "plan"         }), true);
check("progress/validate",       shouldSuppress({ status: "progress",  phase: "validate"     }), true);
check("progress/git",            shouldSuppress({ status: "progress",  phase: "git"          }), true);
check("progress/claude",         shouldSuppress({ status: "progress",  phase: "claude"       }), true);
check("progress/report",         shouldSuppress({ status: "progress",  phase: "report"       }), true);
check("progress/review_loop",    shouldSuppress({ status: "progress",  phase: "review_loop"  }), true);

// Must NOT suppress
check("claimed/pull",            shouldSuppress({ status: "claimed",          phase: "pull"    }), false);
check("needs_input/claude",      shouldSuppress({ status: "needs_input",      phase: "claude"  }), false);
check("review_pass/report",      shouldSuppress({ status: "review_pass",      phase: "report"  }), false);
check("review_fail/report",      shouldSuppress({ status: "review_fail",      phase: "report"  }), false);
check("review_loop_fail/report", shouldSuppress({ status: "review_loop_fail", phase: "report"  }), false);
check("escalated/report",        shouldSuppress({ status: "escalated",        phase: "report"  }), false);
check("completed/report",        shouldSuppress({ status: "completed",        phase: "report"  }), false);
check("failed/report",           shouldSuppress({ status: "failed",           phase: "report"  }), false);
check("timeout/claude",          shouldSuppress({ status: "timeout",          phase: "claude"  }), false);
check("rejected/validate",       shouldSuppress({ status: "rejected",         phase: "validate"}), false);
check("resumed/report",          shouldSuppress({ status: "resumed",          phase: "report"  }), false);

console.log();

// ── SECTION 2: formatMessage ────────────────────────────────────────────────

console.log("── formatMessage: user-facing labels ─────────────────────────");

// claimed
{
  const msg = formatMessage({ taskId: "t-001", status: "claimed", phase: "pull", workerId: "macbook-sigma" });
  checkIncludes("claimed: contains 'Задача получена'",     msg, "Задача получена");
  checkIncludes("claimed: contains taskId",                msg, "t-001");
  checkIncludes("claimed: contains workerId",              msg, "macbook-sigma");
  checkNotIncludes("claimed: no raw status string",        msg, "[claimed/pull]");
}

// needs_input
{
  const msg = formatMessage({
    taskId: "t-002", status: "needs_input", phase: "claude",
    message: "needs input: Which DB?",
    meta: { question: "Which database should I use?", options: ["PostgreSQL", "SQLite"], needsInputAt: "2026-03-05T10:00:00Z" },
  });
  checkIncludes("needs_input: label 'Нужен ответ'",        msg, "Нужен ответ");
  checkIncludes("needs_input: question shown",             msg, "Which database should I use?");
  checkIncludes("needs_input: option 1 shown",             msg, "1. PostgreSQL");
  checkIncludes("needs_input: option 2 shown",             msg, "2. SQLite");
}

// review_pass
{
  const msg = formatMessage({
    taskId: "t-003", status: "review_pass", phase: "report",
    message: "review passed (iter 2/3)",
    meta: { reviewIteration: 2, reviewMaxIterations: 3, reviewLoopDurationMs: 45200 },
  });
  checkIncludes("review_pass: label 'Review pass'",        msg, "Review pass");
  checkIncludes("review_pass: iter info shown",            msg, "iter 2/3");
  checkIncludes("review_pass: duration shown",             msg, "45.2s");
}

// review_fail
{
  const sf = [
    { id: "F1", severity: "major", file: "auth.js", issue: "SQL injection", risk: "high", required_fix: "use prepared statements", acceptance_check: "no raw queries" },
    { id: "F2", severity: "minor", file: "utils.js", issue: "unused import", risk: "low", required_fix: "remove import", acceptance_check: "no unused" },
  ];
  const msg = formatMessage({
    taskId: "t-004", status: "review_fail", phase: "report",
    message: "review failed (major): SQL injection risk",
    meta: { reviewSeverity: "major", reviewFindings: "SQL injection in auth.js", structuredFindings: sf },
  });
  checkIncludes("review_fail: label 'Review не прошёл'",   msg, "Review не прошёл");
  checkIncludes("review_fail: severity shown",             msg, "major");
  checkIncludes("review_fail: findings snippet",           msg, "SQL injection");
  checkIncludes("review_fail: finding count",              msg, "2 finding(s)");
}

// review_loop_fail
{
  const sf = [{ id: "F1", severity: "critical", file: "x.js", issue: "XSS", risk: "high", required_fix: "sanitize", acceptance_check: "no XSS" }];
  const msg = formatMessage({
    taskId: "t-005", status: "review_loop_fail", phase: "report",
    message: "review failed (iter 1/3), severity=critical",
    meta: { iteration: 1, maxIter: 3, reviewSeverity: "critical", reviewFindings: "XSS in x.js", structuredFindings: sf },
  });
  checkIncludes("review_loop_fail: label 'Нужен patch'",   msg, "Нужен patch");
  checkIncludes("review_loop_fail: iter info",             msg, "Iter 1/3");
  checkIncludes("review_loop_fail: severity",              msg, "critical");
  checkIncludes("review_loop_fail: findings snippet",      msg, "XSS in x.js");
  checkIncludes("review_loop_fail: patch notice",          msg, "patch будет применён");
}

// escalated
{
  const sf = [{ id: "F1", severity: "major", file: "a.js", issue: "bug", risk: "high", required_fix: "fix", acceptance_check: "pass" }];
  const msg = formatMessage({
    taskId: "t-006", status: "escalated", phase: "report",
    message: "review loop escalated after 3/3 iterations",
    meta: { escalationReason: "max review iterations (3) reached without passing", structuredFindings: sf, reviewLoopDurationMs: 120000 },
  });
  checkIncludes("escalated: label 'Эскалация'",            msg, "Эскалация");
  checkIncludes("escalated: reason shown",                 msg, "max review iterations");
  checkIncludes("escalated: unresolved finding count",     msg, "1 unresolved finding(s)");
  checkIncludes("escalated: duration shown",               msg, "120.0s");
}

// completed
{
  const msg = formatMessage({
    taskId: "t-007", status: "completed", phase: "report",
    message: "task completed",
    meta: { durationMs: 30300, exitCode: 0 },
  });
  checkIncludes("completed: label 'Выполнено'",            msg, "Выполнено");
  checkIncludes("completed: duration shown",               msg, "30.3s");
  checkIncludes("completed: exitCode shown",               msg, "exit:0");
}

// failed
{
  const msg = formatMessage({
    taskId: "t-008", status: "failed", phase: "report",
    message: "TypeError: Cannot read properties of undefined",
    meta: { durationMs: 5000, exitCode: 1 },
  });
  checkIncludes("failed: label 'Ошибка'",                  msg, "Ошибка");
  checkIncludes("failed: duration shown",                  msg, "5.0s");
  checkIncludes("failed: message shown (non-generic)",     msg, "TypeError");
}

// failed generic message (must not show "task failed")
{
  const msg = formatMessage({
    taskId: "t-009", status: "failed", phase: "report",
    message: "task failed",
    meta: { durationMs: 5000, exitCode: 1 },
  });
  checkNotIncludes("failed: generic 'task failed' not repeated", msg, "task failed");
}

// timeout
{
  const msg = formatMessage({
    taskId: "t-010", status: "timeout", phase: "claude",
    message: "claude process timed out",
    meta: { timeoutMs: 180000 },
  });
  checkIncludes("timeout: label 'Таймаут'",                msg, "Таймаут");
  checkIncludes("timeout: timeout value shown",            msg, "after 180s");
}

// rejected
{
  const msg = formatMessage({
    taskId: "t-011", status: "rejected", phase: "validate",
    message: "repoPath not in allowlist",
    meta: { errors: ["repoPath not in allowlist: /tmp/evil"] },
  });
  checkIncludes("rejected: label 'Отклонено'",             msg, "Отклонено");
  checkIncludes("rejected: error shown",                   msg, "repoPath not in allowlist");
}

// resumed
{
  const msg = formatMessage({
    taskId: "t-012", status: "resumed", phase: "report",
    message: "resumed by sigma: PostgreSQL",
    meta: { answeredBy: "sigma" },
  });
  checkIncludes("resumed: label 'Возобновлено'",           msg, "Возобновлено");
  checkIncludes("resumed: answeredBy shown",               msg, "sigma");
}

console.log();

// ── SECTION 3: HTML escaping of proof fields ─────────────────────────────────

console.log("── proof fields: HTML safety ──────────────────────────────────");

{
  const msg = formatMessage({
    taskId: "t-xss",
    status: "review_fail",
    phase: "report",
    meta: {
      reviewSeverity: "major",
      reviewFindings: "XSS <script>alert('x')</script> in template",
      structuredFindings: null,
    },
  });
  checkNotIncludes("HTML-escaped: no raw <script>", msg, "<script>");
  checkIncludes("HTML-escaped: &lt;script&gt; present", msg, "&lt;script&gt;");
}

console.log();

// ── SECTION 4: STATUS_LABELS completeness ────────────────────────────────────

console.log("── STATUS_LABELS coverage ─────────────────────────────────────");

const expectedStatuses = [
  "claimed", "needs_input", "review_pass", "review_fail",
  "review_loop_fail", "escalated", "completed", "failed",
  "timeout", "rejected", "resumed",
];
for (const s of expectedStatuses) {
  check(`STATUS_LABELS has '${s}'`, s in STATUS_LABELS, true);
}

console.log();

// ── SUMMARY ──────────────────────────────────────────────────────────────────

const total = pass + fail;
console.log(`=== Results: ${pass}/${total} passed${fail > 0 ? ` · ${fail} FAILED` : ""} ===\n`);
if (fail > 0) {
  console.error(`SMOKE TEST FAILED: ${fail} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("SMOKE TEST PASSED");
  process.exit(0);
}
