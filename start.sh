#!/bin/bash

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

echo ""
echo "🌐 Server starting on http://localhost:${PORT:-9095}"
echo "📚 API Documentation: http://localhost:${PORT:-9095}/"
echo "🔐 OAuth Login: http://localhost:${PORT:-9095}/"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Start the server with .env loaded
$RUN_CMD start 