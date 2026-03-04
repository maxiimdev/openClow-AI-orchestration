#!/usr/bin/env node
"use strict";

/**
 * Local test: mocks the orchestrator API and runs one dry_run cycle.
 * Usage: node test-dry-run.js
 */

const http = require("http");
const { spawn } = require("child_process");

const PORT = 9877;
let pullCount = 0;
let worker = null;

const MOCK_TASK = {
  taskId: "test-001",
  mode: "dry_run",
  scope: { repoPath: "/tmp/test-repo", branch: "feature/hello" },
  instructions: "Add a hello world endpoint to index.js",
  constraints: ["no breaking changes", "add tests"],
  contextSnippets: [
    { path: "index.js", content: 'console.log("hello");' },
  ],
};

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
      if (pullCount === 1) {
        console.log("[mock] --> sending task test-001");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: MOCK_TASK }));
      } else {
        console.log("[mock] --> no more tasks");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: null }));
        setTimeout(() => {
          console.log("\n[mock] test complete, stopping");
          if (worker) worker.kill("SIGTERM");
          server.close();
        }, 1500);
      }
      return;
    }

    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      console.log("\n[mock] <-- result received:");
      console.log(`  taskId:   ${result.taskId}`);
      console.log(`  status:   ${result.status}`);
      console.log(`  mode:     ${result.mode}`);
      console.log(`  duration: ${result.meta?.durationMs}ms`);
      console.log(`  stdout preview:`);
      console.log(`  ${(result.output?.stdout || "").slice(0, 400)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

server.listen(PORT, () => {
  console.log(`[mock] orchestrator listening on http://localhost:${PORT}`);
  console.log("[mock] spawning worker...\n");

  worker = spawn("node", ["worker.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://localhost:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker",
      POLL_INTERVAL_MS: "2000",
      CLAUDE_CMD: "claude",
      ALLOWED_REPOS: "/tmp/test-repo,/Users/sigma/MovieCenter",
      CLAUDE_TIMEOUT_MS: "30000",
    },
    stdio: "inherit",
  });

  worker.on("close", (code) => {
    console.log(`\n[mock] worker exited with code ${code}`);
    server.close();
  });
});
