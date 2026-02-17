#!/bin/bash

# Mode: local (file storage) | vercel (Redis). Default: auto-detect from env
MODE="${1:-}"

echo "🚀 Starting Anthropic to OpenAI Proxy Server..."
echo ""

# Use bun if available, otherwise npm
if command -v bun &> /dev/null; then
    RUNNER="bun"
    INSTALL_CMD="bun install"
    RUN_CMD="bun run"
else
    RUNNER="npm"
    INSTALL_CMD="npm install"
    RUN_CMD="npm run"
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    $INSTALL_CMD
    echo ""
fi

echo "🔨 Building project..."
$RUN_CMD build

# Set storage mode based on argument
if [ "$MODE" = "local" ]; then
    export STORAGE_MODE=file
    echo "📁 Mode: local (file storage)"
elif [ "$MODE" = "vercel" ]; then
    export STORAGE_MODE=redis
    HAS_REDIS=$(grep -E "^(UPSTASH_REDIS_REST_URL|KV_REST_API_URL)=" .env 2>/dev/null | grep -v "^#" | head -1)
    if [ -z "$HAS_REDIS" ]; then
        echo "❌ Error: Redis required for vercel mode."
        echo "   Add Redis via Vercel Marketplace (Storage → Connect Store → Upstash)"
        echo "   Or set UPSTASH_REDIS_REST_URL in .env"
        exit 1
    fi
    echo "🔗 Mode: vercel (Redis)"
else
    echo "🔀 Mode: auto (file if no Redis, else Redis)"
fi

echo ""
echo "🌐 Server starting on http://localhost:${PORT:-9095}"
echo "📚 API Documentation: http://localhost:${PORT:-9095}/"
echo "🔐 OAuth Login: http://localhost:${PORT:-9095}/"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Start the server with .env loaded
$RUN_CMD start 