# Operator Runbook: Feature Branch + PR Workflow

## Overview

After each completed task, the worker can automatically:
1. Create a dedicated feature branch named `feature/<task-slug>`
2. Push the branch to `origin`
3. Optionally create a pull request via `gh pr create`

The workflow **never auto-merges**. If PR creation fails, the task remains completed with an explicit warning and next-step guidance.

## Environment Variables

| Var | Default | Description |
|---|---|---|
| `FEATURE_BRANCH_PER_TASK` | `true` | Create and push a feature branch per completed task |
| `AUTO_PR_AFTER_TASK` | `false` | Attempt PR creation after pushing the branch |
| `PR_TARGET_BRANCH` | `main` | Default base branch for PRs |

## Per-Task Overrides

Tasks can override the global config via task-level flags:

| Flag | Effect |
|---|---|
| `featureBranchPerTask: false` | Opt out of branch workflow for this task |
| `prTargetBranch: "develop"` | Override the PR target branch |

## Branch Naming

Branches are derived from the `taskId`:
- Lowercased
- Non-alphanumeric characters replaced with `-`
- Leading/trailing dashes stripped
- Truncated to 60 characters
- Prefixed with `feature/`

Example: `task-20260306T185327Z-feature-branch-pr-policy-flag` becomes `feature/task-20260306t185327z-feature-branch-pr-policy-flag`.

## Usage Examples

### Default: Branch per task, no PR

```bash
# .env
FEATURE_BRANCH_PER_TASK=true   # default
AUTO_PR_AFTER_TASK=false        # default
```

Result metadata:
```json
{
  "featureBranchWorkflow": true,
  "featureBranch": "feature/task-abc-123",
  "pushResult": "success",
  "prCreation": "skipped",
  "prNextStep": "Branch feature/task-abc-123 pushed. Create PR manually to main."
}
```

### Auto PR creation

```bash
# .env
FEATURE_BRANCH_PER_TASK=true
AUTO_PR_AFTER_TASK=true
PR_TARGET_BRANCH=main
```

Success result:
```json
{
  "featureBranchWorkflow": true,
  "featureBranch": "feature/task-abc-123",
  "pushResult": "success",
  "prCreation": "success",
  "prUrl": "https://github.com/org/repo/pull/42"
}
```

PR failure result (task stays completed):
```json
{
  "featureBranchWorkflow": true,
  "featureBranch": "feature/task-abc-123",
  "pushResult": "success",
  "prCreation": "failed",
  "prError": "gh: Not Found (HTTP 404)",
  "prNextStep": "PR creation failed. Branch is pushed and ready for manual PR creation."
}
```

### Disable for specific task

```json
{
  "taskId": "task-no-branch",
  "mode": "implement",
  "featureBranchPerTask": false,
  "scope": { "repoPath": "/path/to/repo", "branch": "feature/existing" }
}
```

## Safety Guarantees

- **Never auto-merges**: The workflow only creates PRs, never merges them.
- **Non-fatal failures**: If branch creation, push, or PR creation fails, the task remains `completed`. Errors are logged and reported via events + result metadata.
- **Backward compatible**: Default behavior (`FEATURE_BRANCH_PER_TASK=true`, `AUTO_PR_AFTER_TASK=false`) only adds branch push. Set `FEATURE_BRANCH_PER_TASK=false` to completely disable.
- **Only on completed tasks**: Branch workflow only runs when `result.status === "completed"`. Failed, escalated, or needs_input tasks are unaffected.

## Recommended Defaults

| Var | Recommended | Rationale |
|---|---|---|
| `FEATURE_BRANCH_PER_TASK` | `true` | Isolates each task's changes on a dedicated branch |
| `AUTO_PR_AFTER_TASK` | `false` | PRs should be reviewed before creation in most workflows |
| `PR_TARGET_BRANCH` | `main` | Standard base branch |

For CI-heavy environments with automated review gates, consider `AUTO_PR_AFTER_TASK=true` to reduce manual steps. The no-auto-merge guarantee ensures human review before any code lands.

## Events

The worker emits a `feature_branch` phase event after the workflow:

```json
{
  "phase": "feature_branch",
  "status": "completed",
  "message": "branch feature/task-abc-123 pushed, PR created: https://..."
}
```
