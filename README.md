# Cursor Claude Connector

A proxy that lets you use your **Claude Pro/Max subscription** in Cursor IDE — no additional API costs.

```
Cursor IDE → Proxy (Vercel) → Anthropic API (your Claude subscription)
```

Cursor sends OpenAI-compatible requests to the proxy. The proxy authenticates with your Claude account via OAuth and forwards requests to Anthropic's API.

> ⚠️ **Cursor blocks connections to private/local IPs.** The proxy **must** be deployed on a public server (Vercel recommended). Running it on `localhost` will not work with Cursor.

---

## Quick start

### 1. Deploy to Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/elzinko/cursor-claude-connector&env=API_KEY&envDescription=Secret%20key%20to%20protect%20your%20proxy&integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17)

- Set `API_KEY` to any secret string you choose (e.g. `my-secret-key-123`)
- Add **Upstash Redis** from Vercel Marketplace (required for token storage)

→ See **[Deployment Guide](docs/DEPLOYMENT.md)** for step-by-step instructions.

### 2. Authenticate with Claude

Open your Vercel URL in a browser and click **"Connect with Claude"**. Sign in with your Claude Pro/Max account.

### 3. Configure Cursor

→ See **[Cursor Setup Guide](docs/SETUP.md)** for exact steps and model names.

---

## Modes

| Mode | When to use | Token storage |
|------|-------------|---------------|
| **Vercel** ✅ | Recommended — works with Cursor | Redis (Upstash) |
| **Local / VPS** | Only if you have a public HTTPS URL | File or Redis |

> Local mode (`localhost`) **cannot** work with Cursor. Cursor routes all requests through its own cloud servers, which block private IP addresses.

---

## Prompt caching

The proxy automatically places Anthropic `cache_control: {type: "ephemeral"}` breakpoints on the stable parts of each request:

- one marker on the **last block of `system`** (caches tools + system together)
- one marker on the **last tool** (partial hit if only system text changes)

Repeat calls with the same tools + system then hit the prompt cache at ~10% of the input price. For large clients like openclaw (22 KB system + 23 KB tools) this covers the majority of input tokens — the savings compound every turn.

**Verifying cache activity** — the proxy propagates Anthropic's counters both in response headers and in the OpenAI-compat response body:

```bash
curl -sS -D - -H "Authorization: Bearer $API_KEY" \
     -d @payload.json "$PROXY_URL/v1/chat/completions" | head -20

# Response headers of interest:
#   x-cache-control-injected: 2          ← bp count the proxy placed
#   x-cache-control-system:   1          ← marked the last system block
#   x-cache-control-tools:    1          ← marked the last tool
#   x-anthropic-cache-creation: 5120     ← tokens written this call (~1.25× rate)
#   x-anthropic-cache-read:     0        ← first call, nothing to read

# Response body carries the same numbers for OpenAI-compat clients:
#   "usage": {
#     "prompt_tokens": 5170,
#     "completion_tokens": 10,
#     "total_tokens": 5180,
#     "prompt_tokens_details": {
#       "cached_tokens": 0,
#       "cache_creation_tokens": 5120
#     }
#   }
```

Replaying the same curl 200 ms later should flip `cache_creation` to 0 and `cache_read`/`cached_tokens` to the same 5120. If `cached_tokens` stays at 0 across two identical requests, a silent invalidator is at work (timestamp in the system prompt, non-deterministic JSON key order, varying tool set). See [`shared/prompt-caching.md`](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) for the audit checklist.

**Respecting the client** — if the client already placed its own `cache_control` anywhere in `system`, `tools`, or message blocks, the proxy leaves the corresponding section alone (`x-cache-control-skip-reason: client_owns_system` or `client_owns_tools`). Max 4 breakpoints per request; the proxy never pushes the total over 4.

**Escape hatches** (env vars, no code change):

| Variable | Effect |
|---|---|
| `DISABLE_CACHE_CONTROL=1` | Skip injection entirely — use to rule out caching during an unrelated bug hunt |
| `CACHE_TTL_1H=1` | Use the 1-hour TTL instead of the 5-minute default. Write cost goes from 1.25× to 2× of base — break-even needs ≥3 reads per write. Worth enabling only for long openclaw-style sessions where the 5-min default keeps expiring between turns. |

**Streaming** — cache metrics arrive in the final `usage` chunk of the stream (same OpenAI-compat `prompt_tokens_details` shape). The response-header mirror is not populated for streaming responses because headers are flushed before usage numbers arrive from Anthropic.

---

## Docs

- [Deployment Guide](docs/DEPLOYMENT.md) — Vercel setup, Redis, environment variables
- [Cursor Setup Guide](docs/SETUP.md) — Model names, Cursor configuration
- [User Guide](docs/USER_GUIDE.md) — How to call the proxy (for users and LLMs)
- [FAQ](docs/FAQ.md) — Common questions and issues

---

## Security

- OAuth 2.0 with PKCE — no password stored
- `API_KEY` required on public deployments
- Tokens stored in Redis (Vercel) or local file (local mode)

### Clients dashboard (`/api/clients`)

The dashboard surfaces one row per `sha256(api_key + ip)` so you can spot
unauthorized use of your key. To make this easier, the **Host / ASN** column
resolves each IP to its provider — e.g. `AWS eu-west-3`, `Azure`,
`SFR (FR, residential)` — so you can tell a home ISP apart from a cloud runner
at a glance.

Set `IPINFO_TOKEN` (free tier at [ipinfo.io](https://ipinfo.io), 50k
lookups/month) in your Vercel env to enable. Lookups are cached in Upstash for
30 days, so a busy proxy still does ~1 API call per unique client IP per
month. Without the token the feature degrades gracefully (column stays empty).

## License

MIT — Not affiliated with Anthropic or Cursor.
