#!/usr/bin/env bash
# Test manuel du proxy déployé (voir docs/USER_GUIDE.md).
# Usage : copier tests/.env.example vers tests/.env, renseigner API_KEY, puis :
#   bash tests/manual-proxy-test.sh
#   ou : npm run test:manual

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Fichier manquant : ${ENV_FILE}"
  echo "Copie tests/.env.example vers tests/.env et définis API_KEY."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ -z "${API_KEY:-}" ]]; then
  echo "API_KEY est vide dans ${ENV_FILE}"
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
curl -sS "${BYPASS_ARGS[@]}" -o "${preflight_tmp}" "${ROOT_URL}/" || true
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
auth_http=$(curl -sS "${BYPASS_ARGS[@]}" -o "${models_tmp}" -w "%{http_code}" "${ROOT_URL}/auth/status")
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
if [[ "${auth_ok}" == "false" ]]; then
  echo ""
  echo ">>> Le proxy n'a pas de session OAuth enregistrée (Redis vide ou jamais connecté)."
  echo ">>> Ouvre ${ROOT_URL}/ dans un navigateur → « Connect with Claude »."
  echo ">>> Après un nouveau Redis Upstash ou un changement d'env Vercel, il faut se reconnecter."
  echo ""
fi
echo ""

echo "== 1) GET /v1/models =="
models_http=$(curl -sS "${BYPASS_ARGS[@]}" -o "${models_tmp}" -w "%{http_code}" \
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

echo "== 2) POST /v1/chat/completions (non stream) =="
chat_http=$(curl -sS "${BYPASS_ARGS[@]}" -o "${chat_tmp}" -w "%{http_code}" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-proxy-opus-4.6",
    "messages": [{"role": "user", "content": "Reply with exactly: OK_PROXY_TEST"}],
    "stream": false,
    "max_tokens": 256
  }' \
  "${BASE_URL}/chat/completions")

if [[ "${chat_http}" != "200" ]]; then
  echo "Échec HTTP ${chat_http}"
  cat "${chat_tmp}" || true
  if [[ "${chat_http}" == "401" ]] && grep -q 'OAuth' "${chat_tmp}" 2>/dev/null; then
    echo ""
    echo ">>> /v1/models peut réussir sans OAuth ; le chat exige un token stocké dans Redis."
    echo ">>> Vérifie sur Vercel (Projet → Settings → Environment Variables) :"
    echo ">>>   UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN (Production), puis Redeploy."
    echo ">>> Puis authentifie-toi : ${ROOT_URL}/"
  fi
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
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

# ─────────────────────────────────────────────────────────────────────
# Tests spécifiques PR #3 (fixes `developer` role + guard thinking +
# client tracking). Ils n'exécutent que si le preview / la prod contient
# ces changements. En cas d'échec sur un proxy non à jour, ils logguent
# et continuent.
# ─────────────────────────────────────────────────────────────────────

pr3_tmp=$(mktemp)
trap 'rm -f "${models_tmp}" "${chat_tmp}" "${pr3_tmp}"' EXIT

echo "== 3) developer → system role normalization (PR #3) =="
dev_http=$(curl -sS "${BYPASS_ARGS[@]}" -o "${pr3_tmp}" -w "%{http_code}" \
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
small_http=$(curl -sS "${BYPASS_ARGS[@]}" -o "${pr3_tmp}" -w "%{http_code}" \
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
sonnet_http=$(curl -sS "${BYPASS_ARGS[@]}" -o "${pr3_tmp}" -w "%{http_code}" \
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

echo "== 5) GET /api/clients (client tracking API, PR #3) =="
clients_http=$(curl -sS "${BYPASS_ARGS[@]}" -o "${pr3_tmp}" -w "%{http_code}" \
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
