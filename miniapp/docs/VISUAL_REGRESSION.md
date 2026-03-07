# Visual Regression Testing

## Overview

Visual regression tests capture full-page screenshots for key pages at two
viewports (mobile 390x844, desktop 1280x720) and compare them against
committed baselines using Playwright's built-in `toHaveScreenshot()`.

## Baseline inventory

```
miniapp/e2e/__screenshots__/visual.spec.ts/

Populated-state baselines (5 pages x 2 viewports = 10):
  dashboard-chromium.png            # mobile 390x844
  dashboard-chromium-desktop.png    # desktop 1280x720
  tasks-list-chromium.png
  tasks-list-chromium-desktop.png
  task-detail-chromium.png
  task-detail-chromium-desktop.png
  inbox-chromium.png
  inbox-chromium-desktop.png
  reviews-chromium.png
  reviews-chromium-desktop.png

Empty-state baselines (4 pages x 2 viewports = 8):
  dashboard-empty-chromium.png
  dashboard-empty-chromium-desktop.png
  tasks-list-empty-chromium.png
  tasks-list-empty-chromium-desktop.png
  inbox-empty-chromium.png
  inbox-empty-chromium-desktop.png
  reviews-empty-chromium.png
  reviews-empty-chromium-desktop.png

Total: 18 baseline screenshots
```

These files are committed to the repo and tracked in git.

## Commands

| Command | Purpose |
|---|---|
| `npm run test:visual` | Run visual diff against baselines (fails on drift) |
| `npm run test:visual:update` | Regenerate baselines after intentional changes |
| `npm run test:visual:gate` | Run gate script with human-readable output |
| `npm run test:visual:ci` | Run gate script with JSON report (`e2e/visual-report.json`) |
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
2. Run `npm run test:visual` -- it will fail showing diffs
3. Review the diff images in `e2e/test-results/` to confirm they match intent
4. Run `npm run test:visual:update` to regenerate baselines
5. Run `npm run test:visual` again to verify baselines pass
6. Commit the updated `.png` files in `e2e/__screenshots__/`

**Do NOT** blindly run `--update-snapshots`. Always inspect diff artifacts first.

## CI integration

Add to your CI pipeline:

```yaml
- run: cd miniapp && npm run test:visual:ci
- uses: actions/upload-artifact@v4
  if: failure()
  with:
    name: visual-diffs
    path: miniapp/e2e/test-results/
```

On failure, Playwright writes three files per failing test to `e2e/test-results/`:

| File | Description |
|---|---|
| `*-actual.png` | What the page looks like now |
| `*-expected.png` | The committed baseline |
| `*-diff.png` | Highlighted pixel differences (red overlay) |

### JSON report

When using `npm run test:visual:ci`, a report is written to `e2e/visual-report.json`
with status, baseline count, diff count, and artifact refs on failure.

## False-positive guardrails

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
- **Empty-state coverage**: Separate empty-state baselines ensure zero-data
  views are regression-tested without mixing with populated states.
- **Infrastructure test**: `test/visual-gate.test.ts` validates baselines exist,
  thresholds are configured, and the gate script has correct flags.

## Guardrails for baseline updates

1. Never update baselines on CI -- only update locally, review diffs, then commit
2. One PR per visual change -- avoid mixing visual changes with logic changes
3. Review every `.png` diff before committing updated baselines
4. Run `npm test` after update to verify the infrastructure test still passes
5. Check baseline count -- if new pages are added, add corresponding visual tests
