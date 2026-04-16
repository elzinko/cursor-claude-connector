#!/usr/bin/env bash
#
# Idempotent Vercel env-var provisioning.
#
# Reads KEY=VALUE pairs from a local source file (scripts/.env.vercel by
# default — gitignored) and converges the Vercel env matching ENV_MAP below.
#
# Strategy:
#   1. For each declared var, pull the current value from each target
#      environment (via `vercel env pull`).
#   2. If every target already holds the desired value → skip (no churn).
#      This preserves an "All Environments" single-record layout that users
#      may have set up manually via the UI.
#   3. Otherwise nuke all records for that var (sweeping all three targets)
#      and re-add one record per target. The re-adds create per-target
#      records; unify manually via the UI if you want the "All environments"
#      look, the next run will preserve it.
#
# Usage:
#   scripts/provision-vercel-env.sh                        # default source
#   scripts/provision-vercel-env.sh path/to/source.env     # custom source
#   DRY_RUN=1 scripts/provision-vercel-env.sh              # plan-only
#   FORCE=1   scripts/provision-vercel-env.sh              # rewrite even if unchanged
#
# Prerequisites:
#   - `vercel` CLI installed and `vercel login` completed
#   - `.vercel/project.json` present (run `vercel link` once)
#
# To add a new secret: append a line to ENV_MAP ("NAME:env1,env2,...") and
# add NAME=... to scripts/.env.vercel. Running the script again will apply it.

set -euo pipefail

ENV_MAP=(
  "API_KEY:production,preview,development"
  "VERCEL_BYPASS_TOKEN:preview,development"
  "UPSTASH_REDIS_REST_URL:production,preview,development"
  "UPSTASH_REDIS_REST_TOKEN:production,preview,development"
)

SOURCE="${1:-scripts/.env.vercel}"
DRY_RUN="${DRY_RUN:-0}"
FORCE="${FORCE:-0}"

if [ ! -f "$SOURCE" ]; then
  echo "ERROR: source file not found: $SOURCE" >&2
  echo "Copy scripts/.env.vercel.example to $SOURCE and fill in values." >&2
  exit 1
fi

if [ ! -f ".vercel/project.json" ]; then
  echo "ERROR: project not linked. Run \`vercel link\` first." >&2
  exit 1
fi

# Pull KEY's value from SOURCE, stripping optional surrounding quotes.
get_val() {
  local key="$1"
  awk -F= -v k="$key" '
    $1 == k {
      sub(/^[^=]*=/, "")
      gsub(/^"|"$/, "")
      gsub(/^'"'"'|'"'"'$/, "")
      print
      exit
    }
  ' "$SOURCE"
}

# Pull a single env target into a temp file and extract one var's value.
# Returns empty string if the var isn't present in that env.
get_remote_val() {
  local name="$1" target="$2" tmp
  tmp="$(mktemp)"
  if vercel env pull "$tmp" --environment="$target" --yes >/dev/null 2>&1; then
    get_val_from_file "$name" "$tmp"
  fi
  rm -f "$tmp"
}

get_val_from_file() {
  local key="$1" file="$2"
  awk -F= -v k="$key" '
    $1 == k {
      sub(/^[^=]*=/, "")
      gsub(/^"|"$/, "")
      gsub(/^'"'"'|'"'"'$/, "")
      print
      exit
    }
  ' "$file"
}

# Cache `vercel env pull` output per target — 1 HTTP call per target, shared
# across all vars in ENV_MAP. Implemented as three fixed slots (bash 3.2 on
# macOS has no associative arrays).
REMOTE_PROD=""
REMOTE_PREVIEW=""
REMOTE_DEV=""

remote_file_for() {
  case "$1" in
    production)  printf '%s' "$REMOTE_PROD" ;;
    preview)     printf '%s' "$REMOTE_PREVIEW" ;;
    development) printf '%s' "$REMOTE_DEV" ;;
  esac
}

set_remote_file_for() {
  case "$1" in
    production)  REMOTE_PROD="$2" ;;
    preview)     REMOTE_PREVIEW="$2" ;;
    development) REMOTE_DEV="$2" ;;
  esac
}

ensure_remote_pulled() {
  local target="$1"
  local current
  current="$(remote_file_for "$target")"
  if [ -z "$current" ]; then
    local tmp
    tmp="$(mktemp)"
    if vercel env pull "$tmp" --environment="$target" --yes >/dev/null 2>&1; then
      set_remote_file_for "$target" "$tmp"
    else
      # Pull failed (network, auth, etc.). Record an empty file so we don't
      # retry; values will come back empty and trigger a rewrite.
      : >"$tmp"
      set_remote_file_for "$target" "$tmp"
    fi
  fi
}

invalidate_remote_for() {
  local target="$1"
  local f
  f="$(remote_file_for "$target")"
  if [ -n "$f" ]; then
    rm -f "$f"
    set_remote_file_for "$target" ""
  fi
}

cleanup() {
  [ -n "$REMOTE_PROD" ] && rm -f "$REMOTE_PROD"
  [ -n "$REMOTE_PREVIEW" ] && rm -f "$REMOTE_PREVIEW"
  [ -n "$REMOTE_DEV" ] && rm -f "$REMOTE_DEV"
}
trap cleanup EXIT

for entry in "${ENV_MAP[@]}"; do
  name="${entry%%:*}"
  envs="${entry#*:}"
  val="$(get_val "$name")"

  if [ -z "$val" ]; then
    printf '  skip %-30s (not set in %s)\n' "$name" "$SOURCE"
    continue
  fi

  IFS=',' read -ra targets <<< "$envs"

  if [ "$DRY_RUN" = "1" ]; then
    for target in "${targets[@]}"; do
      printf '   dry %-30s → %s\n' "$name" "$target"
    done
    continue
  fi

  # Idempotency check: if every target already has the desired value, skip.
  # This preserves any "All environments" unified record the user set up via
  # the UI — we don't nuke and recreate per-target records needlessly.
  unchanged=1
  if [ "$FORCE" != "1" ]; then
    for target in "${targets[@]}"; do
      ensure_remote_pulled "$target"
      remote_file="$(remote_file_for "$target")"
      remote_val="$(get_val_from_file "$name" "$remote_file")"
      if [ "$remote_val" != "$val" ]; then
        unchanged=0
        break
      fi
    done
  else
    unchanged=0
  fi

  if [ "$unchanged" = "1" ]; then
    printf '  keep %-30s (all targets already match)\n' "$name"
    continue
  fi

  # Wipe any prior records for this var. `vercel env rm NAME target --yes`
  # removes whichever record(s) match; errors (not-found) are fine.
  # We sweep all three envs because a previously-single-record var with a
  # multi-target scope is killed by the first rm, and per-target records get
  # nuked one at a time. Either way, we end up clean.
  for target in production preview development; do
    vercel env rm "$name" "$target" --yes >/dev/null 2>&1 || true
  done

  # Re-add per target. `preview` needs "" as git-branch in non-interactive
  # mode to mean "all preview branches"; production/development take no branch.
  # Note: this creates one record per target. To get the "All Environments"
  # unified look, edit the var once in the Vercel UI after the first run —
  # subsequent runs will keep it (via the unchanged-check above) as long as
  # the value stays the same.
  for target in "${targets[@]}"; do
    if [ "$target" = "preview" ]; then
      vercel env add "$name" "$target" "" --value "$val" --yes >/dev/null
    else
      vercel env add "$name" "$target" --value "$val" --yes >/dev/null
    fi
    printf '    ok %-30s → %s\n' "$name" "$target"
  done

  # Invalidate the cached pulls for next vars of this run (stale after write).
  for target in "${targets[@]}"; do
    invalidate_remote_for "$target"
  done
done

echo
echo "Done. Current state:"
vercel env ls
