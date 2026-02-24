# FAQ

## General

**Do I need a Cursor Pro subscription?**

No. Cursor Free is enough to use a custom model via a custom Base URL. The proxy uses your Claude Pro/Max subscription — no Cursor credits involved.

**Do I need an Anthropic API key?**

No. The proxy authenticates with your Claude account via OAuth (the same login you use on claude.ai). No API key is needed or used.

---

## Cursor configuration

**Why can't I use `claude-opus-4-6` or `gpt-4o` as model names?**

Cursor intercepts well-known model names and routes them through its own backend, ignoring your custom Base URL.

- Claude model names (`claude-opus-4-6`, etc.) → routed to Cursor's own Anthropic backend
- OpenAI names (`gpt-4o`, `o1`, etc.) → routed to Cursor's own OpenAI backend
- DeepSeek names (`deepseek-v3`, etc.) → routed directly to deepseek.com

Use the custom names provided in the [Cursor Setup Guide](SETUP.md) instead (e.g. `claude-proxy-opus-4.6`). These are unknown to Cursor, so it forwards them to your proxy unchanged.

**I get "Provider Error" and the proxy receives no requests at all.**

Check that the Base URL in Cursor ends with `/v1`:
- ❌ `https://your-app.vercel.app` → Cursor sends to `/chat/completions` → 404
- ✅ `https://your-app.vercel.app/v1` → Cursor sends to `/v1/chat/completions` → OK

In Cursor: Settings → Models → Override OpenAI Base URL → make sure `/v1` is at the end.

**Why doesn't localhost work?**

Cursor routes all requests through its own cloud servers before they reach your endpoint. Those servers block connections to private IP addresses (`localhost`, `192.168.*`, `10.*`, etc.) as an SSRF security measure.

The proxy must be deployed at a **public HTTPS URL** — Vercel is the easiest option.

**I get "Model name is not valid" in Cursor.**

Cursor is validating the model name locally before sending the request. Use one of the `claude-proxy-*` names listed in the [Cursor Setup Guide](SETUP.md) — Cursor does not validate names it doesn't recognize.

**I get "Switched to Composer 1.5 after reaching API limit".**

You used a model name that Cursor recognizes (like `gpt-4o`). Cursor intercepted the request and used its own backend instead of your proxy. Switch to a `claude-proxy-*` model name.

**Agent mode and Composer don't seem to use my proxy.**

Correct — this is a Cursor limitation. Agent mode and multi-file Composer use proprietary fine-tuned models hosted by Cursor. They cannot be redirected to a custom API, regardless of your settings.

Only **Chat / Ask / Plan** modes work through the custom Base URL.

---

## Authentication

**Do I need to re-authenticate regularly?**

With Redis configured, the OAuth token is refreshed automatically. Without Redis (local file storage), the token may expire and require re-authentication.

**How do I re-authenticate?**

Visit `https://your-app.vercel.app/` in your browser and click "Connect with Claude" again. Or call the logout endpoint first: `https://your-app.vercel.app/auth/logout`.

**The proxy returns 401 Unauthorized.**

- Make sure you authenticated at `https://your-app.vercel.app/` after deploying
- Check that the `API_KEY` in Cursor matches the one set in Vercel environment variables
- If using Redis, check that `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set and that you redeployed after adding them

---

## Deployment

**Do I need Redis?**

Yes, on Vercel. Vercel is serverless — each request may run in a different instance, so file storage doesn't persist. Redis (Upstash) is required to keep your OAuth token between requests.

On a traditional server (VPS), file storage works fine and Redis is optional.

**Vercel deployment fails with TypeScript errors.**

Make sure `tsconfig.json` has `"lib": ["ES2022", "DOM"]` and `"types": ["node"]` (without `"bun"`). The `DOM` lib is required for Web API types (`fetch`, `Request`, `Response`).

**How do I update the proxy after making code changes?**

```bash
vercel --prod
```

Or push to `main` if your GitHub repo is connected to Vercel for automatic deployments.

---

## Models

**Which Claude models are available?**

The proxy maps these custom names to Claude models:

| Cursor model name | Claude model |
|-------------------|--------------|
| `claude-proxy-opus-4.6` | claude-opus-4-6 |
| `claude-proxy-sonnet-4.6` | claude-sonnet-4-6 |
| `claude-proxy-sonnet-4.5` | claude-sonnet-4-5 |
| `claude-proxy-haiku-4.5` | claude-haiku-4-5 |

**Can I add my own model aliases?**

Yes. Edit `src/server.ts` and add entries to `MODEL_ALIASES`:

```typescript
const MODEL_ALIASES: Record<string, string> = {
  'my-custom-name': 'claude-sonnet-4-6',
  // ...
}
```

Then rebuild and redeploy.
