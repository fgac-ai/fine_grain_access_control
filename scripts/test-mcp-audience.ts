/**
 * Unit tests for MCP token audience binding (src/lib/mcpAudience.ts).
 * Run: npx tsx scripts/test-mcp-audience.ts  (part of `npm run mcp:lint`)
 *
 * Background (2026-09-16): a bearer minted with `resource=<preview A>/api/mcp`
 * was accepted by `<preview B>` because Clerk's access tokens carry no `aud`
 * and verifyMcpAuth checked issuer only. The check is: absent aud → accepted
 * (Clerk does not bind today; counted), present aud → must name THIS server.
 */
import {
  canonicalResource, expectedMcpAudiences, audienceClaim, checkTokenAudience, decodeJwtPayload,
} from '../src/lib/mcpAudience';

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); }
  else console.log(`  ✓ ${name}`);
}

const HOST = 'https://fine-grain-access-control-fujvhnx8r-example.vercel.app';
const OTHER = 'https://fine-grain-access-control-rh94fxfqs-example.vercel.app';

console.log('canonicalResource:');
check('lowercases scheme+host, keeps path case', canonicalResource('HTTPS://FGAC.AI/api/mcp/MyProfile') === 'https://fgac.ai/api/mcp/MyProfile');
check('strips trailing slash', canonicalResource('https://fgac.ai/api/mcp/') === 'https://fgac.ai/api/mcp');
check('strips fragment and query', canonicalResource('https://fgac.ai/api/mcp?x=1#f') === 'https://fgac.ai/api/mcp');
check('keeps explicit port', canonicalResource('http://localhost:52145/api/mcp') === 'http://localhost:52145/api/mcp');
check('rejects non-URL', canonicalResource('fgac.ai/api/mcp') === null);
check('rejects non-http scheme', canonicalResource('urn:fgac:mcp') === null);

console.log('expectedMcpAudiences:');
check('base request → base audience only',
  JSON.stringify(expectedMcpAudiences(`${HOST}/api/mcp`)) === JSON.stringify([`${HOST}/api/mcp`]));
check('profile request → base + slug audiences',
  JSON.stringify(expectedMcpAudiences(`${HOST}/api/mcp/team-a`, 'team-a')) === JSON.stringify([`${HOST}/api/mcp`, `${HOST}/api/mcp/team-a`]));
check('derived from the request ORIGIN, not its path (middleware rewrites the path)',
  JSON.stringify(expectedMcpAudiences(`${HOST}/api/mcp`, 'team-a')) === JSON.stringify([`${HOST}/api/mcp`, `${HOST}/api/mcp/team-a`]));

console.log('audienceClaim:');
check('absent → undefined', audienceClaim({ iss: 'x' }) === undefined);
check('string → [string]', JSON.stringify(audienceClaim({ aud: 'a' })) === '["a"]');
check('array → strings only', JSON.stringify(audienceClaim({ aud: ['a', 1, '', 'b'] })) === '["a","b"]');
check('empty string → undefined', audienceClaim({ aud: '' }) === undefined);
check('null payload → undefined', audienceClaim(null) === undefined);

console.log('checkTokenAudience:');
const expected = expectedMcpAudiences(`${HOST}/api/mcp`);
check('Clerk today: no aud → present:false (accepted, counted)',
  JSON.stringify(checkTokenAudience(undefined, expected)) === '{"present":false}');
check('aud names this server → ok', checkTokenAudience([`${HOST}/api/mcp`], expected).present && (checkTokenAudience([`${HOST}/api/mcp`], expected) as { ok: boolean }).ok === true);
check('aud names this server with trailing slash → ok', (checkTokenAudience([`${HOST}/api/mcp/`], expected) as { ok: boolean }).ok === true);
check('aud with uppercase host → ok (spec: accept for robustness)', (checkTokenAudience([`${HOST.toUpperCase()}/api/mcp`], expected) as { ok: boolean }).ok === true);
check('THE 2026-09-16 CASE: aud names another preview host → rejected',
  (checkTokenAudience([`${OTHER}/api/mcp`], expected) as { ok: boolean }).ok === false);
check('aud names the origin without /api/mcp → rejected (canonical URI is the MCP endpoint)',
  (checkTokenAudience([HOST], expected) as { ok: boolean }).ok === false);
check('aud names a different path on this host → rejected',
  (checkTokenAudience([`${HOST}/api/proxy`], expected) as { ok: boolean }).ok === false);
check('multi-valued aud containing this server → ok',
  (checkTokenAudience([`${OTHER}/api/mcp`, `${HOST}/api/mcp`], expected) as { ok: boolean }).ok === true);
check('garbage aud → rejected, not crash', (checkTokenAudience(['not a url'], expected) as { ok: boolean }).ok === false);
const slugExpected = expectedMcpAudiences(`${HOST}/api/mcp/team-a`, 'team-a');
check('token for base resource accepted at a profile URL (slug is addressing, same server)',
  (checkTokenAudience([`${HOST}/api/mcp`], slugExpected) as { ok: boolean }).ok === true);
check('token for profile A accepted at profile A',
  (checkTokenAudience([`${HOST}/api/mcp/team-a`], slugExpected) as { ok: boolean }).ok === true);
check('token for profile B rejected at profile A',
  (checkTokenAudience([`${HOST}/api/mcp/team-b`], slugExpected) as { ok: boolean }).ok === false);
check('token for a profile rejected at the base URL',
  (checkTokenAudience([`${HOST}/api/mcp/team-a`], expected) as { ok: boolean }).ok === false);

console.log('decodeJwtPayload:');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = `${b64({ alg: 'RS256' })}.${b64({ iss: 'i', aud: [`${HOST}/api/mcp`] })}.sig`;
check('reads aud from a JWT payload', JSON.stringify(audienceClaim(decodeJwtPayload(jwt))) === JSON.stringify([`${HOST}/api/mcp`]));
check('opaque token → null', decodeJwtPayload('oat_notajwt') === null);
check('malformed payload → null', decodeJwtPayload('a.%%%.c') === null);

if (failures > 0) { console.error(`\n✗ mcp-audience: ${failures} failure(s)`); process.exit(1); }
console.log('\n✓ mcp-audience: all checks passed');
