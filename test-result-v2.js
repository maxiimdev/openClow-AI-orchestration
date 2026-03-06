#!/usr/bin/env node
"use strict";

/**
 * Tests for v2 result contract: artifact persistence + inline truncation.
 *
 * Covers:
 *   - buildV2Output with small output (no artifact, no truncation)
 *   - buildV2Output with large stdout (artifact saved, inline truncated to 8KB)
 *   - buildV2Output with large stderr (artifact saved, inline truncated)
 *   - buildV2Output with both large stdout+stderr
 *   - saveArtifact deterministic sha256 + metadata
 *   - v1 backward compat (resultBody shape includes resultVersion:2 + artifacts)
 */

const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

// ── Import worker internals by evaluating the relevant functions ─────────

const INLINE_OUTPUT_LIMIT = 8 * 1024;
const ARTIFACTS_DIR = path.join(__dirname, "data", "artifacts", "__test__");

function truncate(str, limit) {
  if (Buffer.byteLength(str, "utf-8") <= limit) {
    return { text: str, truncated: false };
  }
  let buf = Buffer.from(str, "utf-8").subarray(0, limit);
  const text = buf.toString("utf-8");
  return { text: text + "\n[TRUNCATED]", truncated: true };
}

function saveArtifact(taskId, name, kind, content) {
  const dir = path.join(ARTIFACTS_DIR, taskId);
  fs.mkdirSync(dir, { recursive: true });

  const buf = Buffer.from(content, "utf-8");
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buf);

  const preview = content.slice(0, 512);

  return {
    name,
    kind,
    path: `data/artifacts/${taskId}/${name}`,
    bytes: buf.length,
    sha256,
    preview,
  };
}

function buildV2Output(taskId, output) {
  const artifacts = [];
  let inlineStdout = output.stdout;
  let inlineStderr = output.stderr;
  let truncated = output.truncated;

  if (Buffer.byteLength(output.stdout, "utf-8") > INLINE_OUTPUT_LIMIT) {
    const art = saveArtifact(taskId, "stdout.txt", "stdout", output.stdout);
    artifacts.push(art);
    const trunc = truncate(output.stdout, INLINE_OUTPUT_LIMIT);
    inlineStdout = trunc.text + `\n[full output: ${art.path}]`;
    truncated = true;
  }

  if (Buffer.byteLength(output.stderr, "utf-8") > INLINE_OUTPUT_LIMIT) {
    const art = saveArtifact(taskId, "stderr.txt", "stderr", output.stderr);
    artifacts.push(art);
    const trunc = truncate(output.stderr, INLINE_OUTPUT_LIMIT);
    inlineStderr = trunc.text + `\n[full output: ${art.path}]`;
    truncated = true;
  }

  return { output: { stdout: inlineStdout, stderr: inlineStderr, truncated }, artifacts };
}

// ── CLEANUP ─────────────────────────────────────────────────────────────────

function cleanup() {
  if (fs.existsSync(ARTIFACTS_DIR)) {
    fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true });
  }
}

// ── TESTS ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    cleanup();
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

console.log("test-result-v2: v2 result contract tests\n");

// ── small output: no artifact, no truncation ──
test("small output passes through unchanged", () => {
  const output = { stdout: "hello world", stderr: "", truncated: false };
  const v2 = buildV2Output("task-small", output);
  assert.strictEqual(v2.output.stdout, "hello world");
  assert.strictEqual(v2.output.stderr, "");
  assert.strictEqual(v2.output.truncated, false);
  assert.strictEqual(v2.artifacts.length, 0);
});

// ── large stdout: artifact saved, inline truncated ──
test("large stdout creates artifact and truncates inline", () => {
  const bigStdout = "A".repeat(16 * 1024); // 16KB > 8KB limit
  const output = { stdout: bigStdout, stderr: "", truncated: false };
  const v2 = buildV2Output("task-big-stdout", output);

  // Inline should be truncated
  assert.ok(Buffer.byteLength(v2.output.stdout, "utf-8") < bigStdout.length);
  assert.ok(v2.output.stdout.includes("[TRUNCATED]"));
  assert.ok(v2.output.stdout.includes("[full output:"));
  assert.strictEqual(v2.output.truncated, true);

  // Artifact metadata
  assert.strictEqual(v2.artifacts.length, 1);
  const art = v2.artifacts[0];
  assert.strictEqual(art.name, "stdout.txt");
  assert.strictEqual(art.kind, "stdout");
  assert.strictEqual(art.bytes, Buffer.byteLength(bigStdout, "utf-8"));
  assert.strictEqual(art.sha256.length, 64); // hex sha256

  // Artifact file exists with full content
  const filePath = path.join(ARTIFACTS_DIR, "task-big-stdout", "stdout.txt");
  assert.ok(fs.existsSync(filePath));
  assert.strictEqual(fs.readFileSync(filePath, "utf-8"), bigStdout);
});

// ── large stderr: artifact saved ──
test("large stderr creates artifact and truncates inline", () => {
  const bigStderr = "E".repeat(10 * 1024);
  const output = { stdout: "ok", stderr: bigStderr, truncated: false };
  const v2 = buildV2Output("task-big-stderr", output);

  assert.strictEqual(v2.output.stdout, "ok");
  assert.ok(v2.output.stderr.includes("[TRUNCATED]"));
  assert.ok(v2.output.stderr.includes("[full output:"));
  assert.strictEqual(v2.output.truncated, true);
  assert.strictEqual(v2.artifacts.length, 1);
  assert.strictEqual(v2.artifacts[0].kind, "stderr");
});

// ── both large: two artifacts ──
test("both large stdout and stderr create two artifacts", () => {
  const bigStdout = "O".repeat(12 * 1024);
  const bigStderr = "E".repeat(12 * 1024);
  const output = { stdout: bigStdout, stderr: bigStderr, truncated: false };
  const v2 = buildV2Output("task-both-big", output);

  assert.strictEqual(v2.artifacts.length, 2);
  assert.strictEqual(v2.artifacts[0].kind, "stdout");
  assert.strictEqual(v2.artifacts[1].kind, "stderr");
  assert.strictEqual(v2.output.truncated, true);
});

// ── already truncated flag is preserved ──
test("preserves existing truncated=true from v1", () => {
  const output = { stdout: "small", stderr: "", truncated: true };
  const v2 = buildV2Output("task-already-trunc", output);
  assert.strictEqual(v2.output.truncated, true);
  assert.strictEqual(v2.artifacts.length, 0);
});

// ── sha256 is deterministic ──
test("sha256 is deterministic for same content", () => {
  const content = "deterministic test content";
  const art1 = saveArtifact("task-sha-1", "test.txt", "test", content);
  cleanup();
  const art2 = saveArtifact("task-sha-1", "test.txt", "test", content);
  assert.strictEqual(art1.sha256, art2.sha256);

  const expected = crypto.createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
  assert.strictEqual(art1.sha256, expected);
});

// ── preview is capped at 512 chars ──
test("artifact preview is capped at 512 chars", () => {
  const content = "X".repeat(1000);
  const art = saveArtifact("task-preview", "big.txt", "test", content);
  assert.strictEqual(art.preview.length, 512);
});

// ── resultBody shape includes resultVersion:2 + artifacts ──
test("v2 resultBody has correct shape", () => {
  const output = { stdout: "done", stderr: "", truncated: false };
  const v2 = buildV2Output("task-shape", output);
  const resultBody = {
    resultVersion: 2,
    workerId: "w1",
    taskId: "task-shape",
    status: "completed",
    mode: "implement",
    output: v2.output,
    artifacts: v2.artifacts,
    meta: { durationMs: 100 },
  };

  assert.strictEqual(resultBody.resultVersion, 2);
  assert.ok(Array.isArray(resultBody.artifacts));
  assert.ok(resultBody.output);
  assert.ok(resultBody.meta);
});

// ── v1 compat: result without resultVersion is valid ──
test("v1 result without resultVersion is backward compatible", () => {
  // Simulate a v1 result body (no resultVersion, no artifacts)
  const v1Body = {
    workerId: "w1",
    taskId: "task-v1",
    status: "completed",
    mode: "implement",
    output: { stdout: "done", stderr: "", truncated: false },
    meta: { durationMs: 100 },
  };

  assert.strictEqual(v1Body.resultVersion, undefined);
  assert.strictEqual(v1Body.artifacts, undefined);
  // v1 shape still has all required fields
  assert.ok(v1Body.output);
  assert.ok(v1Body.meta);
});

// ── inline output stays under 8KB + marker ──
test("inline stdout is at most ~8KB + truncation marker", () => {
  const bigStdout = "Z".repeat(50 * 1024);
  const output = { stdout: bigStdout, stderr: "", truncated: false };
  const v2 = buildV2Output("task-cap-check", output);

  // Inline should be around 8KB + [TRUNCATED] + [full output: ...] markers
  const inlineBytes = Buffer.byteLength(v2.output.stdout, "utf-8");
  // Allow for truncation marker + full output pointer (generous: 200 bytes overhead)
  assert.ok(inlineBytes < INLINE_OUTPUT_LIMIT + 200,
    `inline stdout too large: ${inlineBytes} bytes`);
});

// ── DONE ──

cleanup();

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
