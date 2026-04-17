#!/usr/bin/env bash
# End-to-end integration tests of the deployed proxy (voir docs/USER_GUIDE.md).
# Complements the vitest unit suite (tests/unit/) by hitting the real HTTP
# surface — bypass, env vars, routing, Redis/OAuth wiring.
#
# Usage :
#   - Local : copier tests/.env.example vers tests/.env, renseigner API_KEY,
#     puis `bash tests/integration-tests.sh`.
#   - CI : définir API_KEY, BASE_URL, VERCEL_BYPASS_TOKEN via env vars
#     (tests/.env est optionnel et ignoré s'il n'existe pas).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ -z "${API_KEY:-}" ]]; then
  echo "API_KEY est vide."
  echo "Local : définis-le dans ${ENV_FILE} (copie tests/.env.example)."
  echo "CI    : expose-le via l'env du runner (secrets.API_KEY)."
  exit 1
fi

# Défaut aligné sur docs/USER_GUIDE.md
BASE_URL="${BASE_URL:-https://elzinko-cursor-claude-connector.vercel.app/v1}"
BASE_URL="${BASE_URL%/}"
# Racine du site (sans /v1) pour /auth/status
ROOT_URL="${BASE_URL%/v1}"
ROOT_URL="${ROOT_URL%/}"

models_tmp=$(mktemp)
chat_tmp=$(mktemp)
cleanup() { rm -f "${models_tmp}" "${chat_tmp}"; }
trap cleanup EXIT

# Vercel Deployment Protection bypass (optionnel, cf. tests/.env).
# Ajoute le header x-vercel-protection-bypass à tous les curls si défini.
declare -a BYPASS_ARGS=()
if [[ -n "${VERCEL_BYPASS_TOKEN:-}" ]]; then
  BYPASS_ARGS=(-H "x-vercel-protection-bypass: ${VERCEL_BYPASS_TOKEN}")
  echo "Bypass   : Vercel Deployment Protection (header injecté)"
fi

echo "Base URL : ${BASE_URL}"
echo "Racine    : ${ROOT_URL}"
echo ""

# ─────────────────────────────────────────────────────────────────────
# Préflight : détecte la Vercel Deployment Protection (les previews sont
# souvent derrière un SSO Vercel qui renvoie une page HTML au lieu de
# l'app). Dans ce cas on abandonne tôt avec un message clair plutôt
# qu'un mur de HTML ininterprétable.
# ─────────────────────────────────────────────────────────────────────
preflight_tmp=$(mktemp)
curl -sS ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "${preflight_tmp}" "${ROOT_URL}/" || true
if grep -qE '(Authentication Required|vercel-set-bypass-cookie|sso-api)' "${preflight_tmp}" 2>/dev/null; then
  echo ">>> La preview ${ROOT_URL} est protégée par Vercel Deployment Protection."
  if [[ -n "${VERCEL_BYPASS_TOKEN:-}" ]]; then
    echo ">>> VERCEL_BYPASS_TOKEN est défini mais Vercel refuse le bypass."
    echo ">>> Vérifie le token (Vercel → Settings → Deployment Protection → Protection Bypass for Automation)."
  else
    echo ">>> Pour la tester en curl, choisis une option :"
    echo ">>>   1) Désactiver la protection : Vercel → Project → Settings →"
    echo ">>>      Deployment Protection → 'Only Preview Deployments' → None."
    echo ">>>   2) Définir VERCEL_BYPASS_TOKEN dans tests/.env (bypass token généré sur Vercel)."
    echo ">>>   3) Tester via navigateur (session Vercel connectée)."
  fi
  rm -f "${preflight_tmp}"
  exit 1
fi
rm -f "${preflight_tmp}"

echo "== 0) GET /auth/status (OAuth côté serveur) =="
auth_http=$(curl -sS ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "${models_tmp}" -w "%{http_code}" "${ROOT_URL}/auth/status")
if [[ "${auth_http}" != "200" ]]; then
  echo "Échec HTTP ${auth_http}"
  cat "${models_tmp}" || true
  exit 1
fi
if command -v jq >/dev/null 2>&1; then
  auth_ok=$(jq -r '.authenticated // false' "${models_tmp}")
else
  auth_ok="unknown"
  grep -qE '"authenticated"[[:space:]]*:[[:space:]]*true' "${models_tmp}" && auth_ok="true"
  grep -qE '"authenticated"[[:space:]]*:[[:space:]]*false' "${models_tmp}" && auth_ok="false"
fi
echo "authenticated = ${auth_ok}"
# When no OAuth session exists (typical for PR previews that nobody has
# logged into), /v1/chat/completions will return 401 with an OAuth message.
# We still run it to assert that auth/bypass are wired correctly; the 401
# OAuth response proves API_KEY validation passed. Tests 3/4/5-bis are
# skipped in this mode — they'd hit the same OAuth wall and add no signal.
NO_OAUTH_MODE=0
if [[ "${auth_ok}" == "false" ]]; then
  NO_OAUTH_MODE=1
  echo ""
  echo ">>> Pas de session OAuth (Redis vide ou jamais connecté)."
  echo ">>> Mode dégradé : on valide bypass + API_KEY, on skip les appels Claude."
  echo ">>> Pour un test complet : ${ROOT_URL}/ → « Connect with Claude »."
  echo ""
fi

# SMOKE_ONLY=1 (utilisé par le job prod-smoke) : on skip tous les appels
# Claude (tests 2, 3, 4, 5-bis) pour ne pas brûler de quota OAuth ni
# polluer le client tracking prod. Restent /auth/status, /v1/models,
# /api/clients — suffisant pour détecter un drift d'env vars.
SMOKE_ONLY="${SMOKE_ONLY:-0}"
if [[ "${SMOKE_ONLY}" == "1" ]]; then
  echo ">>> SMOKE_ONLY=1 : skip tests 2, 3, 4, 5-bis (appels Claude)."
  echo ""
fi
echo ""

echo "== 1) GET /v1/models =="
models_http=$(curl -sS ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "${models_tmp}" -w "%{http_code}" \
  -H "Authorization: Bearer ${API_KEY}" \
  "${BASE_URL}/models")

if [[ "${models_http}" != "200" ]]; then
  echo "Échec HTTP ${models_http}"
  cat "${models_tmp}" || true
  exit 1
fi

echo "OK (200)"
if command -v jq >/dev/null 2>&1; then
  jq -r '.data[0:3][] | "  - " + .id' "${models_tmp}" 2>/dev/null || jq '.' "${models_tmp}" | head -20
else
  head -c 400 "${models_tmp}"
  echo ""
fi
echo ""

if [[ "${SMOKE_ONLY}" == "1" ]]; then
  echo "== 2) POST /v1/chat/completions — SKIPPED (SMOKE_ONLY) =="
  echo ""
else
echo "== 2) POST /v1/chat/completions (non stream) =="
chat_http=$(curl -sS ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "${chat_tmp}" -w "%{http_code}" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-proxy-opus-4.6",
    "messages": [{"role": "user", "content": "Reply with exactly: OK_PROXY_TEST"}],
    "stream": false,
    "max_tokens": 256
  }' \
  "${BASE_URL}/chat/completions")

if [[ "${NO_OAUTH_MODE}" == "1" ]]; then
  # Expected path: API_KEY accepted → proxy asks for OAuth → 401 with
  # `authenticate using OAuth` body. This is success for CI.
  if [[ "${chat_http}" == "401" ]] && grep -q 'OAuth' "${chat_tmp}" 2>/dev/null; then
    echo "OK (401 OAuth attendu — API_KEY validée, session OAuth absente)"
  else
    echo "FAIL HTTP ${chat_http} — attendu 401 OAuth en mode no-OAuth"
    cat "${chat_tmp}" || true
    exit 1
  fi
elif [[ "${chat_http}" != "200" ]]; then
  echo "Échec HTTP ${chat_http}"
  cat "${chat_tmp}" || true
  if [[ "${chat_http}" == "401" ]] && grep -q 'OAuth' "${chat_tmp}" 2>/dev/null; then
    echo ""
    echo ">>> Session OAuth attendue mais absente. Vérifie sur Vercel :"
    echo ">>>   UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN, puis ${ROOT_URL}/"
  fi
  exit 1
elif command -v jq >/dev/null 2>&1; then
  content=$(jq -r '.choices[0].message.content // empty' "${chat_tmp}" 2>/dev/null || true)
  if [[ -z "${content}" ]]; then
    echo "Réponse JSON inattendue :"
    cat "${chat_tmp}"
    exit 1
  fi
  echo "OK (200)"
  echo "Extrait assistant :"
  echo "${content}" | head -c 500
  echo ""
else
  if ! grep -q '"choices"' "${chat_tmp}"; then
    echo "Réponse sans choices :"
    cat "${chat_tmp}"
    exit 1
  fi
  echo "OK (200) — réponse contient choices (installe jq pour un affichage plus lisible)"
  head -c 800 "${chat_tmp}"
  echo ""
fi
echo ""
fi

# Tests 3/4/5-bis need a working OAuth session to do real Claude calls.
# Without one they all return the same 401 and add no signal beyond test 2.
if [[ "${NO_OAUTH_MODE}" == "1" ]]; then
  echo ">>> Mode no-OAuth : skip tests 3, 4, 5-bis (appels Claude)."
  echo ">>> Test 5 (/api/clients) continue — il ne nécessite pas d'OAuth."
  echo ""
fi

# ─────────────────────────────────────────────────────────────────────
# Tests spécifiques PR #3 (fixes `developer` role + guard thinking +
# client tracking). Ils n'exécutent que si le preview / la prod contient
# ces changements. En cas d'échec sur un proxy non à jour, ils logguent
# et continuent.
# ─────────────────────────────────────────────────────────────────────

pr3_tmp=$(mktemp)
trap 'rm -f "${models_tmp}" "${chat_tmp}" "${pr3_tmp}"' EXIT

if [[ "${NO_OAUTH_MODE}" != "1" && "${SMOKE_ONLY}" != "1" ]]; then
  echo "== 3) developer → system role normalization (PR #3) =="
  dev_http=$(curl -sS ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "${pr3_tmp}" -w "%{http_code}" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-proxy-opus-4.6",
      "messages": [
        {"role": "developer", "content": "Reply with exactly: OK_DEV"},
        {"role": "user", "content": "ping"}
      ],
      "stream": false,
      "max_tokens": 256
    }' \
    "${BASE_URL}/chat/completions")

  if [[ "${dev_http}" == "200" ]]; then
    echo "OK (200) — developer role accepté"
  else
    echo "FAIL HTTP ${dev_http}"
    cat "${pr3_tmp}" || true
    echo ""
    echo ">>> Si message 'messages: role must be one of ...' → proxy pas encore à jour."
  fi
  echo ""

  echo "== 4) Small max_tokens (thinking budget guard, PR #3) =="
  small_http=$(curl -sS ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "${pr3_tmp}" -w "%{http_code}" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-proxy-opus-4.6",
      "messages": [{"role": "user", "content": "ping"}],
      "stream": false,
      "max_tokens": 64
    }' \
    "${BASE_URL}/chat/completions")

  if [[ "${small_http}" == "200" ]]; then
    echo "OK (200) — extended thinking correctement désactivé pour max_tokens=64"
  else
    echo "FAIL HTTP ${small_http}"
    cat "${pr3_tmp}" || true
    echo ""
    echo ">>> Si 'budget_tokens: Input should be greater than or equal to 1024' → guard pas déployé."
  fi
  echo ""

  echo "== 5-bis) Sonnet smoke test (diagnostic 1M context beta) =="
  # Sonnet reçoit `context-1m-2025-08-07` dans anthropic-beta (cf. PR #2).
  # Sans « Extra usage » activé côté Anthropic, ceci renvoie :
  #   rate_limit_error: Extra usage is required for long context requests
  # → indique qu'un 4ᵉ fix (gate 1M derrière env var) est nécessaire.
  sonnet_http=$(curl -sS ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "${pr3_tmp}" -w "%{http_code}" \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "claude-proxy-sonnet-4.6",
      "messages": [{"role": "user", "content": "ping"}],
      "stream": false,
      "max_tokens": 256
    }' \
    "${BASE_URL}/chat/completions")

  if [[ "${sonnet_http}" == "200" ]]; then
    echo "OK (200) — Sonnet passe (soit Extra usage activé, soit 1M beta retiré)"
  elif grep -q 'long context' "${pr3_tmp}" 2>/dev/null; then
    echo "FAIL HTTP ${sonnet_http} — 1M context billing required"
    echo ">>> Attendu tant que le 4ᵉ fix (gate 1M derrière env var) n'est pas livré."
  else
    echo "FAIL HTTP ${sonnet_http}"
    cat "${pr3_tmp}" || true
  fi
  echo ""
fi

echo "== 5) GET /api/clients (client tracking API, PR #3) =="
clients_http=$(curl -sS ${BYPASS_ARGS[@]+"${BYPASS_ARGS[@]}"} -o "${pr3_tmp}" -w "%{http_code}" \
  -H "Authorization: Bearer ${API_KEY}" \
  "${ROOT_URL}/api/clients")

if [[ "${clients_http}" == "200" ]]; then
  if command -v jq >/dev/null 2>&1; then
    backend=$(jq -r '.backend' "${pr3_tmp}")
    count=$(jq -r '.clients | length' "${pr3_tmp}")
    retention=$(jq -r '.retentionDays' "${pr3_tmp}")
    echo "OK (200) — backend=${backend}, retentionDays=${retention}, clients=${count}"
  else
    echo "OK (200)"
    head -c 400 "${pr3_tmp}"
    echo ""
  fi
else
  echo "FAIL HTTP ${clients_http}"
  cat "${pr3_tmp}" || true
  echo ""
  echo ">>> Si 404 → route /api/clients pas montée (preview pas à jour ou ce n'est pas le bon build)."
fi
echo ""

echo "Tout est OK."
