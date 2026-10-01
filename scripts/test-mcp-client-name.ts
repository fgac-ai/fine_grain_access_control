/**
 * Pinned tests for the MCP client-name selection rule
 * (src/lib/mcpClientName.ts).
 * Run: npx tsx scripts/test-mcp-client-name.ts  (part of `npm run mcp:lint`)
 *
 * Background (production PostHog, 2026-08-28 → 2026-09-24): the connector
 * directory's connect-time inspection (`Anthropic/Toolbox`) named 65 of the
 * week's 98 claude.ai callers and 61% of their tool calls, because the
 * connection row kept the first name it ever saw. The rule pinned here lets
 * an inspector name yield to the first product name, lets the most recent
 * product handshake win after that (claude.ai and Claude Code share one
 * registration), and lets the CLI's own user agent override the row at tool
 * call time.
 */
import {
  INSPECTOR_CLIENT_NAMES,
  isInspectorClientName,
  isProductClientName,
  nextConnectionClientName,
  classifyClientNameTransition,
  toolCallClientName,
} from '../src/lib/mcpClientName';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const CID = 'a1B2c3D4e5F6g7H8';
const TOOLBOX = 'Anthropic/Toolbox';
const CLAUDEAI = 'Anthropic/ClaudeAI';
const CODE = 'claude-code';

console.log('inspector names');
{
  check('the directory inspector is an inspector', isInspectorClientName(TOOLBOX));
  check('case-insensitive', isInspectorClientName('anthropic/TOOLBOX'));
  check('claude.ai is not', !isInspectorClientName(CLAUDEAI));
  check('claude-code is not', !isInspectorClientName(CODE));
  check('null/empty are not', !isInspectorClientName(null) && !isInspectorClientName(''));
  check('the allowlist holds exactly the measured inspector', INSPECTOR_CLIENT_NAMES.size === 1);
}

console.log('product names');
{
  check('claude.ai is a product', isProductClientName(CLAUDEAI, CID));
  check('the client_id placeholder is not', !isProductClientName(CID, CID));
  check('an inspector is not', !isProductClientName(TOOLBOX, CID));
  check('null is not', !isProductClientName(null, CID));
}

console.log('nextConnectionClientName — the measured connect sequence');
{
  // Row created by the SSE GET (no clientInfo) → placeholder name.
  check('placeholder takes the inspector name', nextConnectionClientName({ current: CID, clientId: CID, incoming: TOOLBOX }) === TOOLBOX);
  // The inspection, then the real client under a minute later.
  check('inspector yields to the first product name', nextConnectionClientName({ current: TOOLBOX, clientId: CID, incoming: CLAUDEAI }) === CLAUDEAI);
  // Every later claude.ai conversation re-initializes with the same name.
  check('same name is a no-op', nextConnectionClientName({ current: CLAUDEAI, clientId: CID, incoming: CLAUDEAI }) === undefined);
  // A reconnect through the directory inspects again (10 of 124 accounts).
  check('a product name is never downgraded to an inspector', nextConnectionClientName({ current: CLAUDEAI, clientId: CID, incoming: TOOLBOX }) === undefined);
  check('a repeat inspection on an inspector-named row is a no-op', nextConnectionClientName({ current: TOOLBOX, clientId: CID, incoming: TOOLBOX }) === undefined);
}

console.log('nextConnectionClientName — shared registrations');
{
  check('claude.ai → Claude Code switches the row', nextConnectionClientName({ current: CLAUDEAI, clientId: CID, incoming: CODE }) === CODE);
  check('Claude Code → claude.ai switches it back', nextConnectionClientName({ current: CODE, clientId: CID, incoming: CLAUDEAI }) === CLAUDEAI);
  check('the Sheets add-in switches too', nextConnectionClientName({ current: CLAUDEAI, clientId: CID, incoming: 'sheet-add-in' }) === 'sheet-add-in');
}

console.log('nextConnectionClientName — edges');
{
  check('no incoming name is a no-op', nextConnectionClientName({ current: CLAUDEAI, clientId: CID, incoming: undefined }) === undefined);
  check('blank incoming name is a no-op', nextConnectionClientName({ current: CLAUDEAI, clientId: CID, incoming: '   ' }) === undefined);
  check('null row takes any name', nextConnectionClientName({ current: null, clientId: CID, incoming: CLAUDEAI }) === CLAUDEAI);
  check('empty row takes any name', nextConnectionClientName({ current: '', clientId: CID, incoming: CODE }) === CODE);
  check('incoming is trimmed', nextConnectionClientName({ current: CID, clientId: CID, incoming: ' claude-code ' }) === CODE);
  check('placeholder row, placeholder incoming is a no-op', nextConnectionClientName({ current: CID, clientId: CID, incoming: CID }) === undefined);
}

console.log('classifyClientNameTransition');
{
  check('placeholder → first', classifyClientNameTransition(CID, CID) === 'first');
  check('null → first', classifyClientNameTransition(null, CID) === 'first');
  check('inspector → inspector_to_product', classifyClientNameTransition(TOOLBOX, CID) === 'inspector_to_product');
  check('product → product_switch', classifyClientNameTransition(CLAUDEAI, CID) === 'product_switch');
}

console.log('toolCallClientName');
{
  check('row name by default', toolCallClientName({ connectionName: CLAUDEAI, userAgent: 'Claude-User' }) === CLAUDEAI);
  check('the CLI user agent overrides a claude.ai row', toolCallClientName({ connectionName: CLAUDEAI, userAgent: 'claude-code/2.1.271 (claude-desktop, agent-sdk/0.3.271)' }) === CODE);
  check('the CLI user agent overrides a placeholder row', toolCallClientName({ connectionName: CID, userAgent: 'claude-code/2.1.275 (external, cli)' }) === CODE);
  check('Claude-User does not override', toolCallClientName({ connectionName: CODE, userAgent: 'Claude-User' }) === CODE);
  check('a bare "claude-code" UA without the slash is not the CLI prefix', toolCallClientName({ connectionName: CLAUDEAI, userAgent: 'claude-code' }) === CLAUDEAI);
  check('placeholder row stamps the placeholder (unchanged behaviour)', toolCallClientName({ connectionName: CID, userAgent: 'curl/8.7.1' }) === CID);
  check('null row stamps nothing', toolCallClientName({ connectionName: null, userAgent: 'curl/8.7.1' }) === undefined);
  check('no UA falls back to the row', toolCallClientName({ connectionName: CLAUDEAI, userAgent: undefined }) === CLAUDEAI);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
