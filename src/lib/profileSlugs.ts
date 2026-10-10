/**
 * Profile-addressed MCP URLs — slug helpers.
 *
 * /api/mcp/<slug> names which of the caller's agent profiles a NEW MCP
 * connection binds to. Slugs are derived from profile labels and are only
 * ever resolved within the authenticated user's own profiles, so they need
 * per-user uniqueness, not global uniqueness (enforced at profile creation
 * by createProxyKey).
 *
 * Pure module: imported by the edge middleware, route handlers, server
 * actions, and client components alike — keep it dependency-free.
 */

/** Valid URL slug: lowercase alphanumerics and single hyphens, ≤64 chars. */
export const PROFILE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Full-path matcher for profile-addressed MCP URLs. */
export const MCP_PROFILE_PATH_RE = /^\/api\/mcp\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;

/** URL slug for a profile label: 'Research Bot' → 'research-bot'. */
export function slugifyProfileLabel(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

/**
 * Dashboard page for one profile: /dashboard/agents/<slug>. Anything that is
 * not a valid slug (missing, tampered `profile=` query param) falls back to
 * /dashboard, which redirects to the default profile.
 *
 * Used by the approval flow so "Back to dashboard" returns to the profile
 * whose rule the approval just changed, not the default one.
 */
export function profileDashboardHref(slug: string | null | undefined): string {
  return slug && PROFILE_SLUG_RE.test(slug) ? `/dashboard/agents/${slug}` : '/dashboard';
}
