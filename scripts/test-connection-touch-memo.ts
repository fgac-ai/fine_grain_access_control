/**
 * Unit tests for the MCP auth layer's connection-touch memo
 * (src/lib/connectionTouchMemo.ts).
 * Run: npx tsx scripts/test-connection-touch-memo.ts  (part of `npm run mcp:lint`)
 *
 * Background (2026-09-08): automation that spawns a fresh Claude Code process
 * every ~30 s re-runs the MCP handshake each time; the auth layer answered
 * every one of those requests with four Neon round trips and a PostHog event
 * whose result nothing consumed. The memo skips the DB touch inside a short
 * window, without ever skipping an initialize whose name would change the
 * connection row (src/lib/mcpClientName.ts: first name, the directory's
 * inspector yielding to the real client, a product switch on a shared
 * registration).
 */
import {
  shouldSkipEagerResolve,
  recordEagerResolve,
  resetTouchMemoForTests,
  touchMemoSize,
  TOUCH_MEMO_TTL_MS,
  TOUCH_MEMO_MAX,
} from '../src/lib/connectionTouchMemo';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  FAIL ${name}`); }
  else console.log(`  ok   ${name}`);
}

const U = 'user_test';
const C = 'client_test';
const T0 = 1_000_000;
const TOOLBOX = 'Anthropic/Toolbox';
const CLAUDEAI = 'Anthropic/ClaudeAI';
const CODE = 'claude-code';
// Non-initialize requests carry no clientInfo.
const NONE = undefined;

console.log('shouldSkipEagerResolve');
{
  resetTouchMemoForTests();
  check('cold miss never skips', shouldSkipEagerResolve(U, C, NONE, T0) === false);
  check('cold miss never skips an initialize', shouldSkipEagerResolve(U, C, CLAUDEAI, T0) === false);

  // Row still holds the client_id placeholder.
  recordEagerResolve(U, C, C, T0);
  check('non-initialize inside TTL skips', shouldSkipEagerResolve(U, C, NONE, T0 + 1000) === true);
  check('initialize does NOT skip while the row is unnamed', shouldSkipEagerResolve(U, C, CLAUDEAI, T0 + 1000) === false);
  check('even an inspector initialize reaches an unnamed row', shouldSkipEagerResolve(U, C, TOOLBOX, T0 + 1000) === false);

  // The directory inspected first; the real client's handshake must get through.
  recordEagerResolve(U, C, TOOLBOX, T0 + 2000);
  check('a repeat inspection on an inspector-named row skips', shouldSkipEagerResolve(U, C, TOOLBOX, T0 + 3000) === true);
  check('the first product handshake after the inspection runs', shouldSkipEagerResolve(U, C, CLAUDEAI, T0 + 3000) === false);

  recordEagerResolve(U, C, CLAUDEAI, T0 + 4000);
  check('initialize with the same product name skips (handshake storms)', shouldSkipEagerResolve(U, C, CLAUDEAI, T0 + 5000) === true);
  check('an inspector cannot downgrade a product row, so it skips', shouldSkipEagerResolve(U, C, TOOLBOX, T0 + 5000) === true);
  check('a product switch on a shared registration runs', shouldSkipEagerResolve(U, C, CODE, T0 + 5000) === false);
  check('TTL expiry re-runs the resolve', shouldSkipEagerResolve(U, C, NONE, T0 + 4000 + TOUCH_MEMO_TTL_MS) === false);
  check('a different client is a miss', shouldSkipEagerResolve(U, 'client_other', NONE, T0 + 5000) === false);
  check('a different user with the same client id is a miss', shouldSkipEagerResolve('user_other', C, NONE, T0 + 5000) === false);

  // A resolve that returned no name (unauthorized result) leaves the row name unknown.
  recordEagerResolve(U, C, null, T0 + 6000);
  check('unknown row name: non-initialize still skips', shouldSkipEagerResolve(U, C, NONE, T0 + 7000) === true);
  check('unknown row name: an initialize never skips on a guess', shouldSkipEagerResolve(U, C, CLAUDEAI, T0 + 7000) === false);
}

console.log('bounded LRU');
{
  resetTouchMemoForTests();
  for (let i = 0; i < TOUCH_MEMO_MAX + 50; i++) recordEagerResolve(U, `client_${i}`, CLAUDEAI, T0);
  check(`size is capped at ${TOUCH_MEMO_MAX}`, touchMemoSize() === TOUCH_MEMO_MAX);
  check('oldest entry was evicted', shouldSkipEagerResolve(U, 'client_0', NONE, T0 + 1) === false);
  check('newest entry survives', shouldSkipEagerResolve(U, `client_${TOUCH_MEMO_MAX + 49}`, NONE, T0 + 1) === true);
  // Reading an entry refreshes its recency.
  resetTouchMemoForTests();
  recordEagerResolve(U, 'client_a', CLAUDEAI, T0);
  for (let i = 0; i < TOUCH_MEMO_MAX - 1; i++) recordEagerResolve(U, `client_${i}`, CLAUDEAI, T0);
  shouldSkipEagerResolve(U, 'client_a', NONE, T0 + 1); // refresh
  recordEagerResolve(U, 'client_new', CLAUDEAI, T0);
  check('a recently read entry is not the eviction victim', shouldSkipEagerResolve(U, 'client_a', NONE, T0 + 1) === true);
  check('the stale entry was evicted instead', shouldSkipEagerResolve(U, 'client_0', NONE, T0 + 1) === false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
