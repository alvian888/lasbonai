#!/usr/bin/env bash
set -uo pipefail

STEP_LABELS=()
STEP_RESULTS=()
REPORT_DIR=""
REPORT_FILE=""
FUNC_BULLISH_OUTPUT=""
FUNC_SAFETY_OUTPUT=""
MODE="full"
STRICT_MODE="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick)
      MODE="quick"
      shift
      ;;
    --strict)
      STRICT_MODE="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: validate-full-stack.sh [--quick] [--strict]"
      exit 2
      ;;
  esac
done

log_line() {
  echo "$1" | tee -a "$REPORT_FILE"
}

extract_json_to_file() {
  local input_file="$1"
  local output_file="$2"

  node -e '
const fs = require("fs");
const input = process.argv[1];
const output = process.argv[2];
const text = fs.readFileSync(input, "utf8");
const start = text.indexOf("{");
const end = text.lastIndexOf("}");
if (start < 0 || end <= start) {
  throw new Error("Unable to locate JSON payload in output");
}
const payload = text.slice(start, end + 1);
JSON.parse(payload);
fs.writeFileSync(output, payload + "\n");
' "$input_file" "$output_file"
}

assert_functional_bullish() {
  local json_file="$1"
  local strict_mode="$2"

  node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const strictMode = process.argv[2] === "true";
const errors = [];
if (data?.baselineDecision?.action !== "buy") {
  errors.push("baselineDecision.action must be buy for bullish scenario");
}
if (data?.decision?.action === "hold") {
  errors.push("decision.action should not be hold for bullish scenario");
}
// execution.mode can be "preview" (dry-run) or "error" (wallet limit in live mode) or "sent" (successful execution)
if (!["preview", "error", "sent"].includes(data?.execution?.mode)) {
  errors.push("execution.mode must be preview, error, or sent for bullish scenario");
}
if (strictMode) {
  if (typeof data?.decision?.confidence !== "number" || data.decision.confidence < 0.6) {
    errors.push("strict mode: decision.confidence must be >= 0.6 for bullish scenario");
  }
  if (!data?.decisionSource) {
    errors.push("strict mode: decisionSource is required");
  }
}
if (errors.length > 0) {
  console.error(errors.join("; "));
  process.exit(1);
}
' "$json_file" "$strict_mode"
}

assert_functional_safety() {
  local json_file="$1"
  local strict_mode="$2"

  node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const strictMode = process.argv[2] === "true";
const errors = [];
if (data?.baselineDecision?.action !== "hold") {
  errors.push("baselineDecision.action must be hold for safety scenario");
}
if (data?.decision?.action !== "hold") {
  errors.push("decision.action must be hold for safety scenario");
}
if (data?.execution !== undefined) {
  errors.push("execution should be absent for safety hold scenario");
}
if (strictMode) {
  if (typeof data?.decision?.confidence !== "number" || data.decision.confidence > 0.8) {
    errors.push("strict mode: safety decision.confidence must be <= 0.8");
  }
  if (data?.decisionSource !== "baseline") {
    errors.push("strict mode: safety decisionSource must be baseline");
  }
}
if (errors.length > 0) {
  console.error(errors.join("; "));
  process.exit(1);
}
' "$json_file" "$strict_mode"
}

run_step() {
  local label="$1"
  shift
  local output_file
  output_file="$(mktemp)"

  log_line ""
  log_line "[validate] $label"

  if "$@" >"$output_file" 2>&1; then
    cat "$output_file" | tee -a "$REPORT_FILE"
    STEP_LABELS+=("$label")
    STEP_RESULTS+=("SUCCESS")
    log_line "[validate] $label -> SUCCESS"

    if [[ "$label" == "functional-bullish" ]]; then
      FUNC_BULLISH_OUTPUT="$output_file"
    elif [[ "$label" == "functional-safety" ]]; then
      FUNC_SAFETY_OUTPUT="$output_file"
    else
      rm -f "$output_file"
    fi

    return 0
  fi

  cat "$output_file" | tee -a "$REPORT_FILE"
  STEP_LABELS+=("$label")
  STEP_RESULTS+=("FAILED")
  log_line "[validate] $label -> FAILED"
  rm -f "$output_file"
  return 1
}

print_summary() {
  local index
  log_line ""
  log_line "[validate] summary"
  for index in "${!STEP_LABELS[@]}"; do
    log_line "- ${STEP_LABELS[$index]}: ${STEP_RESULTS[$index]}"
  done
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT_DIR="$PROJECT_ROOT/data/validation-reports"

mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/validate-full-$(date +%Y%m%d-%H%M%S).log"

log_line "[validate] mode: $MODE"
log_line "[validate] strict: $STRICT_MODE"

cd "$PROJECT_ROOT"

overall_status=0

run_step "build" npm run -s build || overall_status=1
run_step "preflight" npm run -s live:preflight || overall_status=1
run_step "health" npm run -s health:local-agent || overall_status=1
run_step "functional-bullish" npm run -s cli run -- --market-context "Bullish breakout with accumulation setup and momentum confirmation" || overall_status=1
run_step "functional-safety" npm run -s cli run -- --market-context "Prioritas aman, observe market only" || overall_status=1

if [[ "$overall_status" -eq 0 ]]; then
  bullish_json="$(mktemp)"
  safety_json="$(mktemp)"

  if extract_json_to_file "$FUNC_BULLISH_OUTPUT" "$bullish_json" && assert_functional_bullish "$bullish_json" "$STRICT_MODE"; then
    STEP_LABELS+=("assert-bullish")
    STEP_RESULTS+=("SUCCESS")
    log_line "[validate] assert-bullish -> SUCCESS"
  else
    STEP_LABELS+=("assert-bullish")
    STEP_RESULTS+=("FAILED")
    log_line "[validate] assert-bullish -> FAILED"
    overall_status=1
  fi

  if extract_json_to_file "$FUNC_SAFETY_OUTPUT" "$safety_json" && assert_functional_safety "$safety_json" "$STRICT_MODE"; then
    STEP_LABELS+=("assert-safety")
    STEP_RESULTS+=("SUCCESS")
    log_line "[validate] assert-safety -> SUCCESS"
  else
    STEP_LABELS+=("assert-safety")
    STEP_RESULTS+=("FAILED")
    log_line "[validate] assert-safety -> FAILED"
    overall_status=1
  fi

  rm -f "$bullish_json" "$safety_json"
fi

if [[ "$MODE" == "full" ]]; then
  run_step "candidate-export" npm run -s export:candidates || overall_status=1
  run_step "telegram" npm run -s telegram:test || overall_status=1
else
  STEP_LABELS+=("candidate-export")
  STEP_RESULTS+=("SKIP")
  log_line "[validate] candidate-export -> SKIP (quick mode)"
  STEP_LABELS+=("telegram")
  STEP_RESULTS+=("SKIP")
  log_line "[validate] telegram -> SKIP (quick mode)"
fi

print_summary

log_line ""
if [[ "$overall_status" -eq 0 ]]; then
  log_line "[validate] all checks passed"
else
  log_line "[validate] one or more checks failed"
fi

log_line "[validate] report: $REPORT_FILE"

if [[ -n "$FUNC_BULLISH_OUTPUT" ]]; then
  rm -f "$FUNC_BULLISH_OUTPUT"
fi

if [[ -n "$FUNC_SAFETY_OUTPUT" ]]; then
  rm -f "$FUNC_SAFETY_OUTPUT"
fi

exit "$overall_status"