#!/usr/bin/env node
"use strict";

/**
 * Mock claude CLI for telemetry tests.
 * Ignores all argv. Behavior controlled via env vars:
 *   MOCK_CLAUDE_SLEEP_MS   - ms to sleep before responding (default: 0)
 *   MOCK_CLAUDE_EXIT_CODE  - exit code (default: 0)
 *   MOCK_CLAUDE_OUTPUT     - stdout payload (default: JSON result)
 */

const ms   = parseInt(process.env.MOCK_CLAUDE_SLEEP_MS   || "0",  10);
const code = parseInt(process.env.MOCK_CLAUDE_EXIT_CODE  || "0",  10);
const out  = process.env.MOCK_CLAUDE_OUTPUT ||
  '{"type":"result","subtype":"success","result":"mock task complete","is_error":false}';

setTimeout(() => {
  if (code === 0) process.stdout.write(out + "\n");
  process.exit(code);
}, ms);
