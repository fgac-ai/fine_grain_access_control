/**
 * Unit tests for the neonctl runner (scripts/lib/neonctl.ts), used by
 * db:branch, db:prune-branches and the branch-creation report.
 * Run: npx tsx scripts/test-neonctl-runner.ts  (part of `npm run mcp:lint`)
 *
 * Regression (2026-10-07): `npm run db:branch` failed with
 * `ERROR: Cannot read properties of undefined (reading 'branches')` and then
 * printed "Are you authenticated?". Auth was fine — neon 7.x turns a 200 whose
 * body read fails into `data: undefined`, and the same call succeeded on retry.
 * The runner must classify that as transient, retry it, and never call it auth.
 */
import { classifyNeonctlError, runNeonctl, runNeonctlJson } from './lib/neonctl';

let failures = 0;
const check = (name: string, ok: boolean) => {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) failures++;
};
const fail = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });
const noSleep = () => {};
/** An exec that plays back a script of outcomes: a string is stdout, an Error is thrown. */
const scripted = (outcomes: Array<string | Error>) => {
  const calls: string[] = [];
  const exec = (cmd: string) => {
    calls.push(cmd);
    const next = outcomes.shift();
    if (next instanceof Error) throw next;
    return next ?? '';
  };
  return { exec, calls };
};

const SWALLOWED = "ERROR: Cannot read properties of undefined (reading 'branches')";

check('swallowed body-read failure is transient', classifyNeonctlError(SWALLOWED) === 'transient');
check('swallowed failure on another field is transient too',
  classifyNeonctlError("ERROR: Cannot read properties of undefined (reading 'projects')") === 'transient');
check('a 401 is auth', classifyNeonctlError('ERROR: 401 Unauthorized') === 'auth');
check('a 503 is transient', classifyNeonctlError('ERROR: Request failed with status 503 Service Unavailable') === 'transient');
check('a branch limit is other (caller handles it)',
  classifyNeonctlError('ERROR: branches limit exceeded for this project') === 'other');
check('not found is other', classifyNeonctlError('ERROR: Branch foo not found.') === 'other');

{
  const { exec, calls } = scripted([fail(SWALLOWED), '[{"name":"main"}]']);
  const r = runNeonctlJson('branches list --project-id p', { exec, sleep: noSleep });
  check('transient failure is retried and the retry result returned',
    Array.isArray(r.result) && r.result[0].name === 'main' && calls.length === 2);
  check('the pinned CLI and -o json are on the command', calls[0].includes('neonctl@') && calls[0].endsWith('-o json'));
}
{
  const { exec, calls } = scripted([fail(SWALLOWED), fail(SWALLOWED), fail(SWALLOWED), '[]']);
  const r = runNeonctl('branches list', { exec, sleep: noSleep });
  check('gives up after retries+1 attempts as transient', r.kind === 'transient' && r.attempts === 3 && calls.length === 3);
}
{
  const { exec, calls } = scripted([fail('ERROR: 401 Unauthorized'), '[]']);
  const r = runNeonctl('branches list', { exec, sleep: noSleep });
  check('auth failures are not retried', r.kind === 'auth' && calls.length === 1);
}
{
  const { exec, calls } = scripted([fail(SWALLOWED), '{}']);
  const r = runNeonctl('branches create --name x', { exec, sleep: noSleep, retries: 0 });
  check('retries: 0 makes a single attempt (non-idempotent writes)', r.kind === 'transient' && calls.length === 1);
}
{
  const { exec } = scripted(['<html>gateway</html>']);
  const r = runNeonctlJson('branches list', { exec, sleep: noSleep });
  check('non-JSON stdout is reported, not thrown', r.error !== undefined && r.kind === 'transient');
}

if (failures > 0) {
  console.error(`\n${failures} neonctl-runner test(s) failed`);
  process.exit(1);
}
console.log('\nAll neonctl-runner tests passed.');
