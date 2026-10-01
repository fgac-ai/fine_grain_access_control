/**
 * Pinned tests for the MCP caller classifier
 * (src/lib/mcpClientSignals.ts: classifyMcpClient).
 * Run: npx tsx scripts/test-mcp-client-class.ts  (part of `npm run mcp:lint`)
 *
 * Every string below is a user-agent / clientInfo.name pair observed on
 * production `mcp_auth_attempt` rows (docs/monitoring.md 7.21) — the 09-10
 * crawler wave and the `direct` remainder the 2026-09-12 review found still
 * growing. The invariants, in order of how expensive it is to get them wrong:
 *
 *   1. Nothing that has ever authenticated is `scanner`. Since the classifier
 *      deployed, every authenticated request has carried a `Claude-User` or
 *      `claude-code/` UA (14-day check, 2026-09-12), so the risk is
 *      hypothetical — but the vocabulary must stay off words a real product
 *      would use (`client`, `agent`, `gateway`, `engine`, `check`).
 *   2. The stock runtimes the real SDKs use (`python-httpx/`, `node`,
 *      `undici`, `Bun/`) are never `scanner` on the UA alone. A tokenless one
 *      with no clientInfo is `direct` + `ua:stock-runtime-no-name`: unnamed
 *      automation, distinguishable in 7.21b from an unknown client that
 *      named itself, without being over-claimed as a crawler.
 *   3. `client_class` is a measurement label: nothing here is consulted by
 *      auth or rate limiting (structural check on the route at the bottom).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { classifyMcpClient } from '../src/lib/mcpClientSignals';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}
const cls = (userAgent?: string, clientName?: string) => classifyMcpClient({ userAgent, clientName });
const is = (userAgent: string | undefined, clientName: string | undefined, klass: string, signal?: string) => {
  const r = cls(userAgent, clientName);
  return r.client_class === klass && (signal === undefined ? true : r.client_class_signal === signal);
};

console.log('claude products (the acquisition funnel):');
check('Claude-User + Anthropic/ClaudeAI → claude', is('Claude-User', 'Anthropic/ClaudeAI', 'claude', 'ua:Claude-User'));
check('Claude-User, no name (tool call) → claude', is('Claude-User', undefined, 'claude'));
check('claude-code/2.1.266 (claude-desktop, agent-sdk/0.3.266) → claude', is('claude-code/2.1.266 (claude-desktop, agent-sdk/0.3.266)', 'claude-code', 'claude'));
check('sheet-add-in by name on a non-Claude UA → claude', is('node', 'sheet-add-in', 'claude', 'name:sheet-add-in'));
check('UA rule decides before the name rule (Claude-User + sheet-add-in → ua:Claude-User)', is('Claude-User', 'sheet-add-in', 'claude', 'ua:Claude-User'));
check('claude names win over crawler vocabulary in the UA', is('Claude-User (+https://www.anthropic.com/claude-user)', undefined, 'claude'));

console.log('internal (our own probes):');
check('fgac-auth-probe UA → internal', is('fgac-auth-probe/1.0', undefined, 'internal', 'ua:fgac-'));
check('name auth-probe on a stock runtime → internal, not scanner', is('node', 'auth-probe', 'internal', 'name:auth-probe'));

console.log('scanners, 09-10 population:');
check('SmitheryBot/1.0 (+https://smithery.ai) → scanner', is('SmitheryBot/1.0 (+https://smithery.ai)', undefined, 'scanner'));
check('glama on a bare node UA → scanner by name', is('node', 'glama', 'scanner', 'name:glama'));
check('verifymcp-probe on Go-http-client → scanner by keyword', is('Go-http-client/2.0', 'verifymcp-probe', 'scanner'));
check('python-httpx2/ (junk-bearer sender) → scanner by UA prefix', is('python-httpx2/2.12.0', 'mcp', 'scanner', 'ua:python-httpx2/'));
check('Mozilla/5.0 (compatible) → scanner', is('Mozilla/5.0 (compatible)', undefined, 'scanner'));
check('self-link convention → scanner', is('mcp-thing/0.1 (+mailto:ops@example.com)', undefined, 'scanner', 'ua:self-link'));
check('GoogleOther stays a whole-token hit after the CamelCase change', is('GoogleOther', undefined, 'scanner', 'keyword:googleother'));

console.log('scanners, the 09-12 direct remainder:');
check('MCPScoringEngine/1.0 → scanner (CamelCase → scoring)', is('MCPScoringEngine/1.0', 'MCPScoringEngine', 'scanner', 'keyword:scoring'));
check('MCPScoringEngine UA alone (no name) → scanner', is('MCPScoringEngine/1.0', undefined, 'scanner', 'keyword:scoring'));
check('SaSame-MCP-Audit/0.1 → scanner (audit)', is('SaSame-MCP-Audit/0.1', undefined, 'scanner', 'keyword:audit'));
check('schema-study/0.1 → scanner (study)', is('schema-study/0.1', 'schema-study', 'scanner', 'keyword:study'));
check('mcp-inventory/0.1 + mcp-inventory-canary → scanner (inventory)', is('mcp-inventory/0.1', 'mcp-inventory-canary', 'scanner', 'keyword:inventory'));
check('AgentPulse on python-httpx → scanner (CamelCase → pulse)', is('python-httpx/0.28.1', 'AgentPulse', 'scanner', 'keyword:pulse'));
check('rpg-connect-check on node → scanner by exact name', is('node', 'rpg-connect-check', 'scanner', 'name:rpg-connect-check'));

console.log('scanners, the 09-15 direct remainder (after PR #138):');
check('mcpdd on a bare node UA → scanner by exact name', is('node', 'mcpdd', 'scanner', 'name:mcpdd'));
check('mcpdd is case-insensitive like every name rule', is('node', 'MCPDD', 'scanner', 'name:mcpdd'));
check('eyrie-validator/0.1.0 → scanner (validator)', is('eyrie-validator/0.1.0', 'eyrie-validator', 'scanner', 'keyword:validator'));
check('wormhole-survey on a browser UA → scanner (survey)', is('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'wormhole-survey', 'scanner', 'keyword:survey'));
check('cadastr-seeder/0.1 → scanner (seeder)', is('cadastr-seeder/0.1', 'cadastr-seeder', 'scanner', 'keyword:seeder'));
check('LiveAgent with no UA stays plain direct (`agent` is not a tell)', (() => {
  const r = cls(undefined, 'LiveAgent');
  return r.client_class === 'direct' && r.client_class_signal === undefined;
})());
check('otter on node stays plain direct (named but unidentified)', (() => {
  const r = cls('node', 'otter');
  return r.client_class === 'direct' && r.client_class_signal === undefined;
})());

console.log('third-party products (direct + product:<name>, 2026-09-24 — the first Grok install and a Cursor attempt):');
check('connectors-manager on grok-connectors-manager/0.1.0 → direct / product:grok', is('grok-connectors-manager/0.1.0', 'connectors-manager', 'direct', 'product:grok'));
check('grok-connectors-manager/ UA with no name (tool call) → direct / product:grok', is('grok-connectors-manager/0.1.0', undefined, 'direct', 'product:grok'));
check('grok-validator (the add-time validation) is NOT a scanner: keyword:validator must lose to the product', is('grok-connectors-manager/0.1.0', 'grok-validator', 'direct', 'product:grok'));
check('grok-validator with no UA → direct / product:grok', is(undefined, 'grok-validator', 'direct', 'product:grok'));
check('bare UA `Grok` (exact) → direct / product:grok', is('Grok', undefined, 'direct', 'product:grok'));
check('`GrokBot/1.0` is not the bare `Grok` UA — falls through to the vocabulary (bot)', is('GrokBot/1.0', undefined, 'scanner', 'keyword:bot'));
check('Cursor on Cursor/1.0.0 → direct / product:cursor', is('Cursor/1.0.0', 'Cursor', 'direct', 'product:cursor'));
check('Cursor MCP Availability on Cursor/1.0.0 → direct / product:cursor', is('Cursor/1.0.0', 'Cursor MCP Availability', 'direct', 'product:cursor'));
check('CursorServer/1.0.0 with no name → direct / product:cursor', is('CursorServer/1.0.0', undefined, 'direct', 'product:cursor'));
check('product names are case-insensitive like every name rule', is('node', 'Connectors-Manager', 'direct', 'product:grok'));
check('a product name never outranks a Claude UA (Claude-User + connectors-manager → claude)', is('Claude-User', 'connectors-manager', 'claude', 'ua:Claude-User'));
check('a product name never outranks an internal UA', is('fgac-auth-probe/1.0', 'connectors-manager', 'internal', 'ua:fgac-'));
check('the product is never `claude` (7.5 counts Anthropic products only)', cls('grok-connectors-manager/0.1.0', 'connectors-manager').client_class !== 'claude');

console.log('direct + ua:stock-runtime-no-name (unnamed automation on a bare runtime):');
for (const ua of ['Python/3.11 aiohttp/3.14.3', 'Bun/1.1.45', 'python-httpx/0.28.1', 'Go-http-client/2.0', 'node', 'undici', 'python-requests/2.32.3', 'axios/1.7.2', 'Deno/2.1.4']) {
  check(`${ua}, no clientInfo → direct / ua:stock-runtime-no-name`, is(ua, undefined, 'direct', 'ua:stock-runtime-no-name'));
}
check('a runtime UA WITH a name is plain direct (the name is the identity)', (() => {
  const r = cls('python-httpx/0.28.1', 'Anthropic');
  return r.client_class === 'direct' && r.client_class_signal === undefined;
})());
check("python-httpx + 'mcp' (the Python SDK default) is plain direct", (() => {
  const r = cls('python-httpx/0.28.1', 'mcp');
  return r.client_class === 'direct' && r.client_class_signal === undefined;
})());
check('node-fetch/ is a runtime, `node-something-else` is not', is('node-fetch/3.3.2', undefined, 'direct', 'ua:stock-runtime-no-name') && !is('nodeprobe-x/1', undefined, 'direct'));

console.log('direct, unlabelled (people and unknown named clients):');
for (const [ua, name] of [
  ['curl/8.7.1', undefined],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36', undefined],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/1.49585.0 Chrome/152.0.7977.76 Safari/537.36', undefined],
  ['undici', 'obolo-gateway'],
  ['node', 'otter'],
  [undefined, undefined],
  ['', ''],
] as const) {
  const r = cls(ua, name);
  check(`${JSON.stringify(ua)} / ${JSON.stringify(name)} → direct, no signal`, r.client_class === 'direct' && r.client_class_signal === undefined);
}

console.log('vocabulary guard — words a real product could carry are not tells:');
for (const name of ['workflow-engine', 'spellcheck-agent', 'my-gateway', 'mcp-client', 'inspector', 'router-app']) {
  check(`name ${name} on undici → direct`, cls('undici', name).client_class === 'direct');
}
check('CamelCase split does not create hits from ordinary words (AppleWebKit, MacIntel)',
  cls('Mozilla/5.0 (Macintosh; MacIntel) AppleWebKit/537.36 KHTML', undefined).client_class === 'direct');

console.log('route wiring (structural):');
const route = readFileSync(join(__dirname, '..', 'src', 'app', 'api', 'mcp', 'route.ts'), 'utf8');
check('route classifies from user-agent + initialize clientInfo',
  /classifyMcpClient\(\{ userAgent, clientName: clientInfo\?\.name \}\)/.test(route));
check('client_class is never consulted for a decision (measurement label only)',
  !/clientClass\.client_class\s*[!=]==?/.test(route) && !/client_class_signal\s*[!=]==?/.test(route));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall mcp-client-class checks passed');
