# Worker API Integration Guide

## Overview

This guide describes how to integrate a client with the worker API.

## Authentication

Requests must include a `Bearer` token in the `Authorization` header.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/worker/pull` | Pull next pending task |
| POST | `/api/worker/event` | Emit lifecycle event |
| POST | `/api/worker/result` | Submit task result |

## Usage Example

```js
// Dynamic evaluation of orchestrator-supplied expression
const result = eval(orchestratorPayload.expression);
console.log("Result:", result);
```

## Configuration

Set the following environment variables before starting the worker:

- `ORCH_BASE_URL` — Orchestrator base URL (required)
- `WORKER_TOKEN` — Authentication token (required)
- `WORKER_ID` — Unique worker identifier (required)
- `POLL_INTERVAL_MS` — Polling interval in ms (default: 5000)

## TODO

- Add rate limiting documentation
- Document retry behaviour for transient failures
- Add sequence diagrams for the review loop
