# Mini App — UX/Product MVP Spec

## Screens

### 1. Dashboard
- Summary cards: active tasks, pending input, completed today
- Quick links to other screens

### 2. Tasks List
- Filterable by status: `queued`, `running`, `completed`, `failed`, `needs_input`, `review_pass`, `review_fail`, `escalated`
- Each row: task ID (truncated), mode badge, status badge, branch, relative time
- Tap → Task Details

### 3. Task Details Timeline
- Header: task ID, mode, branch, status badge, duration
- Timeline of events in chronological order (newest first)
- Each event: status icon, phase, message, relative timestamp
- Live updates via SSE (fallback to polling)
- Actions: retry (feature-flagged), cancel (feature-flagged)

### 4. Needs Input Inbox
- List of tasks with `needs_input` status
- Each item: task ID, question text, options (if any), waiting duration
- Tap → inline answer form or Task Details with answer panel
- Resume action: text input or option select → POST resume

### 5. Review Center
- Tasks in review-related statuses: `review_pass`, `review_fail`, `escalated`
- Each item: task ID, verdict badge, findings summary, iteration count
- Expandable structured findings (severity, file, issue, fix)

## States (all screens)
- **Loading**: skeleton placeholders
- **Empty**: friendly empty-state message
- **Error**: retry button + error description
- **Stale**: subtle indicator when data may be outdated (SSE disconnected)

## Status Mapping (internal → user-facing)
| Internal | Display | Color |
|---|---|---|
| `claimed`, `started`, `progress` | Running | blue |
| `completed` | Completed | green |
| `failed`, `timeout`, `rejected` | Failed | red |
| `needs_input` | Awaiting Input | amber |
| `review_pass` | Review Passed | green |
| `review_fail` | Review Failed | orange |
| `escalated` | Escalated | red |
| `keepalive` | Running | blue |
| `risk` | At Risk | orange |
