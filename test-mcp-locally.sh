#!/usr/bin/env bash
# test-mcp-locally.sh
#
# Local verification script for the MCP server PoC.
# Run this to confirm the server responds correctly before deploying
# to a test GitHub repository.
#
# Usage: bash test-mcp-locally.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== MCP SSRF PoC — Local Test ==="
echo ""

# Verify Node.js is available
if ! command -v node &>/dev/null; then
  echo "[ERROR] node not found. Install Node.js >= 18."
  exit 1
fi

echo "[INFO] Node.js: $(node --version)"
echo ""

# ── Test 1: Initialize handshake ─────────────────────────────────────────────
echo "--- Test 1: MCP Initialize Handshake ---"
INIT_REQUEST='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test-client","version":"1.0"},"capabilities":{}}}'

INIT_RESPONSE=$(echo "$INIT_REQUEST" | timeout 5 node mcp-server.js 2>/dev/null | head -1)

if echo "$INIT_RESPONSE" | grep -q '"protocolVersion"'; then
  echo "[PASS] Initialize handshake succeeded"
  echo "       Response: $(echo "$INIT_RESPONSE" | python3 -m json.tool 2>/dev/null | head -5 || echo "$INIT_RESPONSE" | head -c 200)"
else
  echo "[FAIL] Initialize handshake failed"
  echo "       Response: $INIT_RESPONSE"
fi

echo ""

# ── Test 2: tools/list ───────────────────────────────────────────────────────
echo "--- Test 2: tools/list ---"
LIST_INPUT=$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1"},"capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}')

LIST_RESPONSE=$(echo "$LIST_INPUT" | timeout 5 node mcp-server.js 2>/dev/null | tail -1)

TOOL_COUNT=$(echo "$LIST_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['result']['tools']))" 2>/dev/null || echo "0")

if [ "$TOOL_COUNT" -gt 0 ]; then
  echo "[PASS] tools/list returned $TOOL_COUNT tools"
  echo "$LIST_RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in d['result']['tools']:
    print(f\"       - {t['name']}: {t['description'][:60]}...\")
" 2>/dev/null || true
else
  echo "[FAIL] tools/list returned no tools"
fi

echo ""

# ── Test 3: read_env tool ────────────────────────────────────────────────────
echo "--- Test 3: read_env tool call ---"
ENV_INPUT=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1"},"capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_env","arguments":{}}}')

ENV_RESPONSE=$(echo "$ENV_INPUT" | timeout 5 node mcp-server.js 2>/dev/null | tail -1)

if echo "$ENV_RESPONSE" | grep -q '"summary"'; then
  echo "[PASS] read_env tool responded"
  # Extract summary
  echo "$ENV_RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
content = d['result']['content'][0]['text']
data = json.loads(content)
print(f\"       Summary: {data.get('summary', 'N/A')}\")
print(f\"       Total env vars: {data.get('total_env_vars', 'N/A')}\")
" 2>/dev/null || echo "       (could not parse response)"
else
  echo "[FAIL] read_env tool call failed"
  echo "       Response: $(echo "$ENV_RESPONSE" | head -c 300)"
fi

echo ""

# ── Test 4: probe_imds tool (local — will fail to reach real IMDS) ──────────
echo "--- Test 4: probe_imds tool (local probe — IMDS expected to timeout) ---"
IMDS_INPUT=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"test","version":"1"},"capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"probe_imds","arguments":{"target":"aws"}}}')

IMDS_RESPONSE=$(echo "$IMDS_INPUT" | timeout 15 node mcp-server.js 2>/dev/null | tail -1)

if echo "$IMDS_RESPONSE" | grep -q '"summary"'; then
  echo "[PASS] probe_imds tool responded (IMDS not reachable locally — as expected)"
  echo "$IMDS_RESPONSE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
content = d['result']['content'][0]['text']
data = json.loads(content)
print(f\"       Summary: {data.get('summary', 'N/A')}\")
" 2>/dev/null || echo "       (could not parse response)"
else
  echo "[FAIL] probe_imds tool call failed"
fi

echo ""
echo "=== Local tests complete ==="
echo ""
echo "Next steps:"
echo "  1. Create a test GitHub repository"
echo "  2. Copy all files from this directory into the repo root"
echo "  3. Ensure Copilot Coding Agent is enabled (org/repo settings)"
echo "  4. Create an issue and assign it to @copilot"
echo "  5. Monitor the session at: github.com/OWNER/REPO/copilot/sessions"
echo "  6. Look for IMDS probe results in the PR description and session logs"
