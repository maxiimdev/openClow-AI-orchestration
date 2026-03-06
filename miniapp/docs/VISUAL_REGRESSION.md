# Visual Regression Testing

## Overview

Visual regression tests capture full-page screenshots for key pages at two
viewports (mobile 390x844, desktop 1280x720) and compare them against
committed baselines using Playwright's built-in `toHaveScreenshot()`.

## Baseline file paths

```
miniapp/e2e/__screenshots__/visual.spec.ts/
  dashboard-chromium.png          # mobile
  dashboard-chromium-desktop.png  # desktop
  tasks-list-chromium.png
  tasks-list-chromium-desktop.png
  task-detail-chromium.png
  task-detail-chromium-desktop.png
  inbox-chromium.png
  inbox-chromium-desktop.png
  reviews-chromium.png
  reviews-chromium-desktop.png
```

These files are committed to the repo and tracked in git.

## Commands

| Command | Purpose |
|---|---|
| `npm run test:visual` | Run visual diff against baselines (fails on drift) |
| `npm run test:visual:update` | Regenerate baselines after intentional changes |
| `npx playwright test e2e/visual.spec.ts --project chromium` | Run only mobile viewport |
| `npx playwright test e2e/visual.spec.ts --project chromium-desktop` | Run only desktop viewport |

## Threshold settings

Configured in `playwright.config.ts` under `expect.toHaveScreenshot`:

| Setting | Value | Meaning |
|---|---|---|
| `maxDiffPixelRatio` | `0.01` | Fail if >1% of pixels differ |
| `threshold` | `0.2` | Per-pixel color distance tolerance (0-1 scale) |
| `animations` | `disabled` | CSS animations frozen to prevent flaky diffs |

## Update workflow (intentional visual changes)

1. Make your UI changes
2. Run `npm run test:visual` — it will fail showing diffs
3. Review the diff images in `e2e/results/` to confirm they match intent
4. Run `npm run test:visual:update` to regenerate baselines
5. Commit the updated `.png` files in `e2e/__screenshots__/`

## CI integration

Add to your CI pipeline:

```yaml
- run: cd miniapp && npm run test:visual
```

On failure, Playwright writes three artifacts to `e2e/results/`:
- `*-actual.png` — what the test captured
- `*-expected.png` — the baseline
- `*-diff.png` — highlighted pixel differences

Upload `e2e/results/` as a CI artifact for easy review.

## False-positive reduction

- **Static timestamps**: Mock data uses fixed ISO dates (not `new Date()`) to
  prevent time-dependent rendering changes.
- **Animations disabled**: `animations: 'disabled'` in config freezes CSS
  animations/transitions before capture.
- **Content-ready waits**: Each test waits for key content to be visible before
  screenshotting, avoiding layout-shift race conditions.
- **API mocking**: All API calls are intercepted with deterministic data, so
  tests are independent of backend state.
- **Threshold tuning**: The 0.2 per-pixel threshold tolerates minor
  anti-aliasing differences across environments. Increase `maxDiffPixelRatio`
  if font rendering varies between CI and local (e.g., 0.02 for Linux CI).
