#!/usr/bin/env node
"use strict";

/**
 * Unit tests for parseNeedsInput / extractClaudeResult.
 *
 * Loads the functions from worker.js via a small eval trick (worker.js is not
 * a module), then runs edge-case scenarios.
 *
 * Usage: node test-parser.js
 */

const fs = require("fs");
const path = require("path");

// ── Extract functions from worker.js without running mainLoop ──
// We source only the pure functions we need.

const src = fs.readFileSync(path.join(__dirname, "worker.js"), "utf-8");

// Extract NEEDS_INPUT_RE, extractClaudeResult, parseNeedsInput
const extractBlock = src.slice(
  src.indexOf("const NEEDS_INPUT_RE"),
  src.indexOf("// ── EXECUTE")
);

// Create a sandbox with the functions
const sandbox = {};
const fn = new Function(
  "module", "exports", "require", "__filename", "__dirname",
  "const CFG = { needsInputDebug: false };\n"
  + "function niDebug() {}\n"
  + extractBlock
  + "\nmodule.exports = { extractClaudeResult, parseNeedsInput, normalizeOptions, extractAskUserQuestion };"
);
fn(sandbox, {}, require, __filename, __dirname);
const { extractClaudeResult, parseNeedsInput, normalizeOptions, extractAskUserQuestion } = sandbox.exports;

// ── Test harness ──

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    console.log(`         ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEq(a, b, label) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${label || ""}: ${sa} !== ${sb}`);
}

// ── Tests ──

console.log("\n\x1b[36m=== extractClaudeResult ===\x1b[0m\n");

test("single JSON object with result field", () => {
  const stdout = JSON.stringify({
    type: "result", result: "hello world", cost_usd: 0.01,
  });
  assertEq(extractClaudeResult(stdout), "hello world");
});

test("JSONL — multiple lines, picks last with result field", () => {
  const lines = [
    JSON.stringify({ type: "assistant", content: "thinking..." }),
    JSON.stringify({ type: "tool_use", name: "read_file" }),
    JSON.stringify({ type: "result", subtype: "success", result: "final answer" }),
  ];
  assertEq(extractClaudeResult(lines.join("\n")), "final answer");
});

test("JSONL — result field in middle, ignored later lines without result", () => {
  const lines = [
    JSON.stringify({ type: "result", result: "the answer" }),
    JSON.stringify({ type: "usage", tokens: 500 }),
  ];
  // Scans backwards: "usage" line has no result, skips; "result" line found
  assertEq(extractClaudeResult(lines.join("\n")), "the answer");
});

test("plain text — returns null", () => {
  assertEq(extractClaudeResult("just some plain text"), null);
});

test("invalid JSON — returns null", () => {
  assertEq(extractClaudeResult("{broken json"), null);
});

test("JSON without result field — returns null", () => {
  const stdout = JSON.stringify({ type: "error", message: "oops" });
  assertEq(extractClaudeResult(stdout), null);
});

console.log("\n\x1b[36m=== parseNeedsInput ===\x1b[0m\n");

test("standard single-JSON marker with all fields", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "I need help.\n\n[NEEDS_INPUT]\nquestion: Which DB?\noptions: pg, mysql, sqlite\ncontext: no db configured\n[/NEEDS_INPUT]\n",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "should not be null");
  assertEq(ni.question, "Which DB?", "question");
  assertEq(ni.options, ["pg", "mysql", "sqlite"], "options");
  assertEq(ni.context, "no db configured", "context");
});

test("marker with question only, no options/context", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "text\n[NEEDS_INPUT]\nquestion: Should I continue?\n[/NEEDS_INPUT]\n",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null);
  assertEq(ni.question, "Should I continue?", "question");
  assertEq(ni.options, null, "options");
  assertEq(ni.context, null, "context");
});

test("JSONL output with marker in last result line", () => {
  const lines = [
    JSON.stringify({ type: "assistant", content: "working..." }),
    JSON.stringify({
      type: "result",
      result: "Need info\n[NEEDS_INPUT]\nquestion: What format?\noptions: yaml, json\ncontext: no config\n[/NEEDS_INPUT]",
    }),
  ];
  const ni = parseNeedsInput(lines.join("\n"));
  assert(ni !== null, "should detect in JSONL");
  assertEq(ni.question, "What format?", "question");
  assertEq(ni.options, ["yaml", "json"], "options");
});

test("raw text fallback (non-JSON stdout)", () => {
  const stdout = "Some raw output\n[NEEDS_INPUT]\nquestion: What now?\n[/NEEDS_INPUT]\n";
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "should detect in raw text");
  assertEq(ni.question, "What now?", "question");
});

test("malformed marker — no question line → fallback", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "hmm\n[NEEDS_INPUT]\njust some text without question: prefix\n[/NEEDS_INPUT]",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "should not be null — marker was found");
  assertEq(ni.question, "Clarification required", "fallback question");
  assertEq(ni.options, null, "no options");
  assertEq(ni.sourceType, "strict", "sourceType");
});

test("no marker at all → null", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "All good, task completed successfully.",
  });
  assertEq(parseNeedsInput(stdout), null);
});

test("marker without closing tag → heuristic fallback (has NEEDS_INPUT + question)", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "text [NEEDS_INPUT]\nquestion: orphan marker that is long enough",
  });
  const ni = parseNeedsInput(stdout);
  // No closing tag → strict fails, but heuristic D catches NEEDS_INPUT + question
  assert(ni !== null, "heuristic should catch");
  assertEq(ni.sourceType, "heuristic", "sourceType");
});

test("marker immediately after tag (no newline)", () => {
  // [NEEDS_INPUT]question: inline?[/NEEDS_INPUT]
  const stdout = JSON.stringify({
    type: "result",
    result: "[NEEDS_INPUT]question: inline?[/NEEDS_INPUT]",
  });
  const ni = parseNeedsInput(stdout);
  // The block is "question: inline?" — single line, no leading newline needed
  assert(ni !== null, "should match");
  assertEq(ni.question, "inline?", "question");
});

test("marker with extra whitespace and blank lines", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "[NEEDS_INPUT]  \n\n  question:  Spaced out?  \n  options:  a , b , c  \n\n  context:  extra spaces  \n\n[/NEEDS_INPUT]",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null);
  assertEq(ni.question, "Spaced out?", "question trimmed");
  assertEq(ni.options, ["a", "b", "c"], "options trimmed");
  assertEq(ni.context, "extra spaces", "context trimmed");
});

// ── sourceType tracking ──

console.log("\n\x1b[36m=== sourceType ===\x1b[0m\n");

test("strict marker → sourceType=strict", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "[NEEDS_INPUT]\nquestion: Which DB?\n[/NEEDS_INPUT]",
  });
  assertEq(parseNeedsInput(stdout).sourceType, "strict");
});

test("fenced json → sourceType=fenced", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: 'I need clarification:\n\n```json\n{"question":"Which framework?","options":["React","Vue"],"context":"frontend"}\n```\n',
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "should detect fenced json");
  assertEq(ni.sourceType, "fenced", "sourceType");
  assertEq(ni.question, "Which framework?", "question");
  assertEq(ni.options, ["React", "Vue"], "options");
  assertEq(ni.context, "frontend", "context");
});

test("plain json object → sourceType=json", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: 'Here is my question for you:\n{"question":"What port?","options":["3000","8080"],"context":"server setup"}\nPlease answer.',
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "should detect plain json");
  assertEq(ni.sourceType, "json", "sourceType");
  assertEq(ni.question, "What port?", "question");
  assertEq(ni.options, ["3000", "8080"], "options");
});

test("heuristic → sourceType=heuristic", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "I encountered NEEDS_INPUT situation.\nMy question: which environment should I target?",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "heuristic should fire");
  assertEq(ni.sourceType, "heuristic", "sourceType");
});

// ── Pipeline B: fenced json edge cases ──

console.log("\n\x1b[36m=== fenced json (pipeline B) ===\x1b[0m\n");

test("fenced json without 'json' tag", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: 'Need input:\n\n```\n{"question":"DB engine?","options":["pg","mysql"]}\n```\n',
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "should detect untagged fence");
  assertEq(ni.sourceType, "fenced");
  assertEq(ni.question, "DB engine?");
});

test("fenced block without question key → skip to next pipeline", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: 'Some code:\n\n```json\n{"name":"config","version":"1.0"}\n```\nAll done.',
  });
  assertEq(parseNeedsInput(stdout), null, "should not match non-question fence");
});

test("prose + fenced json (real Claude pattern)", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "I've analyzed the codebase and I need some clarification before proceeding.\n\nI have a few questions about the implementation approach:\n\n```json\n{\n  \"question\": \"Should I use REST or GraphQL for the new API endpoints?\",\n  \"options\": [\"REST with Express\", \"GraphQL with Apollo\", \"tRPC\"],\n  \"context\": \"The existing codebase uses Express but has no API layer yet\"\n}\n```\n\nPlease let me know your preference and I'll proceed with the implementation.",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "must detect fenced json in prose");
  assertEq(ni.sourceType, "fenced");
  assertEq(ni.question, "Should I use REST or GraphQL for the new API endpoints?");
  assertEq(ni.options, ["REST with Express", "GraphQL with Apollo", "tRPC"]);
  assertEq(ni.context, "The existing codebase uses Express but has no API layer yet");
});

// ── Pipeline C: plain JSON object ──

console.log("\n\x1b[36m=== plain json (pipeline C) ===\x1b[0m\n");

test("json object with nested options array", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: 'Before deciding, I need to know: {"question":"Auth method?","options":["JWT","session","OAuth2"],"context":"user auth"} — thanks!',
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null);
  assertEq(ni.sourceType, "json");
  assertEq(ni.question, "Auth method?");
  assertEq(ni.options, ["JWT", "session", "OAuth2"]);
});

test("json object with options as key-value map", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: 'I need input: {"question":"Which approach?","options":{"A":"Use hooks","B":"Use classes","C":"Use HOCs"},"context":"React refactor"}',
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null);
  assertEq(ni.sourceType, "json");
  assertEq(ni.question, "Which approach?");
  assertEq(ni.options, ["A: Use hooks", "B: Use classes", "C: Use HOCs"], "map→array");
});

// ── Pipeline D: heuristic ──

console.log("\n\x1b[36m=== heuristic (pipeline D) ===\x1b[0m\n");

test("NEEDS_INPUT in prose with question word", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "I've hit a NEEDS_INPUT point. My question: should I refactor the auth module first or add tests?",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "heuristic should catch");
  assertEq(ni.sourceType, "heuristic");
  assert(ni.question.length > 10, "question extracted");
});

test("no NEEDS_INPUT signal at all → null", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "Task completed. All files updated successfully. No questions remain.",
  });
  assertEq(parseNeedsInput(stdout), null);
});

// ── normalizeOptions ──

console.log("\n\x1b[36m=== normalizeOptions ===\x1b[0m\n");

test("array input", () => {
  assertEq(normalizeOptions(["a", "b"]), ["a", "b"]);
});

test("comma string input", () => {
  assertEq(normalizeOptions("foo, bar, baz"), ["foo", "bar", "baz"]);
});

test("object map → labeled array", () => {
  assertEq(normalizeOptions({ A: "first", B: "second" }), ["A: first", "B: second"]);
});

test("null → null", () => {
  assertEq(normalizeOptions(null), null);
});

test("empty array → null", () => {
  assertEq(normalizeOptions([]), null);
});

test("empty string → null", () => {
  assertEq(normalizeOptions(""), null);
});

// ── AskUserQuestion extraction (pipeline E) ──

console.log("\n\x1b[36m=== AskUserQuestion (pipeline E) ===\x1b[0m\n");

test("permission_denials with AskUserQuestion → extracted", () => {
  const stdout = JSON.stringify({
    type: "result",
    subtype: "success",
    result: "I need to ask the user something.",
    permission_denials: [
      {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Which database should I use?",
              header: "DB choice",
              options: [
                { label: "PostgreSQL", description: "Robust relational DB" },
                { label: "SQLite", description: "Lightweight file-based" },
                { label: "MongoDB", description: "Document store" },
              ],
              multiSelect: false,
            },
          ],
        },
      },
    ],
  });
  const ni = extractAskUserQuestion(stdout);
  assert(ni !== null, "should extract AskUserQuestion");
  assertEq(ni.sourceType, "ask_user_question");
  assertEq(ni.question, "Which database should I use?");
  assertEq(ni.options, [
    "PostgreSQL — Robust relational DB",
    "SQLite — Lightweight file-based",
    "MongoDB — Document store",
  ]);
});

test("permission_denials with AskUserQuestion — label only, no description", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "question time",
    permission_denials: [
      {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
        },
      },
    ],
  });
  const ni = extractAskUserQuestion(stdout);
  assert(ni !== null);
  assertEq(ni.options, ["Yes", "No"]);
});

test("permission_denials with AskUserQuestion — no options", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "hmm",
    permission_denials: [
      {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "What should I name the file?", options: [] }],
        },
      },
    ],
  });
  const ni = extractAskUserQuestion(stdout);
  assert(ni !== null);
  assertEq(ni.question, "What should I name the file?");
  assertEq(ni.options, null, "empty options → null");
});

test("permission_denials with other tool_name → null", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "done",
    permission_denials: [
      { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
    ],
  });
  assertEq(extractAskUserQuestion(stdout), null);
});

test("no permission_denials → null", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "all good",
  });
  assertEq(extractAskUserQuestion(stdout), null);
});

test("JSONL: AskUserQuestion in last line", () => {
  const lines = [
    JSON.stringify({ type: "assistant", content: "thinking" }),
    JSON.stringify({
      type: "result",
      result: "Need input.",
      permission_denials: [
        {
          tool_name: "AskUserQuestion",
          tool_input: {
            questions: [{ question: "Which API version?", options: [{ label: "v1" }, { label: "v2" }] }],
          },
        },
      ],
    }),
  ];
  const ni = extractAskUserQuestion(lines.join("\n"));
  assert(ni !== null);
  assertEq(ni.question, "Which API version?");
  assertEq(ni.sourceType, "ask_user_question");
});

test("parseNeedsInput falls through to AskUserQuestion (no marker in result text)", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "I tried to ask but was denied.",
    permission_denials: [
      {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Should I use TypeScript or JavaScript?",
              options: [
                { label: "TypeScript", description: "Type-safe" },
                { label: "JavaScript", description: "No build step" },
              ],
            },
          ],
        },
      },
    ],
  });
  // parseNeedsInput should find nothing in A-D, then fall through to E
  const ni = parseNeedsInput(stdout);
  assert(ni !== null, "parseNeedsInput should catch AskUserQuestion");
  assertEq(ni.sourceType, "ask_user_question");
  assertEq(ni.question, "Should I use TypeScript or JavaScript?");
  assertEq(ni.options, ["TypeScript — Type-safe", "JavaScript — No build step"]);
});

test("parseNeedsInput — question always non-null on match (never returns null question)", () => {
  // Ensure normalizePayload fallback works
  const stdout = JSON.stringify({
    type: "result",
    result: "[NEEDS_INPUT]\nno question key here\n[/NEEDS_INPUT]",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null);
  assert(typeof ni.question === "string" && ni.question.length > 0, "question must be non-empty string");
  assertEq(ni.question, "Clarification required", "fallback question text");
});

test("parseNeedsInput — options null when not specified (never empty array)", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "[NEEDS_INPUT]\nquestion: Should I proceed?\n[/NEEDS_INPUT]",
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null);
  assertEq(ni.options, null, "options must be null not empty array");
});

test("parseNeedsInput — stage2 review output does not trigger false positive", () => {
  // Regression: review mode output with [REVIEW_PASS] should NOT trigger needs_input
  const stdout = JSON.stringify({
    type: "result",
    result: "I reviewed the code thoroughly.\n[REVIEW_PASS]\nAll checks passed, no issues found.",
  });
  assertEq(parseNeedsInput(stdout), null, "review output should not trigger needs_input");
});

test("parseNeedsInput — review fail output does not trigger false positive", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "[REVIEW_FAIL severity=major]\nSQL injection in login endpoint.\n[/REVIEW_FAIL]",
  });
  assertEq(parseNeedsInput(stdout), null, "review_fail output should not trigger needs_input");
});

test("strict marker takes priority over AskUserQuestion", () => {
  const stdout = JSON.stringify({
    type: "result",
    result: "[NEEDS_INPUT]\nquestion: From marker\n[/NEEDS_INPUT]",
    permission_denials: [
      {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [{ question: "From AUQ", options: [] }],
        },
      },
    ],
  });
  const ni = parseNeedsInput(stdout);
  assert(ni !== null);
  assertEq(ni.sourceType, "strict", "strict wins over AUQ");
  assertEq(ni.question, "From marker");
});

// ── Summary ──

console.log(`\n\x1b[36m${"=".repeat(40)}\x1b[0m`);
if (failed === 0) {
  console.log(`\x1b[32mALL ${passed} TESTS PASSED\x1b[0m`);
} else {
  console.log(`\x1b[31m${failed} FAILED\x1b[0m, ${passed} passed`);
}
console.log(`\x1b[36m${"=".repeat(40)}\x1b[0m\n`);

process.exit(failed > 0 ? 1 : 0);
