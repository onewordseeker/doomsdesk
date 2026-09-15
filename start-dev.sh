#!/bin/bash
# DoomsDesk — Start all services in dev mode

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "🔮 Starting DoomsDesk dev environment..."

# Start server
echo "  → Server (API :4000, WS :4001)"
cd "$ROOT/packages/server"
pnpm dev &
SERVER_PID=$!

sleep 2

# Start web console
echo "  → Web console :3001"
cd "$ROOT/packages/web"
pnpm dev &
WEB_PID=$!

sleep 2

# Start Electron desktop app
echo "  → Desktop app (Electron)"
cd "$ROOT/packages/desktop"
pnpm dev &
DESKTOP_PID=$!

echo ""
echo "Services running:"
echo "  API:     http://localhost:4000"
echo "  WS:      ws://localhost:4001"
echo "  Console: http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop all."

trap "kill $SERVER_PID $WEB_PID $DESKTOP_PID 2>/dev/null" EXIT
wait
