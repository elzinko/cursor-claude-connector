#!/usr/bin/env bash
# Temporary debug probe for the "out of extra usage on 14+ tools" diagnosis.
#
# Sends two POST /v1/chat/completions requests against the preview proxy
# (13 tools, then 22 tools) and prints ISO-8601 UTC timestamps + HTTP status
# codes. The proxy emits [DEBUG-BODY] / [DEBUG-HEADERS] lines to Vercel
# runtime logs; the timestamps here let us scope a Vercel runtime-log query
# to the exact window of each probe request.
#
# Required env:
#   API_KEY                : proxy Bearer token
#   BASE_URL               : e.g. https://<preview>.vercel.app/v1
#   VERCEL_BYPASS_TOKEN    : bypass for preview SSO (optional in non-CI)
#
# This script is intentionally non-blocking: exits 0 even on non-2xx so the
# CI job keeps running and uploads the full output. Delete this script and
# its workflow job once the debug commit is reverted.

set -uo pipefail

: "${API_KEY:?API_KEY is required}"
: "${BASE_URL:?BASE_URL is required}"
BASE_URL="${BASE_URL%/}"

declare -a BYPASS_ARGS=()
if [[ -n "${VERCEL_BYPASS_TOKEN:-}" ]]; then
  BYPASS_ARGS=(-H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}")
fi

# Build a tools array of N minimal OpenAI-format function tools.
build_tools() {
  local n="$1"
  local out="["
  for ((i = 1; i <= n; i++)); do
    local id
    printf -v id "t%02d" "$i"
    [[ $i -gt 1 ]] && out+=","
    out+="{\"type\":\"function\",\"function\":{\"name\":\"${id}\",\"description\":\"probe ${id}\",\"parameters\":{\"type\":\"object\"}}}"
  done
  out+="]"
  printf '%s' "$out"
}

build_payload() {
  local n="$1"
  local tools
  tools=$(build_tools "$n")
  printf '{"model":"claude-proxy-opus-4.6","max_tokens":10,"messages":[{"role":"user","content":"pong"}],"tools":%s}' "$tools"
}

run_probe() {
  local n="$1"
  local label="$2"
  local payload
  payload=$(build_payload "$n")

  local ts_start
  ts_start=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ' 2>/dev/null || date -u +'%Y-%m-%dT%H:%M:%SZ')

  echo "=================================================================="
  echo "[PROBE ${label}] start=${ts_start} tools=${n}"
  echo "=================================================================="

  local body_tmp
  body_tmp=$(mktemp)
  local http_code
  http_code=$(curl -sS -o "${body_tmp}" -w '%{http_code}' -X POST \
    "${BYPASS_ARGS[@]}" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    --data "${payload}" \
    "${BASE_URL}/chat/completions") || http_code="curl-failed"

  local ts_end
  ts_end=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ' 2>/dev/null || date -u +'%Y-%m-%dT%H:%M:%SZ')

  echo "[PROBE ${label}] end=${ts_end} http=${http_code}"
  echo "--- response body (truncated to 2000 chars) ---"
  head -c 2000 "${body_tmp}"
  echo ""
  echo "--- end response body ---"
  rm -f "${body_tmp}"
}

echo "BASE_URL=${BASE_URL}"
run_probe 13 "13-tools-expect-200"
sleep 2
run_probe 22 "22-tools-expect-400"

exit 0
