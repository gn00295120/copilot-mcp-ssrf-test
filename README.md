# Copilot MCP SSRF Test

## Health check

A small health check endpoint is available to report the runtime configuration and MCP probe results.

- Start the HTTP endpoint (default `http://localhost:3000/health`): `npm run healthcheck`
- Run a one-off JSON report to stdout: `npm run healthcheck:once`
