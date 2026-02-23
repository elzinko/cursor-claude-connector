# Deployment Guide

## Prerequisites

- A Claude **Pro or Max** subscription
- A [Vercel](https://vercel.com) account (free)
- A [GitHub](https://github.com) account

---

## Step 1 — Fork or clone the repository

Fork [elzinko/cursor-claude-connector](https://github.com/elzinko/cursor-claude-connector) to your GitHub account, or clone it and push to your own repo.

---

## Step 2 — Deploy to Vercel

### Option A — One-click deploy (recommended)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/elzinko/cursor-claude-connector&env=API_KEY&envDescription=Secret%20key%20to%20protect%20your%20proxy&integration-ids=oac_V3R1GIpkoJorr6fqyiwdhl17)

- Set `API_KEY` to any secret string you choose (min. 8 characters)
- Vercel will clone the repo and deploy it

### Option B — Manual import

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repository
3. Add environment variable `API_KEY` before deploying
4. Click **Deploy**

---

## Step 3 — Add Redis (required)

The proxy stores OAuth tokens in Redis. Without it, you'll need to re-authenticate on every request.

1. In your Vercel project → **Storage** tab → **Connect Store**
2. Browse Marketplace → select **Upstash Redis**
3. Create a new database (free tier: 256 MB, 500K commands/month)
4. Vercel automatically injects `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`
5. **Redeploy** your project to apply the new variables

> **Note:** Vercel KV was discontinued in December 2024. Use Upstash Redis — same REST API, free tier available.

---

## Step 4 — Authenticate with Claude

1. Open your Vercel URL in a browser: `https://your-app.vercel.app/`
2. Click **"Connect with Claude"**
3. Sign in with your Claude Pro/Max account and authorize the app
4. Copy the code shown and paste it into the web interface
5. You should see: *"You are successfully authenticated with Claude"*

---

## Step 5 — Configure Cursor

→ Follow the [Cursor Setup Guide](SETUP.md)

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `API_KEY` | ✅ Yes | Secret key to protect your proxy. Set it in Vercel and use it in Cursor. |
| `UPSTASH_REDIS_REST_URL` | ✅ Yes | Auto-injected by Upstash integration |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ Yes | Auto-injected by Upstash integration |
| `CORS_ORIGINS` | No | Comma-separated allowed origins. Defaults to all origins if unset. |
| `RATE_LIMIT_REQUESTS` | No | Max requests per window per API key (default: 100) |
| `RATE_LIMIT_WINDOW_MS` | No | Rate limit window in ms (default: 3600000 = 1h) |

### Generate a strong API_KEY

```bash
openssl rand -hex 32
```

---

## Updating the proxy

If you connected your GitHub repo to Vercel, push to `main` will trigger automatic deployments.

Otherwise, deploy manually from the project directory:

```bash
vercel --prod
```

---

## Local / VPS mode

> ⚠️ **localhost does not work with Cursor.** Cursor routes requests through its own cloud servers, which block private IP addresses.

Local mode is only useful if you run the proxy on a machine with a **public HTTPS URL** (e.g. a VPS with a domain and TLS certificate).

```bash
cp env.example .env
# Edit .env: set API_KEY, and optionally UPSTASH_* for Redis
npm install
npm run start:local   # file-based token storage
# or
npm run start:vercel  # Redis-based token storage
```

Then open `http://your-server:9095/` to authenticate.
