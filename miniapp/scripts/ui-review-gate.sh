#!/usr/bin/env bash
# UI Review Gate — Phase 5A
#
# Runs Playwright smoke tests as a mandatory quality gate for frontend tasks.
# Captures screenshots on desktop + mobile viewports and produces a pass/fail verdict.
#
# Usage:
#   ./scripts/ui-review-gate.sh
#
# Artifacts:
#   e2e/results/screenshots/ — per-page screenshots (desktop + mobile)
#   e2e/results/report.json  — structured run report
#
# Exit codes: 0 = pass, 1 = fail, 2 = build failure

set -euo pipefail
cd "$(dirname "$0")/.."

RESULTS_DIR="e2e/results"
SCREENSHOTS_DIR="$RESULTS_DIR/screenshots"
REPORT_FILE="$RESULTS_DIR/report.json"

mkdir -p "$SCREENSHOTS_DIR"

if [[ ! -d .output ]] || [[ $(find app/ -newer .output/server/index.mjs -print -quit 2>/dev/null) ]]; then
  echo "==> Building app (source newer than .output)..."
  if ! npx nuxt build --quiet 2>&1 | tail -5; then
    echo "FAIL: Build failed"
    echo '{"passed":false,"reason":"build_failed","tests":[]}' > "$REPORT_FILE"
    echo "artifact: $REPORT_FILE"
    exit 2
  fi
fi

echo "==> Running UI smoke tests (desktop + mobile viewports)..."
START_TS=$(date +%s)

set +e
npx playwright test e2e/smoke.spec.ts \
  --reporter=json \
  --output="$RESULTS_DIR" \
  2>"$RESULTS_DIR/stderr.log" \
  >"$RESULTS_DIR/playwright-output.json"
EXIT_CODE=$?
set -e

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))

TOTAL=$(jq '.stats.expected // 0' "$RESULTS_DIR/playwright-output.json" 2>/dev/null || echo "0")
PASSED=$(jq '.stats.expected // 0' "$RESULTS_DIR/playwright-output.json" 2>/dev/null || echo "0")
FAILED=$(jq '.stats.unexpected // 0' "$RESULTS_DIR/playwright-output.json" 2>/dev/null || echo "0")

if [[ "$EXIT_CODE" -eq 0 ]]; then VERDICT="pass"; else VERDICT="fail"; fi

SCREENSHOT_COUNT=0
if [[ -d "$RESULTS_DIR" ]]; then
  for img in $(find "$RESULTS_DIR" -name "*.png" -type f 2>/dev/null); do
    cp "$img" "$SCREENSHOTS_DIR/" 2>/dev/null || true
    SCREENSHOT_COUNT=$((SCREENSHOT_COUNT + 1))
    echo "artifact: $img"
  done
fi

cat > "$REPORT_FILE" <<REPORT_EOF
{
  "passed": $([ "$VERDICT" = "pass" ] && echo "true" || echo "false"),
  "verdict": "$VERDICT",
  "durationSeconds": $DURATION,
  "totalTests": $TOTAL,
  "passedTests": $PASSED,
  "failedTests": $FAILED,
  "screenshotCount": $SCREENSHOT_COUNT,
  "screenshotsDir": "$SCREENSHOTS_DIR",
  "exitCode": $EXIT_CODE,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
REPORT_EOF

echo "artifact: $REPORT_FILE"
echo ""
if [[ "$VERDICT" = "pass" ]]; then
  echo "PASS: All UI smoke tests passed ($TOTAL tests, ${DURATION}s)"
  echo "  Screenshots: $SCREENSHOTS_DIR ($SCREENSHOT_COUNT files)"
  echo "  Report:      $REPORT_FILE"
  exit 0
else
  echo "FAIL: UI smoke tests failed ($FAILED of $TOTAL failed, ${DURATION}s)"
  echo "  Screenshots: $SCREENSHOTS_DIR ($SCREENSHOT_COUNT files)"
  echo "  Report:      $REPORT_FILE"
  echo "  Stderr:      $RESULTS_DIR/stderr.log"
  exit 1
fi
