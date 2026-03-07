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

# Count baselines
BASELINE_DIR="e2e/__screenshots__/visual.spec.ts"
BASELINE_COUNT=0
if [[ -d "$BASELINE_DIR" ]]; then
  BASELINE_COUNT=$(find "$BASELINE_DIR" -name '*.png' | wc -l | tr -d ' ')
fi

REPORT_FILE="e2e/visual-report.json"

# Run visual tests
echo "==> Comparing screenshots (2 projects: mobile + desktop)..."
RESULT="pass"
if npx playwright test e2e/visual.spec.ts $UPDATE_FLAG 2>&1; then
  echo ""
  echo "PASS: All visual baselines match."
  echo "  Baselines: $BASELINE_DIR/ ($BASELINE_COUNT files)"
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
  DIFF_COUNT=0
  DIFF_LIST="[]"
  if [[ "$RESULT" == "fail" ]] && [[ -d "e2e/test-results" ]]; then
    DIFF_FILES=$(find e2e/test-results -name '*-diff.png' 2>/dev/null || true)
    if [[ -n "$DIFF_FILES" ]]; then
      DIFF_COUNT=$(echo "$DIFF_FILES" | wc -l | tr -d ' ')
      DIFF_LIST="["
      FIRST=true
      while IFS= read -r f; do
        $FIRST || DIFF_LIST+=","
        FIRST=false
        DIFF_LIST+="\"$f\""
      done <<< "$DIFF_FILES"
      DIFF_LIST+="]"
    fi
  fi

  cat > "$REPORT_FILE" <<ENDJSON
{
  "status": "$RESULT",
  "baselineDir": "$BASELINE_DIR",
  "baselineCount": $BASELINE_COUNT,
  "thresholds": { "maxDiffPixelRatio": 0.01, "threshold": 0.2, "animations": "disabled" },
  "diffCount": $DIFF_COUNT,
  "artifacts": $DIFF_LIST,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
ENDJSON
  echo "  JSON report: $REPORT_FILE"
fi

if [[ "$RESULT" == "fail" ]]; then
  exit ${EXIT_CODE:-1}
fi
