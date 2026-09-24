/**
 * Which self-reported MCP client name an agent connection carries, and which
 * name a `$mcp_tool_call` is stamped with. Pure functions; pinned by
 * scripts/test-mcp-client-name.ts.
 *
 * Why this exists (measured in production PostHog, 2026-08-28 → 2026-09-24):
 *
 *   - Claude's connector directory inspects a server once, at connect time,
 *     with an `initialize` whose clientInfo.name is `Anthropic/Toolbox`. The
 *     user's real client (`Anthropic/ClaudeAI`) initializes under the SAME
 *     OAuth client_id less than a minute later (114 of 124 accounts; the rest
 *     within ten minutes). The inspection never recurs on its own: one per
 *     connection, matching the day's `mcp_connection_created` count, and no
 *     registration ever reported ONLY the inspector name.
 *   - The connection row used to keep the first name it was given, so the
 *     inspector name stuck to every later tool call: 61% of a week's
 *     `$mcp_tool_call` rows (12,431 of 20,235 on the Claude-User UA, week of
 *     2026-09-14) read `Anthropic/Toolbox`, a product nobody uses.
 *   - A registration is not a product either: claude.ai-managed connectors
 *     are shared with Claude Code, so 177 registrations reported both
 *     `Anthropic/ClaudeAI` and `claude-code` handshakes. "First real name
 *     wins" pins all of that user's calls to whichever product handshook
 *     first, forever.
 *
 * Stateless streamable HTTP gives a tool call no session: the server issues
 * no Mcp-Session-Id, and the POST carries no clientInfo. So the row's name is
 * the product signal, and the rule keeps it as close to "the product in use"
 * as one row allows: an unnamed row takes any name, an inspector name yields
 * to the first product name, and after that the most recent product handshake
 * wins (every claude.ai conversation and every Claude Code process opens with
 * one). The one per-request signal a tool call does carry — the CLI's own
 * `claude-code/<version>` user agent, never sent by claude.ai — overrides the
 * row at stamp time.
 */

/** Connect-time inspectors: they handshake once and never call a tool, so
 * their name must never outrank a product's. Compared case-insensitively. */
export const INSPECTOR_CLIENT_NAMES: ReadonlySet<string> = new Set(['anthropic/toolbox']);

export function isInspectorClientName(name: string | null | undefined): boolean {
  return !!name && INSPECTOR_CLIENT_NAMES.has(name.trim().toLowerCase());
}

/** A name that identifies a product: non-empty, not the opaque `client_id`
 * placeholder a nameless connection is created with, not an inspector. */
export function isProductClientName(name: string | null | undefined, clientId: string): boolean {
  return !!name && name !== clientId && !isInspectorClientName(name);
}

/**
 * The name the connection row should carry after an `initialize` reporting
 * `incoming`; `undefined` = leave the row as it is.
 *
 *   - no incoming name, or the same name → unchanged
 *   - row unnamed (null, empty, or the client_id placeholder) → incoming,
 *     even an inspector's: it still records that the connection arrived via
 *     the directory, and beats an opaque id in the dashboard
 *   - incoming is an inspector → unchanged: a product name is never
 *     downgraded, and a repeat inspection changes nothing
 *   - otherwise → incoming: the most recent product handshake wins
 */
export function nextConnectionClientName(input: {
  current: string | null | undefined;
  clientId: string;
  incoming: string | undefined;
}): string | undefined {
  const incoming = input.incoming?.trim();
  if (!incoming) return undefined;
  const current = input.current ?? '';
  if (incoming === current) return undefined;
  const unnamed = current === '' || current === input.clientId;
  if (unnamed) return incoming;
  if (isInspectorClientName(incoming)) return undefined;
  return incoming;
}

/** How a name change is labelled on `mcp_connection_client_identified`. */
export type ClientNameTransition = 'first' | 'inspector_to_product' | 'product_switch';

export function classifyClientNameTransition(previous: string | null | undefined, clientId: string): ClientNameTransition {
  if (!previous || previous === clientId) return 'first';
  if (isInspectorClientName(previous)) return 'inspector_to_product';
  return 'product_switch';
}

/** The Claude Code CLI's own user agent (`claude-code/2.1.271 (...)`). claude.ai
 * and the directory both arrive as `Claude-User`, so this prefix is the one
 * per-request product signal a tool call carries. */
export const CLAUDE_CODE_UA_PREFIX = 'claude-code/';
export const CLAUDE_CODE_CLIENT_NAME = 'claude-code';

/** `client_name` for a `$mcp_tool_call`: the request's own CLI user agent when
 * it has one, else the connection's current name (which may still be the
 * client_id placeholder for a connection that never initialized with a name). */
export function toolCallClientName(input: {
  connectionName: string | null | undefined;
  userAgent: string | undefined;
}): string | undefined {
  if (input.userAgent?.startsWith(CLAUDE_CODE_UA_PREFIX)) return CLAUDE_CODE_CLIENT_NAME;
  return input.connectionName || undefined;
}
