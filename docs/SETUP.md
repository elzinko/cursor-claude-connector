# Cursor Setup Guide

This guide assumes you have already deployed the proxy to Vercel and authenticated with Claude.
→ If not, follow the [Deployment Guide](DEPLOYMENT.md) first.

---

## Configure Cursor

### 1. Open Cursor Settings

`Cmd+Shift+J` (Mac) or `Ctrl+Shift+J` (Windows/Linux) → **Models** tab.

### 2. Set the OpenAI Base URL

Enable **"Override OpenAI Base URL"** and enter:

```
https://your-app.vercel.app/v1
```

> Include `/v1` at the end.

### 3. Set the API Key

In the **"OpenAI API Key"** field, enter the `API_KEY` you set in Vercel.

> This is YOUR secret key (not an Anthropic key). It protects your proxy from unauthorized use.

### 4. Add a custom model

> ⚠️ **Important**: Do NOT use well-known model names like `gpt-4o`, `deepseek-v3` or `claude-opus-4-6` — Cursor intercepts these and routes them through its own backend, ignoring your proxy.
>
> Use the custom names below instead. Cursor does not recognize them and forwards them to your proxy, which maps them to the correct Claude model.

In **Settings → Models**, click **"Add Model"** and type one of these names:

| Name to add in Cursor | Claude model used |
|-----------------------|-------------------|
| `claude-proxy-opus-4.6` | claude-opus-4-6 (most powerful) |
| `claude-proxy-sonnet-4.6` | claude-sonnet-4-6 (recommended) |
| `claude-proxy-sonnet-4.5` | claude-sonnet-4-5 |
| `claude-proxy-haiku-4.5` | claude-haiku-4-5 (fastest) |
| `claude-proxy` | claude-sonnet-4-6 (default) |

Select the model you added, and you're ready to go.

### 5. Verify

Send a test message in Cursor chat. You should get a response from Claude.

To confirm the proxy is receiving requests, check your Vercel logs:

```bash
vercel logs https://your-app.vercel.app
```

---

## Limitations

| Feature | Status |
|---------|--------|
| Chat / Ask / Plan modes | ✅ Works |
| Agent mode (multi-file edit) | ❌ Not supported |
| Composer | ❌ Not supported |
| localhost proxy | ❌ Blocked by Cursor |

**Agent and Composer modes** use Cursor's own proprietary fine-tuned models hosted on their infrastructure. They cannot be routed through a custom API key, regardless of settings.

**localhost** does not work because Cursor routes all requests through its own cloud servers, which block connections to private IP addresses (SSRF protection).
