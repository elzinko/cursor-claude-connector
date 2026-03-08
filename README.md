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

## License

MIT — Not affiliated with Anthropic or Cursor.
