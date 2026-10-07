/**
 * OpenAI plugin directory readiness (docs/distribution/chatgpt-plugin-submission.md):
 *   - every tool advertises readOnlyHint, destructiveHint and openWorldHint as
 *     explicit booleans (OpenAI rejects absent hints; review reads the scan)
 *   - the hint values are internally consistent and match the review rubric
 *     (read tools are never destructive; mail-sending tools are open-world)
 *   - the domain-verification route serves the bare token as text/plain and
 *     404s when no token is configured
 */
import assert from 'node:assert/strict';
import { TOOL_DEFS, toolAnnotations, type FgacToolDef } from '../src/app/api/mcp/toolDefs';
import { challengeResponse } from '../src/lib/openaiAppsChallenge';

const defs = Object.values(TOOL_DEFS) as FgacToolDef[];
for (const def of defs) {
  const a = toolAnnotations(def);
  for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint'] as const) {
    assert.equal(typeof a[hint], 'boolean', `${def.name}: ${hint} must be an explicit boolean`);
  }
  if (a.readOnlyHint) {
    assert.equal(a.destructiveHint, false, `${def.name}: read-only tool cannot be destructive`);
    assert.equal(a.openWorldHint, false, `${def.name}: read-only tool reads the user's own accounts`);
  }
}
for (const sender of ['gmail_send', 'google_api_modify'] as const) {
  const a = toolAnnotations(TOOL_DEFS[sender]);
  assert.equal(a.destructiveHint, true, `${sender}: sends cannot be undone → destructive`);
  assert.equal(a.openWorldHint, true, `${sender}: sends reach external recipients → open world`);
}

async function main() {
  const missing = challengeResponse(undefined);
  assert.equal(missing.status, 404);
  assert.equal(challengeResponse('   ').status, 404);
  const ok = challengeResponse('  tok_abc123\n');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await ok.text(), 'tok_abc123');
  console.log(`openai-plugin-readiness: ${defs.length} tools carry all three hints; challenge route OK`);
}
main().catch(e => { console.error(e); process.exit(1); });
