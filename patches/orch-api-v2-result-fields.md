# PATCH: Persist v2 result fields (resultVersion, artifacts) in orch-api

Target: remote orch-api on VPS (server.js or equivalent handler)
Schema: worker -> orch-api (storage) -> miniapp (read via GET /api/task/:taskId)

## Problem

Worker sends `resultVersion: 2` and `artifacts: [...]` in `POST /api/worker/result`
but the orch-api handler only destructures/saves `workerId`, `status`, `output`, `meta`.
The v2 fields are silently dropped. `GET /api/task/:taskId` never returns them.

Current result keys stored: `workerId`, `status`, `output`, `meta`
Missing keys: `resultVersion`, `artifacts`

## DATA_MODEL_CHANGES

Add to task object (in-memory store or DB):

```js
// New fields on task:
{
  resultVersion: undefined,  // number|undefined — 2 for v2 results, absent for v1
  artifacts:     undefined,  // Array<Artifact>|undefined — artifact metadata array
}
```

Artifact shape (from worker):

```js
{
  name:    "stdout.txt",                           // filename
  kind:    "stdout",                               // "stdout" | "stderr" | "markdown" | ...
  path:    "data/artifacts/task-123/stdout.txt",   // relative storage path
  bytes:   16384,                                  // size in bytes
  sha256:  "abc123...",                            // hex sha256 of content
  preview: "first 512 chars..."                    // inline preview (max 512 chars)
}
```

## PATCH — POST /api/worker/result handler

In the result handler, after extracting existing fields, also save `resultVersion` and `artifacts`:

```js
// BEFORE (existing):
task.workerId = result.workerId;
task.status   = result.status;
task.output   = result.output;
task.meta     = result.meta;

// ADD THESE LINES — v2 result fields (backward-compatible: undefined for v1):
if (result.resultVersion != null) {
  task.resultVersion = result.resultVersion;
}
if (Array.isArray(result.artifacts)) {
  task.artifacts = result.artifacts;
}
```

This is backward-compatible: v1 results have no `resultVersion` or `artifacts` fields,
so the conditional guards ensure nothing changes for v1 payloads.

## PATCH — GET /api/task/:taskId response

In the response builder, include the new fields when present:

```js
// BEFORE (existing):
return res.json({
  taskId:       task.taskId,
  mode:         task.mode,
  status:       task.status,
  scope:        task.scope,
  instructions: task.instructions,
  output:       task.output,
  meta:         task.meta,
  events:       task.events,
  // ... other fields
});

// AFTER — add v2 fields conditionally:
const response = {
  taskId:       task.taskId,
  mode:         task.mode,
  status:       task.status,
  scope:        task.scope,
  instructions: task.instructions,
  output:       task.output,
  meta:         task.meta,
  events:       task.events,
  // ... other existing fields
};

// v2 result fields — include only when present (no breaking change for v1 consumers)
if (task.resultVersion != null) response.resultVersion = task.resultVersion;
if (task.artifacts != null)     response.artifacts = task.artifacts;

return res.json(response);
```

## PATCH_SUMMARY

- Files changed on VPS: **1** (the main server/handler module)
- Lines added: ~6 (2 in result handler + 2 in response builder + 2 model fields)
- Dependencies added: **0**
- Existing behavior changed: **none** — v1 results continue to work identically
- Risk: **zero** — fields are only set when present in worker payload

## VERIFICATION

After applying the patch:

1. **v1 result still works**:
   ```bash
   # Send v1 result (no resultVersion, no artifacts)
   curl -X POST $ORCH/api/worker/result \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "workerId": "w1",
       "taskId": "test-v1",
       "status": "completed",
       "mode": "implement",
       "output": {"stdout": "done", "stderr": "", "truncated": false},
       "meta": {"exitCode": 0, "durationMs": 1000}
     }'
   # Fetch: no resultVersion, no artifacts in response
   curl $ORCH/api/task/test-v1 -H "Authorization: Bearer $TOKEN" | jq '{resultVersion, artifacts}'
   # Expected: {"resultVersion": null, "artifacts": null}
   ```

2. **v2 result round-trips**:
   ```bash
   # Send v2 result
   curl -X POST $ORCH/api/worker/result \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "resultVersion": 2,
       "workerId": "w1",
       "taskId": "test-v2",
       "status": "completed",
       "mode": "implement",
       "output": {"stdout": "truncated...", "stderr": "", "truncated": true},
       "artifacts": [
         {"name": "stdout.txt", "kind": "stdout", "path": "data/artifacts/test-v2/stdout.txt", "bytes": 16384, "sha256": "abc123", "preview": "full output..."}
       ],
       "meta": {"exitCode": 0, "durationMs": 5000}
     }'
   # Fetch: resultVersion=2 and artifacts present
   curl $ORCH/api/task/test-v2 -H "Authorization: Bearer $TOKEN" | jq '{resultVersion, artifacts}'
   # Expected: {"resultVersion": 2, "artifacts": [{...}]}
   ```

3. **Empty artifacts array**:
   ```bash
   curl -X POST $ORCH/api/worker/result \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "resultVersion": 2,
       "workerId": "w1",
       "taskId": "test-v2-empty",
       "status": "completed",
       "mode": "implement",
       "output": {"stdout": "small output", "stderr": "", "truncated": false},
       "artifacts": [],
       "meta": {"exitCode": 0, "durationMs": 1000}
     }'
   curl $ORCH/api/task/test-v2-empty -H "Authorization: Bearer $TOKEN" | jq '{resultVersion, artifacts}'
   # Expected: {"resultVersion": 2, "artifacts": []}
   ```

## ROLLBACK_STEPS

1. SSH to VPS
2. Remove the 6 added lines (2 in result handler + 2 in response builder + 2 model init)
3. Restart orch-api
4. Existing v1 behavior is restored; v2 fields are again dropped silently
5. No data loss — worker still saves artifacts to local disk regardless
