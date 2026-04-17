#!/usr/bin/env bash
# Temporary debug probe for the "out of extra usage on 14+ tools" diagnosis.
#
# Sends probes against the preview proxy with `x-debug-trace: 1` so the
# sanitized [DEBUG-BODY]/[DEBUG-HEADERS] are echoed back as response
# headers (gated server-side: preview env only + sanitized content).
#
# Scenarios:
#   1. 13 tools, minimal descriptions, no system        (baseline 200)
#   2. 22 tools, minimal descriptions, no system        (original repro)
#   3. 22 tools, realistic descriptions + 6 KB system   (openclaw-like)
#
# Required env:
#   API_KEY, BASE_URL
#   VERCEL_BYPASS_TOKEN (optional; required on preview SSO)
#
# Non-blocking: exits 0 even on non-2xx.

set -uo pipefail

: "${API_KEY:?API_KEY is required}"
: "${BASE_URL:?BASE_URL is required}"
BASE_URL="${BASE_URL%/}"

declare -a BYPASS_ARGS=()
if [[ -n "${VERCEL_BYPASS_TOKEN:-}" ]]; then
  BYPASS_ARGS=(-H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}")
fi

# Minimal tool: {name:"tXX", description:"<single letter>"}.
build_tools_minimal() {
  local n="$1"
  local out="["
  for ((i = 1; i <= n; i++)); do
    local id
    printf -v id "t%02d" "$i"
    local letter
    letter=$(printf "\\$(printf '%03o' $((96 + (i - 1) % 26 + 1)))")
    [[ $i -gt 1 ]] && out+=","
    out+="{\"type\":\"function\",\"function\":{\"name\":\"${id}\",\"description\":\"${letter}\",\"parameters\":{\"type\":\"object\"}}}"
  done
  out+="]"
  printf '%s' "$out"
}

# Realistic tool: ~250 char description + 3-5 typed parameters, mirroring the
# shape of a dev-tool suite (openclaw has file ops, shell, search, etc.).
build_tools_realistic() {
  local n="$1"
  local out="["
  for ((i = 1; i <= n; i++)); do
    local id
    printf -v id "tool_%02d" "$i"
    [[ $i -gt 1 ]] && out+=","
    out+=$(cat <<JSON
{"type":"function","function":{"name":"${id}","description":"Operation ${id}: performs a complex structured action against the workspace. Accepts a target path, an optional pattern for filtering, an integer limit, and a boolean for dry-run semantics. Returns a structured JSON payload describing the changes (or would-be changes) with per-entry metadata including permissions and modification times.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Absolute or relative filesystem path targeted by the operation."},"pattern":{"type":"string","description":"Optional glob or regex used to narrow the scope."},"limit":{"type":"integer","description":"Maximum number of entries to process.","minimum":1,"maximum":1000},"dry_run":{"type":"boolean","description":"When true, report intended changes without applying them."},"include_hidden":{"type":"boolean","description":"Include entries whose names start with a dot."}},"required":["path"]}}}
JSON
)
  done
  out+="]"
  printf '%s' "$out"
}

# ~6 KB system prompt, same rough size profile as openclaw (22 KB system was
# reported as failing; this is smaller but in the "large enough to matter"
# bucket). Deliberately generic — no secret material.
build_system_large() {
  local base="You are a helpful coding assistant. You operate inside a sandboxed developer workspace and help users plan, inspect, and edit source code. You should be precise, concise, and always cite file paths and line numbers when referencing code. When a user asks a question, first consider whether you need to read a file or run a search before answering. Prefer dedicated tools over shell when available. Never invent APIs; if unsure, say so. Respect the user's style conventions. Follow existing patterns in the codebase rather than introducing new ones. Do not add comments that restate the code. Do not create new files unless clearly necessary. Batch related operations in parallel when safe. Ask for confirmation before destructive changes. Keep responses focused. When presenting plans, itemize steps. When presenting diffs, keep them minimal. When reporting failures, include the error message verbatim plus a short hypothesis. "
  local out=""
  for i in 1 2 3 4 5 6; do
    out+="Section ${i} guideline: ${base}"
  done
  # Escape for JSON — replace double quotes and backslashes. Newlines are
  # absent in `base` so no further escaping needed.
  out="${out//\\/\\\\}"
  out="${out//\"/\\\"}"
  printf '%s' "$out"
}

build_payload_minimal() {
  local n="$1"
  local tools
  tools=$(build_tools_minimal "$n")
  printf '{"model":"claude-proxy-opus-4.6","max_tokens":10,"messages":[{"role":"user","content":"pong"}],"tools":%s}' "$tools"
}

build_payload_realistic() {
  local n="$1"
  local tools system
  tools=$(build_tools_realistic "$n")
  system=$(build_system_large)
  printf '{"model":"claude-proxy-opus-4.6","max_tokens":10,"system":"%s","messages":[{"role":"user","content":"pong"}],"tools":%s}' "$system" "$tools"
}

run_probe() {
  local label="$1"
  local payload="$2"

  local ts_start
  ts_start=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ' 2>/dev/null || date -u +'%Y-%m-%dT%H:%M:%SZ')

  echo "=================================================================="
  echo "[PROBE ${label}] start=${ts_start} payload_bytes=${#payload}"
  echo "=================================================================="

  local hdr_tmp body_tmp
  hdr_tmp=$(mktemp)
  body_tmp=$(mktemp)
  local http_code
  http_code=$(curl -sS -D "${hdr_tmp}" -o "${body_tmp}" -w '%{http_code}' -X POST \
    "${BYPASS_ARGS[@]}" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -H "x-debug-trace: 1" \
    --data "${payload}" \
    "${BASE_URL}/chat/completions") || http_code="curl-failed"

  local ts_end
  ts_end=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ' 2>/dev/null || date -u +'%Y-%m-%dT%H:%M:%SZ')

  echo "[PROBE ${label}] end=${ts_end} http=${http_code}"
  echo "--- x-debug-body (echoed by proxy) ---"
  grep -i '^x-debug-body:' "${hdr_tmp}" || echo "(no x-debug-body header — proxy may be in production mode or header filtered)"
  echo "--- x-debug-headers (echoed by proxy) ---"
  grep -i '^x-debug-headers:' "${hdr_tmp}" || echo "(no x-debug-headers header)"
  echo "--- x-debug-error (if any) ---"
  grep -i '^x-debug-error:' "${hdr_tmp}" || true
  echo "--- response body (truncated to 1500 chars) ---"
  head -c 1500 "${body_tmp}"
  echo ""
  echo "--- end ---"
  rm -f "${hdr_tmp}" "${body_tmp}"
}

echo "BASE_URL=${BASE_URL}"

run_probe "01-13tools-minimal-expect-200" "$(build_payload_minimal 13)"
sleep 2
run_probe "02-22tools-minimal-original-repro" "$(build_payload_minimal 22)"
sleep 2
run_probe "03-22tools-realistic-openclaw-like" "$(build_payload_realistic 22)"

exit 0
