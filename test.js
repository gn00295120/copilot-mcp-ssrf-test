import { test } from 'node:test';
import assert from 'node:assert/strict';

test('package name is correct', async () => {
  const pkg = JSON.parse(
    await import('node:fs').then((fs) =>
      fs.promises.readFile(new URL('./package.json', import.meta.url), 'utf8')
    )
  );
  assert.equal(pkg.name, 'copilot-ssrf-probe-mcp');
});

test('mcp-server.js exists', async () => {
  const { access } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.join(dir, 'mcp-server.js');
  await assert.doesNotReject(access(serverPath), 'mcp-server.js should exist');
});
