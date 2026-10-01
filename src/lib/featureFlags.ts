/**
 * Feature flags — environment-driven, per user, no runtime dependency.
 *
 * `drive_tree` gates the folder-inherited Drive access model (plan
 * docs/implementation_plans/claude_google-drive-permissions-ux-427163_v1.md):
 * the dashboard's Drive tree card, the `drive` OAuth scope request, and the
 * lineage-resolving enforcement in the MCP route and the REST proxy. With the
 * flag off none of that code is reachable and every existing flow behaves
 * exactly as before.
 *
 * Two switches, separate on purpose:
 *   FGAC_DRIVE_TREE=1            on for everyone (local dev, previews)
 *   FGAC_DRIVE_TREE_USERS=a,b    on for these Clerk user ids and/or email
 *                                addresses only (a production beta)
 *
 * Pure resolver + env-reading wrapper, so the decision is unit-testable
 * (scripts/test-feature-flags.ts).
 */

export type FlagUser = { clerkUserId?: string | null; email?: string | null };

export type FlagEnv = { FGAC_DRIVE_TREE?: string; FGAC_DRIVE_TREE_USERS?: string };

const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);

function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Pure decision: is the Drive tree feature on for this user under this env? */
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

/** The Drive tree flag for a user, read from process.env. */
export function driveTreeFlagOn(user: FlagUser): boolean {
  return resolveDriveTreeFlag(
    { FGAC_DRIVE_TREE: process.env.FGAC_DRIVE_TREE, FGAC_DRIVE_TREE_USERS: process.env.FGAC_DRIVE_TREE_USERS },
    user,
  );
}

/** How the flag is configured, for env:check and logs — never the allowlist itself. */
export function describeDriveTreeFlag(env: FlagEnv = process.env as FlagEnv): string {
  if (ON_VALUES.has((env.FGAC_DRIVE_TREE ?? '').trim().toLowerCase())) return 'ON for everyone (FGAC_DRIVE_TREE)';
  const n = parseList(env.FGAC_DRIVE_TREE_USERS).length;
  if (n > 0) return `ON for ${n} allowlisted user${n === 1 ? '' : 's'} (FGAC_DRIVE_TREE_USERS)`;
  return 'off (FGAC_DRIVE_TREE / FGAC_DRIVE_TREE_USERS not set)';
}
