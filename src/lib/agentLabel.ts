/**
 * What an owner-facing email calls the agent — pure, so
 * `scripts/test-approval-notify-copy.ts` can pin it.
 *
 * The connection's nickname when the owner gave it one; else "your <client>
 * agent" from the MCP client's registered name; else "your AI agent". Then
 * the profile it runs on ("… on the Default Profile"), which is the thing the
 * owner can find on the dashboard.
 *
 * Never an id. A connection created before its client sent `initialize`
 * carries its opaque client_id as `clientName` (resolveConnection's
 * fallback), and the refusal email of 2026-09-23 read "FGAC has refused
 * JkGUAFOdt9Ib0Q7J 3 times" — the vowel-pair heuristic that used to catch
 * id-shaped names let that one through ("UA"). So the client id itself is
 * compared, not guessed at, and the heuristic is kept only as a backstop for
 * nicknames and names the id comparison cannot see.
 */

export interface AgentLabelInput {
  nickname: string | null;
  clientName: string | null;
  /** The connection's OAuth client_id — the value `clientName` falls back to. */
  clientId?: string | null;
  /** The bound profile's label (e.g. "Default Profile"), when known. */
  profileLabel?: string | null;
}

/** An opaque id, not a name: 12+ chars of [A-Za-z0-9_-] with no space that
 * either mixes digits and letters or has no vowel pair (base64url / nanoid /
 * Clerk ids). "claude-desktop" and "Claude Code" pass; "JkGUAFOdt9Ib0Q7J" and
 * "72T5NfMmQXkq" do not. */
export function looksLikeId(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{12,}$/.test(value)) return false;
  const mixed = /\d/.test(value) && /[A-Za-z]/.test(value);
  const noVowelPair = !/[aeiou]{2}/i.test(value);
  return mixed || noVowelPair;
}

function humanName(value: string | null | undefined): string | null {
  const v = value?.trim() ?? '';
  return v && !looksLikeId(v) ? v : null;
}

export function agentLabel(input: AgentLabelInput): string {
  const nickname = humanName(input.nickname);
  const client = input.clientName && input.clientName !== input.clientId ? humanName(input.clientName) : null;
  const who = nickname ?? (client ? `your ${client} agent` : 'your AI agent');
  const profile = humanName(input.profileLabel);
  if (!profile) return who;
  return `${who} on the ${profile}${/profile$/i.test(profile) ? '' : ' profile'}`;
}
