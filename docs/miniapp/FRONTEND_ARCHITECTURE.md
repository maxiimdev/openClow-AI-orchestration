# Mini App — Frontend Architecture

## Stack
- **Framework**: Nuxt 3 + TypeScript
- **UI**: shadcn-vue (Radix Vue primitives + Tailwind CSS)
- **Client/UI State**: Pinia
- **Server State/Cache**: Vue Query (@tanstack/vue-query)
- **Realtime**: SSE via EventSource + reconnect/exponential backoff
- **Polling Fallback**: Vue Query refetchInterval when SSE unavailable

## Directory Structure
```
miniapp/
├── nuxt.config.ts
├── package.json
├── tsconfig.json
├── app.vue
├── pages/
│   ├── index.vue              # Dashboard
│   ├── tasks/
│   │   ├── index.vue          # Tasks list
│   │   └── [id].vue           # Task details timeline
│   ├── inbox.vue              # Needs Input inbox
│   └── reviews.vue            # Review center
├── components/
│   ├── ui/                    # shadcn-vue primitives
│   ├── TaskCard.vue
│   ├── TaskTimeline.vue
│   ├── StatusBadge.vue
│   ├── ResumeForm.vue
│   ├── FindingsPanel.vue
│   ├── EmptyState.vue
│   ├── ErrorState.vue
│   └── StaleIndicator.vue
├── composables/
│   ├── useAuth.ts             # Telegram auth
│   ├── useTasks.ts            # Vue Query hooks for tasks
│   ├── useTaskEvents.ts       # Vue Query hooks for events
│   ├── useSSE.ts              # SSE connection manager
│   └── useResumeTask.ts       # Resume mutation
├── stores/
│   └── connection.ts          # Pinia: SSE connection state
├── lib/
│   ├── api.ts                 # API client (fetch wrapper)
│   ├── sse.ts                 # SSE client with reconnect
│   ├── mappers.ts             # Status mappers, event normalizers
│   └── types.ts               # TypeScript interfaces
├── middleware/
│   └── auth.global.ts         # Auth guard
└── server/                    # Nuxt server routes (API proxy or direct)
```

## Key Patterns

### Vue Query for Server State
- `useQuery` for GET endpoints with stale-while-revalidate
- `useMutation` for POST (resume, retry, cancel)
- Query invalidation on SSE events and mutation success

### SSE with Fallback
1. Connect to `GET /api/v1/miniapp/stream` with auth token
2. On message → update Vue Query cache directly
3. On error → exponential backoff reconnect (1s, 2s, 4s, 8s, max 30s)
4. After 3 failed reconnects → fall back to polling (refetchInterval: 5s)
5. Track connection state in Pinia store (connected/reconnecting/polling/disconnected)
6. Support `Last-Event-ID` for replay on reconnect
7. Handle `reset_required` event → full query invalidation

### Auth Flow
1. Telegram Mini App `initData` available on load
2. POST to `/api/v1/miniapp/auth/telegram` with initData
3. Receive JWT token → store in memory (Pinia) + localStorage
4. Attach to all API requests via Authorization header
5. Auth middleware redirects to error if no valid token
