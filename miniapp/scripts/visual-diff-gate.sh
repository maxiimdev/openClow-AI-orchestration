#!/usr/bin/env bash
# Visual regression diff gate.
#
# Runs Playwright visual tests and reports results.
# Exits non-zero if any screenshot diffs exceed the threshold
# configured in playwright.config.ts.
#
# Usage:
#   ./scripts/visual-diff-gate.sh          # compare against baselines
#   ./scripts/visual-diff-gate.sh --update # update baselines (intentional changes)
#   ./scripts/visual-diff-gate.sh --json   # write e2e/visual-report.json
#
# Artifacts on failure:
#   e2e/test-results/  — diff images, actual vs expected PNGs
#
# Thresholds (from playwright.config.ts):
#   maxDiffPixelRatio: 0.01 (1% of pixels)
#   threshold: 0.2 (per-pixel color distance 0-1)

set -euo pipefail
cd "$(dirname "$0")/.."

UPDATE_FLAG=""
JSON_OUTPUT=""
for arg in "$@"; do
  case "$arg" in
    --update) UPDATE_FLAG="--update-snapshots"; echo "==> Updating visual baselines..." ;;
    --json)   JSON_OUTPUT="1" ;;
  esac
done

if [[ -z "$UPDATE_FLAG" ]]; then
  echo "==> Running visual diff gate..."
fi

# Build if .output is stale or missing
if [[ ! -d .output ]] || [[ $(find app/ -newer .output/server/index.mjs -print -quit 2>/dev/null) ]]; then
  echo "==> Building app (source newer than .output)..."
  npx nuxt build --quiet 2>&1 | tail -3
fi

# Run visual tests
echo "==> Comparing screenshots (2 projects: mobile + desktop)..."
RESULT="pass"
if npx playwright test e2e/visual.spec.ts $UPDATE_FLAG 2>&1; then
  echo ""
  echo "PASS: All visual baselines match."
  echo "  Baselines: e2e/__screenshots__/visual.spec.ts/"
  echo "  Config:    playwright.config.ts (maxDiffPixelRatio=0.01, threshold=0.2)"
else
  EXIT_CODE=$?
  RESULT="fail"
  echo ""
  echo "FAIL: Visual regression detected!"
  echo ""
  echo "  Diff artifacts: e2e/test-results/"
  echo "  Each failing test produces:"
  echo "    *-actual.png   — what the page looks like now"
  echo "    *-expected.png — the committed baseline"
  echo "    *-diff.png     — highlighted pixel differences"
  echo ""
  echo "  To update baselines after intentional changes:"
  echo "    npm run test:visual:update"
  echo "    # or: ./scripts/visual-diff-gate.sh --update"
  echo ""
  echo "  Then review the updated PNGs and commit them."
fi

# Write JSON report if --json flag is set
if [[ -n "$JSON_OUTPUT" ]]; then
  BASELINES=$(ls -1 e2e/__screenshots__/visual.spec.ts/*.png 2>/dev/null | wc -l | tr -d ' ')
  cat > e2e/visual-report.json <<ENDJSON
{
  "result": "$RESULT",
  "baselines": $BASELINES,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON
  echo "  JSON report: e2e/visual-report.json"
fi

if [[ "$RESULT" == "fail" ]]; then
  exit ${EXIT_CODE:-1}
fi
