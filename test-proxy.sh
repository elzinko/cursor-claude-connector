#!/bin/bash
# =============================================================================
# Cursor-Claude Connector - Proxy Integration Tests
# =============================================================================
# Starts the proxy server, runs tests against it, then shuts it down.
#
# Usage:
#   ./test-proxy.sh          # Run all tests
#   ./test-proxy.sh --quick  # Skip slow tests (streaming)
# =============================================================================

set -uo pipefail

BASE_URL="http://localhost:9095"
PASSED=0
FAILED=0
SKIPPED=0
QUICK_MODE=false
SERVER_PID=""
LAST_BODY=""
LAST_STATUS=""

[[ "${1:-}" == "--quick" ]] && QUICK_MODE=true

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ---------- helpers ----------

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  lsof -ti:9095 2>/dev/null | xargs kill 2>/dev/null || true
}
trap cleanup EXIT

log_header() { printf "\n${BOLD}${CYAN}== %s ==${NC}\n" "$1"; }
log_pass()   { printf "  ${GREEN}PASS${NC} %s\n" "$1"; PASSED=$((PASSED + 1)); }
log_fail()   { printf "  ${RED}FAIL${NC} %s\n" "$1"; FAILED=$((FAILED + 1)); }
log_skip()   { printf "  ${YELLOW}SKIP${NC} %s\n" "$1"; SKIPPED=$((SKIPPED + 1)); }

# http_test <description> <expected_status> <curl_args...>
http_test() {
  local desc="$1" expected="$2"
  shift 2
  local response status body
  response=$(curl -s -w "\n__HTTP_STATUS__%{http_code}" "$@" 2>&1)
  status=$(echo "$response" | grep '__HTTP_STATUS__' | sed 's/.*__HTTP_STATUS__//')
  body=$(echo "$response" | sed '/__HTTP_STATUS__/d')

  if [[ "$status" == "$expected" ]]; then
    log_pass "$desc (HTTP $status)"
  else
    log_fail "$desc (expected $expected, got $status)"
    printf "    ${RED}Response: %.200s${NC}\n" "$body"
  fi
  LAST_BODY="$body"
  LAST_STATUS="$status"
}

# body_contains <pattern> <pass_msg> <fail_msg>
body_contains() {
  if echo "$LAST_BODY" | grep -q "$1"; then
    log_pass "$2"
  else
    log_fail "$3"
  fi
}

# ---------- Load API key from .env ----------

if [[ ! -f .env ]]; then
  printf "${RED}Error: .env file not found. Copy env.example to .env and configure it.${NC}\n"
  exit 1
fi

API_KEY=$(grep '^API_KEY=' .env | head -1 | cut -d= -f2-)
if [[ -z "$API_KEY" ]]; then
  printf "${YELLOW}Warning: API_KEY not set in .env, auth tests will be skipped${NC}\n"
fi

# ---------- Start server ----------

log_header "Starting proxy server"

lsof -ti:9095 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1

npx tsx --env-file=.env src/server.ts > /tmp/proxy-test-server.log 2>&1 &
SERVER_PID=$!
printf "  Server PID: %s\n" "$SERVER_PID"

for i in $(seq 1 10); do
  if curl -s "$BASE_URL/auth/status" > /dev/null 2>&1; then
    printf "  ${GREEN}Server ready${NC}\n"
    break
  fi
  if [[ $i -eq 10 ]]; then
    printf "  ${RED}Server failed to start. Logs:${NC}\n"
    cat /tmp/proxy-test-server.log
    exit 1
  fi
  sleep 1
done

# =============================================================================
# 1. Health & Auth checks
# =============================================================================
log_header "1. Health & Auth"

http_test "GET / returns HTML" 200 "$BASE_URL/"

http_test "GET /auth/status returns auth state" 200 "$BASE_URL/auth/status"
body_contains '"authenticated":true' \
  "OAuth is authenticated" \
  "OAuth NOT authenticated (run server and authenticate first)"

http_test "GET /v1/models returns model list" 200 "$BASE_URL/v1/models"
body_contains '"object":"list"' \
  "/v1/models returns valid list" \
  "/v1/models response is not a valid list"

# =============================================================================
# 2. API Key validation
# =============================================================================
log_header "2. API Key Validation"

if [[ -n "$API_KEY" ]]; then
  http_test "Reject request without API key" 401 \
    -X POST "$BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}]}'

  http_test "Reject request with wrong API key" 401 \
    -X POST "$BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer wrong-key-12345" \
    -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"hi"}]}'

  http_test "Accept request with correct API key" 200 \
    -X POST "$BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d '{"model":"claude-sonnet-4-20250514","messages":[{"role":"user","content":"Say OK"}],"stream":false}'
else
  log_skip "API key tests (API_KEY not set)"
fi

# =============================================================================
# 3. Cursor BYOK bypass
# =============================================================================
log_header "3. Cursor BYOK Bypass"

http_test "Bypass GPT-4o validation request" 200 \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY:-test}" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"stream":false}'

body_contains '"model":"gpt-4o-2024-08-06"' \
  "Bypass returns fake GPT-4o response" \
  "Bypass response doesn't look like expected GPT-4o format"

http_test "Bypass gpt-3.5-turbo test prompt" 200 \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY:-test}" \
  -d '{"model":"gpt-3.5-turbo","messages":[{"role":"user","content":"Test prompt using gpt-3.5-turbo"}],"stream":false}'

# =============================================================================
# 4. Model name mapping (non-streaming)
# =============================================================================
log_header "4. Model Name Mapping"

test_model() {
  local model="$1" desc="$2"
  http_test "Model mapping: $desc ($model)" 200 \
    -X POST "$BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY:-test}" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK\"}],\"stream\":false}"

  body_contains '"choices"' \
    "  -> Response has OpenAI choices format" \
    "  -> Response missing OpenAI choices format"
}

test_model "claude-sonnet-4-6-20250514" "Sonnet 4.6 (Cursor name -> claude-sonnet-4-6)"
test_model "claude-sonnet-4-6"          "Sonnet 4.6 (native name)"
test_model "claude-sonnet-4-20250514"   "Sonnet 4.0 (native name)"
test_model "claude-3-5-sonnet-20241022" "Sonnet 3.5 legacy -> Sonnet 4.6"
test_model "claude-3-7-sonnet-20250219" "Sonnet 3.7 legacy -> Sonnet 4.6"

# =============================================================================
# 5. OpenAI format conversion (non-streaming)
# =============================================================================
log_header "5. OpenAI Format Conversion"

http_test "Non-streaming: OpenAI format response" 200 \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY:-test}" \
  -d '{"model":"claude-sonnet-4-6-20250514","messages":[{"role":"user","content":"Respond with exactly: hello world"}],"stream":false}'

for field in '"object":"chat.completion"' '"choices"' '"finish_reason"' '"usage"' '"prompt_tokens"' '"completion_tokens"'; do
  body_contains "$field" "  Has field: $field" "  Missing field: $field"
done

# =============================================================================
# 6. Body sanitization (extra OpenAI fields should not cause errors)
# =============================================================================
log_header "6. Body Sanitization"

http_test "Request with extra OpenAI fields (frequency_penalty, n, etc.)" 200 \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY:-test}" \
  -d '{
    "model": "claude-sonnet-4-6-20250514",
    "messages": [{"role":"user","content":"Say OK"}],
    "stream": false,
    "frequency_penalty": 0.5,
    "presence_penalty": 0.3,
    "n": 1,
    "logprobs": false,
    "top_logprobs": null,
    "response_format": {"type": "text"},
    "seed": 42
  }'

# =============================================================================
# 7. System message handling
# =============================================================================
log_header "7. System Message Handling"

http_test "Request with system message (OpenAI format)" 200 \
  -X POST "$BASE_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY:-test}" \
  -d '{
    "model": "claude-sonnet-4-6-20250514",
    "messages": [
      {"role":"system","content":"You must respond with exactly one word: Arrr"},
      {"role":"user","content":"Say hello"}
    ],
    "stream": false
  }'

# =============================================================================
# 8. Streaming
# =============================================================================
log_header "8. Streaming"

if $QUICK_MODE; then
  log_skip "Streaming tests (--quick mode)"
else
  STREAM_RESP=$(curl -s -N --max-time 30 \
    -X POST "$BASE_URL/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY:-test}" \
    -d '{
      "model": "claude-sonnet-4-6-20250514",
      "messages": [{"role":"user","content":"Say hello"}],
      "stream": true
    }' 2>&1)

  if echo "$STREAM_RESP" | grep -q 'data: \[DONE\]'; then
    log_pass "Streaming: received [DONE] marker"
  else
    log_fail "Streaming: missing [DONE] marker"
  fi

  if echo "$STREAM_RESP" | grep -q '"chat.completion.chunk"'; then
    log_pass "Streaming: chunks have correct object type"
  else
    log_fail "Streaming: chunks missing chat.completion.chunk type"
  fi

  if echo "$STREAM_RESP" | grep -q '"finish_reason":"stop"'; then
    log_pass "Streaming: has finish_reason=stop"
  else
    log_fail "Streaming: missing finish_reason=stop"
  fi

  if echo "$STREAM_RESP" | grep -q '"usage"'; then
    log_pass "Streaming: has usage chunk"
  else
    log_fail "Streaming: missing usage chunk"
  fi
fi

# =============================================================================
# 9. Anthropic native format (Claude Code pass-through)
# =============================================================================
log_header "9. Anthropic Native Format (Claude Code)"

http_test "Native Anthropic request (no conversion)" 200 \
  -X POST "$BASE_URL/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY:-test}" \
  -d "{
    \"model\": \"claude-sonnet-4-20250514\",
    \"max_tokens\": 100,
    \"system\": [{\"type\":\"text\",\"text\":\"You are Claude Code, Anthropic's official CLI for Claude.\"}],
    \"messages\": [{\"role\":\"user\",\"content\":\"Say OK\"}],
    \"stream\": false
  }"

body_contains '"type":"message"' \
  "  Response is native Anthropic format (not converted)" \
  "  Response should be native Anthropic format"

# =============================================================================
# Summary
# =============================================================================
echo ""
printf "${BOLD}============================================${NC}\n"
TOTAL=$((PASSED + FAILED))
printf "${BOLD}  Results: ${GREEN}%d passed${NC}, ${RED}%d failed${NC}, ${YELLOW}%d skipped${NC} / %d total\n" "$PASSED" "$FAILED" "$SKIPPED" "$TOTAL"
printf "${BOLD}============================================${NC}\n"

if [[ $FAILED -gt 0 ]]; then
  echo ""
  printf "Server logs: cat /tmp/proxy-test-server.log\n"
  exit 1
fi
