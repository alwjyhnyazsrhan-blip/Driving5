#!/usr/bin/env bash
set -e
echo "========================================================"
echo "  Locat Monitor - Local Standalone Desktop Runner"
echo "========================================================"
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js is not installed. Download LTS from https://nodejs.org"
  exit 1
fi
if [ ! -d "node_modules" ]; then
  echo "[*] Installing dependencies (first run only)..."
  npm install
fi
(
  sleep 4
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:3000"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:3000"
  fi
) &
npm run dev
