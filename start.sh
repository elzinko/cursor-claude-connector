#!/bin/bash

echo "🚀 Starting Anthropic to OpenAI Proxy Server..."
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    bun install
    echo ""
fi

echo "🔨 Building project..."
bun run build


echo "🌐 Server starting on http://your-domain.com"
echo "📚 API Documentation: http://your-domain.com/"
echo "🔐 OAuth Login: http://your-domain.com/auth/login"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Start the server with bun and load .env file
bun run start 