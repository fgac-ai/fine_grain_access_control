/**
 * Invariants for server.json — the MCP Registry listing manifest at the repo
 * root (docs/growth-channels.md). Run: npx tsx scripts/test-server-json.ts
 * (part of `npm run mcp:lint`).
 *
 * Why these matter:
 *  - name must sit in the ai.fgac/* namespace — that is what the HTTP domain
 *    proof at /.well-known/mcp-registry-auth authorizes; any other prefix is
 *    refused at publish time with "you do not have permission".
 *  - description ≤ 100 chars is a hard schema limit (2025-12-11 schema).
 *  - version must track package.json so a republish never silently reuses a
 *    version the registry already holds (the registry rejects duplicates).
 *  - the remote URL is the one users enter everywhere else (listing copy,
 *    RFC 9728 `resource`), so a typo here would list a dead endpoint.
 *  - the well-known auth record must be exactly what the registry expects.
 */
import { readFileSync } from 'node:fs';
import { MCP_REGISTRY_AUTH_RECORD } from '../src/app/.well-known/mcp-registry-auth/route';

const server = JSON.parse(readFileSync('server.json', 'utf8'));
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

console.log('server.json:');
check('$schema is the 2025-12-11 registry schema',
  server.$schema === 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json');
check('name matches registry pattern', /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/.test(server.name));
check('name is in the ai.fgac/ namespace (HTTP domain auth for fgac.ai)', server.name.startsWith('ai.fgac/'));
check('title is 1–100 chars', typeof server.title === 'string' && server.title.length >= 1 && server.title.length <= 100);
check(`description is 1–100 chars (${server.description?.length})`,
  typeof server.description === 'string' && server.description.length >= 1 && server.description.length <= 100);
check(`version matches package.json (${pkg.version})`, server.version === pkg.version);
check('version is exact, not a range', /^\d+\.\d+\.\d+/.test(server.version));
check('repository points at the public repo with source github',
  server.repository?.url === 'https://github.com/fgac-ai/fine_grain_access_control' && server.repository?.source === 'github');
check('exactly one remote, streamable-http at https://fgac.ai/api/mcp',
  Array.isArray(server.remotes) && server.remotes.length === 1
  && server.remotes[0].type === 'streamable-http' && server.remotes[0].url === 'https://fgac.ai/api/mcp');
check('no packages entry (remote-only listing)', server.packages === undefined);
check('icon is served from fgac.ai', server.icons?.[0]?.src?.startsWith('https://fgac.ai/'));

console.log('/.well-known/mcp-registry-auth record:');
const m = MCP_REGISTRY_AUTH_RECORD.match(/^v=MCPv1; k=ed25519; p=([A-Za-z0-9+/]+=*)$/);
check('record has the v=MCPv1; k=ed25519; p=<base64> shape', m !== null);
check('public key decodes to 32 bytes (raw Ed25519)', m !== null && Buffer.from(m[1], 'base64').length === 32);

if (failures) { console.error(`\n${failures} server.json check(s) failed`); process.exit(1); }
console.log('\nAll server.json checks passed');
