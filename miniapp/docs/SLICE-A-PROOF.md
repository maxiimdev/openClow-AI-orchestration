# Slice A — Implementation Proof

## File-Level Changelog

### New Files
| File | Purpose |
|------|---------|
| `app/lib/utils.ts` | `cn()` utility (clsx + tailwind-merge) for shadcn-vue |
| `app/lib/filters.ts` | Extracted `filterByStatus`, `filterBySearch`, `applyFilters` helpers |
| `app/components/ui/button/Button.vue` | shadcn-vue Button (variant + size CVA) |
| `app/components/ui/card/Card.vue` | shadcn-vue Card container |
| `app/components/ui/card/CardHeader.vue` | shadcn-vue Card header section |
| `app/components/ui/card/CardContent.vue` | shadcn-vue Card content section |
| `app/components/ui/card/CardTitle.vue` | shadcn-vue Card title |
| `app/components/ui/badge/Badge.vue` | shadcn-vue Badge (variant CVA) |
| `app/components/ui/input/Input.vue` | shadcn-vue Input with v-model |
| `app/components/ui/skeleton/Skeleton.vue` | shadcn-vue Skeleton loader |
| `test/filters.test.ts` | 11 unit tests for filter/state helpers |
| `test/tasks-page.test.ts` | 8 smoke tests for /tasks page rendering |

### Modified Files
| File | Change |
|------|--------|
| `nuxt.config.ts` | Added `@nuxt/eslint` module |
| `package.json` | Added devDeps (vue-tsc, typescript, @nuxt/eslint, eslint, @vue/test-utils), deps (radix-vue, class-variance-authority, clsx, tailwind-merge, lucide-vue-next), scripts (test, lint, typecheck) |
| `app/pages/tasks/index.vue` | Added search filter input, refactored to use `applyFilters` helper |
| `app/components/TaskTimeline.vue` | Fixed `any` cast to proper type parameter |
| `server/lib/mock-data.ts` | Removed unused `now` variable |
| `test/mappers.test.ts` | Added eslint-disable for intentional `any` in test |
| `test/sse.test.ts` | Replaced `Function` types with `EventHandler`, `any` with proper types |

## Commands Run & Results

```
# Install dependencies
cd /Users/sigma/worker/miniapp
npm install --save-dev vue-tsc typescript @nuxt/eslint eslint @vue/test-utils
npm install radix-vue class-variance-authority clsx tailwind-merge lucide-vue-next

# Prepare Nuxt types
npx nuxt prepare  # ✅ Types generated in .nuxt

# Typecheck
npx vue-tsc --noEmit  # ✅ No errors

# Lint
npx eslint .  # ✅ 0 errors, 2 warnings (class prop defaults — standard shadcn-vue pattern)

# Tests
npx vitest run  # ✅ 4 test files, 42 tests passed (328ms)
#   test/filters.test.ts      — 11 tests ✅
#   test/mappers.test.ts      — 16 tests ✅
#   test/sse.test.ts           —  7 tests ✅
#   test/tasks-page.test.ts   —  8 tests ✅
```

## Quality Gates

| Gate | Status |
|------|--------|
| Typecheck (`vue-tsc --noEmit`) | ✅ Pass |
| Lint (`eslint .`) | ✅ 0 errors (2 warnings) |
| Unit tests (filters) | ✅ 11/11 |
| Smoke test (/tasks page) | ✅ 8/8 |

## What Remains for Slice B

1. **Task detail page** (`/tasks/[id]`) — already scaffolded, needs polish + testing
2. **Review screens** — review findings display, structured findings panel
3. **Needs-input / resume flow** — ResumeForm interaction + server wiring
4. **SSE realtime updates** — currently stub heartbeat only, needs real `task_update` events
5. **Auth middleware** — route guard (currently auth check is only in `app.vue` onMounted)
6. **Layout extraction** — move nav from `app.vue` into a proper Nuxt layout
7. **Migrate existing components to shadcn-vue** — TaskCard, StatusBadge, etc. still use raw Tailwind
8. **E2E tests** — Playwright or similar for full integration coverage
9. **Dark mode / theme** — CSS variables for shadcn-vue theming
