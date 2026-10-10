import { execSync } from 'child_process';

/**
 * The ONE place the Neon CLI version is chosen.
 *
 * Every script that shells out to neonctl builds its command here, so the
 * version is pinned once and bumped deliberately. It used to be
 * `npx --yes neonctl …` unpinned, which means "whatever the registry published
 * last night": between 2026-09-18 and 2026-09-29 that was twelve releases
 * across three major versions (5.0.0 → 7.0.1), and the daily neon-branch-prune
 * run of 2026-09-26 died on its first delete with a yargs arg-parsing error
 * (`Not enough non-option arguments: got 0, need at least 1`) that no single
 * release reproduces afterwards — the dependency was moving under the job.
 *
 * Bumping the pin: re-verify, against the real project, every subcommand the
 * scripts use — `projects list`, `branches list`, `branches create --compute`,
 * `branches delete <id>`, `connection-string --branch … --pooled`, and
 * `api <path>` — all with `-o json` where the caller parses JSON. 7.0.1 was
 * verified that way on 2026-09-30 (docs/implementation_plans/claude-brave-cerf-54ac0a_v1.md).
 */
export const NEONCTL_VERSION = '7.0.1';
export const NEONCTL_SPEC = `neonctl@${NEONCTL_VERSION}`;

/** `neonctl('branches list --project-id x -o json')` → the full shell command. */
export const neonctl = (args: string): string => `npx --yes ${NEONCTL_SPEC} ${args}`;

/**
 * Why a neonctl failure happened, which decides retry-or-stop and what to tell
 * the human. `npm run db:branch` used to print "Are you authenticated?" for
 * EVERY failure; on 2026-10-07 that sent a session hunting an auth problem
 * that did not exist (docs/implementation_plans/claude-neonctl-transient-retry_v1.md).
 *
 * - `transient`: the request never produced a usable answer. Includes the
 *   neon 7.x signature `Cannot read properties of undefined (reading '…')`:
 *   when the HTTP status is 200 but reading/parsing the body then fails (an
 *   abort mid-body, a truncated or non-JSON payload), @neon/sdk's client
 *   catches the exception and returns `{ error, response }`, and the CLI's
 *   `call()` only checks `response.ok`, so it hands the command `data:
 *   undefined`. The real error is swallowed — `--debug` prints nothing more.
 *   The same call succeeds on retry.
 * - `auth`: the API refused the credentials — re-run `npx neonctl auth`.
 * - `other`: a real answer we should not paper over (limit, not found, …).
 */
export type NeonctlFailure = 'transient' | 'auth' | 'other';

const TRANSIENT = [
  /Cannot read properties of undefined \(reading '/,
  /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNABORTED|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network/i,
  /\b(500|502|503|504)\b|Bad Gateway|Service Unavailable|Gateway Timeout|Internal Server Error/i,
];
const AUTH = [/\b401\b|unauthori[sz]ed|not authenticated|authentication (required|failed)|invalid (api key|token)|expired token/i];

export function classifyNeonctlError(message: string): NeonctlFailure {
  if (AUTH.some(re => re.test(message))) return 'auth';
  if (TRANSIENT.some(re => re.test(message))) return 'transient';
  return 'other';
}

/** One line telling the human what to do about a failure of this kind. */
export function neonctlHint(kind: NeonctlFailure): string {
  switch (kind) {
    case 'auth':
      return 'The Neon API refused the CLI credentials. Re-authenticate with `npx neonctl auth` (opens a browser) and re-run.';
    case 'transient':
      return 'The Neon API call failed transiently (retries exhausted). This is not an auth problem — re-run in a minute; check https://neonstatus.com if it persists.';
    default:
      return 'See the Neon CLI message above.';
  }
}

export interface NeonctlResult { stdout?: string; error?: string; kind?: NeonctlFailure; attempts: number }

type Exec = (command: string) => string;
const defaultExec: Exec = command => execSync(command, {
  encoding: 'utf-8',
  // stdin MUST be closed: `neonctl api` reads a request body from stdin whenever
  // it is not a TTY, so an inherited open pipe (an agent shell) hangs it forever.
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 180_000,
});
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Run a neonctl command, retrying transient failures. Never throws.
 * `retries` defaults to 2 (3 attempts, 2s then 4s apart). Pass `retries: 0` for
 * non-idempotent writes and reconcile instead (see branch-db's create path).
 */
export function runNeonctl(
  args: string,
  { retries = 2, exec = defaultExec, sleep = sleepSync }: { retries?: number; exec?: Exec; sleep?: (ms: number) => void } = {},
): NeonctlResult {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      return { stdout: exec(neonctl(args)), attempts: attempt };
    } catch (caught) {
      const err = caught as { stderr?: { toString(): string }; message?: string } | undefined;
      const stderr = err?.stderr?.toString?.() ?? '';
      const error = (stderr || err?.message || 'unknown neonctl error').trim();
      const kind = classifyNeonctlError(error);
      if (kind !== 'transient' || attempt > retries) return { error, kind, attempts: attempt };
      console.warn(`⚠️  neonctl ${args.split(' ').slice(0, 2).join(' ')}: transient failure (${error.split('\n')[0]}) — retrying (${attempt}/${retries})...`);
      sleep(2000 * attempt);
    }
  }
}

/** runNeonctl + `-o json` + JSON.parse. A non-JSON stdout counts as transient. */
export function runNeonctlJson<T = ReturnType<typeof JSON.parse>>(args: string, opts?: Parameters<typeof runNeonctl>[1]): { result?: T; error?: string; kind?: NeonctlFailure } {
  const r = runNeonctl(`${args} -o json`, opts);
  if (r.error !== undefined) return { error: r.error, kind: r.kind };
  try {
    return { result: JSON.parse(r.stdout ?? '') };
  } catch {
    return { error: `neonctl returned non-JSON output: ${(r.stdout ?? '').slice(0, 200)}`, kind: 'transient' };
  }
}
