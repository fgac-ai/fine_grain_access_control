/**
 * Per-instance memo for the MCP auth layer's eager `resolveConnection` touch.
 *
 * Why (2026-09-08 analytics review): every authenticated MCP request runs
 * resolveConnection in the auth wrapper — a users read, an agent_connections
 * read, a lastUsedAt UPDATE and a proxy-key read, four sequential Neon round
 * trips — purely so new connections appear in the dashboard immediately and
 * `lastUsedAt` stays fresh. Tool handlers re-resolve on their own
 * (requireApproval), so the auth-layer result authorizes nothing. Meanwhile
 * two Claude Code users ran automation that spawned a fresh CLI process every
 * ~30 s for 18 h a day (each spawn = initialize + notifications/initialized +
 * tools/list, zero tool calls): ~1,800 handshakes and ~5,000 needless DB
 * touches a day from one idle client. (The initialize telemetry itself is
 * deliberately left uncoalesced — its per-event grain is what exposed the
 * pattern; see docs/monitoring.md 7.16.)
 *
 * Contract:
 *   - Routing hint ONLY. A memo hit skips a DB touch whose result
 *     was never used for authorization; a wrong entry can delay a dashboard
 *     "last used" timestamp or a client-name backfill by at most TTL_MS, never
 *     grant or deny access.
 *   - An `initialize` (clientInfo present) is skipped only when the name it
 *     reports would leave the connection row unchanged (the selection rule
 *     in src/lib/mcpClientName.ts): an unnamed row, an inspector-named row
 *     seeing its first product, or a product switch on a shared registration
 *     always reaches the DB, so `mcp_connection_client_identified` fires on
 *     every real transition. Handshake storms repeat one name, so they still
 *     skip.
 *   - Bounded LRU keyed by user+client so bogus ids cannot grow it.
 *   - Per function instance; cold starts always run the full path.
 */

import { nextConnectionClientName } from './mcpClientName';

export const TOUCH_MEMO_TTL_MS = 5 * 60 * 1000;
export const TOUCH_MEMO_MAX = 500;

interface TouchEntry {
  /** Last time the eager resolve actually ran (ms epoch). */
  touchedAt: number;
  /** The connection row's `client_name` as of that resolve — may still be the
   * opaque client_id placeholder or an inspector name; null when unknown. */
  clientName: string | null;
}

const memo = new Map<string, TouchEntry>();

const key = (userId: string, clientId: string) => `${userId} ${clientId}`;

function lruGet(k: string): TouchEntry | undefined {
  const v = memo.get(k);
  if (v !== undefined) {
    memo.delete(k);
    memo.set(k, v);
  }
  return v;
}

function lruSet(k: string, v: TouchEntry): void {
  if (memo.has(k)) {
    memo.delete(k);
  } else if (memo.size >= TOUCH_MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(k, v);
}

/**
 * Whether the auth layer may skip its eager resolveConnection for this
 * request. `incomingClientName` is the clientInfo.name when the request is an
 * `initialize` (undefined otherwise); an initialize whose name would change
 * the row must reach the DB.
 */
export function shouldSkipEagerResolve(
  userId: string,
  clientId: string,
  incomingClientName: string | undefined,
  now: number = Date.now(),
): boolean {
  const e = lruGet(key(userId, clientId));
  if (!e) return false;
  if (now - e.touchedAt >= TOUCH_MEMO_TTL_MS) return false;
  if (incomingClientName !== undefined) {
    // Unknown row name: never skip a handshake on a guess.
    if (e.clientName === null) return false;
    const change = nextConnectionClientName({ current: e.clientName, clientId, incoming: incomingClientName });
    if (change !== undefined) return false;
  }
  return true;
}

/**
 * Record that the eager resolve ran and the `client_name` the connection row
 * carries after it (the placeholder, an inspector name, or a product name;
 * null if the resolve did not return it). Call only after a resolve that did
 * not throw.
 */
export function recordEagerResolve(
  userId: string,
  clientId: string,
  clientName: string | null,
  now: number = Date.now(),
): void {
  const k = key(userId, clientId);
  const e = lruGet(k);
  if (e) {
    e.touchedAt = now;
    e.clientName = clientName;
    lruSet(k, e);
  } else {
    lruSet(k, { touchedAt: now, clientName });
  }
}

/** Test hook. */
export function resetTouchMemoForTests(): void {
  memo.clear();
}

/** Test hook. */
export function touchMemoSize(): number {
  return memo.size;
}
