/**
 * Feature flags — PostHog-managed per user, with an environment override.
 *
 * `drive_tree` gates the folder-inherited Drive access model (plan
 * docs/implementation_plans/claude_google-drive-permissions-ux-427163_v1.md):
 * the dashboard's Drive tree card, the `drive` OAuth scope request, and the
 * lineage-resolving enforcement in the MCP route and the REST proxy. With the
 * flag off none of that code is reachable and every existing flow behaves
 * exactly as before.
 *
 * Who is on it is decided in PostHog (feature flag `drive_tree`, evaluated
 * remotely for the user's Clerk id with their email passed as a person
 * property, so an email condition works across the dev and production Clerk
 * instances and before the person has visited the dashboard). People are
 * added and removed in the PostHog UI — no deploy. The verdict is cached per
 * user for a minute (the MCP hot path must not call PostHog per tool call),
 * and PostHog being unreachable or unconfigured fails CLOSED: the legacy
 * behaviour, never the new one.
 *
 * Two environment switches remain for local dev and CI, where PostHog is not
 * part of the loop:
 *   FGAC_DRIVE_TREE=1            on for everyone (the fgac-dev-drive-tree launch config)
 *   FGAC_DRIVE_TREE_USERS=a,b    on for these Clerk user ids and/or emails
 * Either one wins over PostHog; neither set means PostHog decides.
 *
 * Pure resolvers + an injectable evaluator, so scripts/test-feature-flags.ts
 * covers the override, the cache, and the fail-closed paths.
 */
import { posthogClient } from './posthogServer';
import { withTimeout } from './upstreamTimeouts';

export const DRIVE_TREE_FLAG = 'drive_tree';

export type FlagUser = { clerkUserId?: string | null; email?: string | null };

export type FlagEnv = { FGAC_DRIVE_TREE?: string; FGAC_DRIVE_TREE_USERS?: string };

/** Asks the flag store; `undefined` = no verdict (treated as off). */
export type FlagEvaluator = (key: string, user: FlagUser) => Promise<boolean | undefined>;

const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 5_000;
const EVALUATE_TIMEOUT_MS = 3_000;

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Pure decision for the environment override alone. */
export function resolveDriveTreeFlag(env: FlagEnv, user: FlagUser): boolean {
  const global = (env.FGAC_DRIVE_TREE ?? '').trim().toLowerCase();
  if (ON_VALUES.has(global)) return true;
  const allow = parseList(env.FGAC_DRIVE_TREE_USERS);
  if (allow.length === 0) return false;
  const id = user.clerkUserId?.trim();
  const email = user.email?.trim().toLowerCase();
  return allow.some(entry => {
    if (entry.includes('@')) return !!email && entry.toLowerCase() === email;
    return !!id && entry === id;
  });
}

const cache = new Map<string, { on: boolean; at: number }>();

/** Test seam. */
export function _resetFlagCache(): void { cache.clear(); }

function cacheKey(user: FlagUser): string | null {
  const id = user.clerkUserId?.trim() ?? '';
  const email = user.email?.trim().toLowerCase() ?? '';
  if (!id && !email) return null;
  return `${id}|${email}`;
}

/**
 * The full decision: environment override, else the cached PostHog verdict
 * for this user, else ask `evaluate` (fail closed on no verdict, error or
 * timeout). A user with no identity at all is never on.
 */
export async function resolveDriveTreeFlagAsync(
  env: FlagEnv,
  user: FlagUser,
  evaluate: FlagEvaluator,
  now: number = Date.now(),
): Promise<boolean> {
  if (resolveDriveTreeFlag(env, user)) return true;
  const key = cacheKey(user);
  if (!key) return false;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.on;
  let on = false;
  try {
    on = (await evaluate(DRIVE_TREE_FLAG, user)) === true;
  } catch {
    on = false;
  }
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { on, at: now });
  return on;
}

/** PostHog remote evaluation (`/decide`) with the project key the server already holds. */
export const posthogFlagEvaluator: FlagEvaluator = async (key, user) => {
  const ph = posthogClient();
  if (!ph) return undefined;
  const email = user.email?.trim().toLowerCase();
  const distinctId = user.clerkUserId?.trim() || email;
  if (!distinctId) return undefined;
  return withTimeout(
    ph.isFeatureEnabled(key, distinctId, {
      personProperties: email ? { email } : undefined,
      // The decision is recorded on our own events (drive_tree props), not
      // as a $feature_flag_called row per tool call.
      sendFeatureFlagEvents: false,
    }),
    EVALUATE_TIMEOUT_MS,
  );
};

function envFromProcess(): FlagEnv {
  return { FGAC_DRIVE_TREE: process.env.FGAC_DRIVE_TREE, FGAC_DRIVE_TREE_USERS: process.env.FGAC_DRIVE_TREE_USERS };
}

/** The Drive tree flag for a user: env override, else PostHog (cached, fail closed). */
export function driveTreeFlagOn(user: FlagUser): Promise<boolean> {
  return resolveDriveTreeFlagAsync(envFromProcess(), user, posthogFlagEvaluator);
}

/** How the flag is configured, for env:check and logs — never the allowlist itself. */
export function describeDriveTreeFlag(env: FlagEnv = process.env as FlagEnv): string {
  if (ON_VALUES.has((env.FGAC_DRIVE_TREE ?? '').trim().toLowerCase())) return 'ON for everyone (FGAC_DRIVE_TREE override)';
  const n = parseList(env.FGAC_DRIVE_TREE_USERS).length;
  if (n > 0) return `ON for ${n} allowlisted user${n === 1 ? '' : 's'} (FGAC_DRIVE_TREE_USERS override) + PostHog flag "${DRIVE_TREE_FLAG}" for everyone else`;
  const configured = !!(process.env.NEXT_PUBLIC_POSTHOG_KEY && process.env.NEXT_PUBLIC_POSTHOG_HOST);
  return configured
    ? `PostHog feature flag "${DRIVE_TREE_FLAG}" decides per user (remote evaluation, 60 s cache, fails closed)`
    : `off — PostHog not configured and no FGAC_DRIVE_TREE / FGAC_DRIVE_TREE_USERS override`;
}
