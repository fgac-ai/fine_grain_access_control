/**
 * Anonymous client signals for the connector install funnel.
 *
 * The pre-OAuth touchpoints (`connector_install_started`) fire with the
 * literal distinct_id 'anonymous-mcp', so PostHog person-space stays clean —
 * but that makes uniq(distinct_id) useless. `installFingerprint` provides the
 * uniqueness key as a PROPERTY instead: a salted hash of ip + user-agent, so
 * `uniq(properties.install_fingerprint)` counts installers without a raw IP
 * ever reaching PostHog.
 *
 * The salt is secret (ANALYTICS_FINGERPRINT_SALT, falling back to
 * CLERK_SECRET_KEY so no new provisioning is required), which is what makes
 * the hash non-reversible: without it, the IPv4 space is small enough to
 * brute-force. Rotating the salt rotates the fingerprint space — uniqueness
 * counts stay valid within a salt era, not across one.
 */
import { createHash } from 'node:crypto';

const MAX_CLIENT_NAME = 128;
const MAX_CLIENT_VERSION = 32;
// initialize requests are a few hundred bytes; anything big is a tool call.
const MAX_PARSE_BYTES = 100_000;

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? '';
}

export function installFingerprint(req: Request): string | undefined {
  const ip = clientIp(req);
  const ua = req.headers.get('user-agent') ?? '';
  if (!ip && !ua) return undefined;
  const salt = process.env.ANALYTICS_FINGERPRINT_SALT
    ?? process.env.CLERK_SECRET_KEY ?? '';
  return createHash('sha256').update(`${salt}|${ip}|${ua}`).digest('hex').slice(0, 32);
}

/**
 * Support-correlation hash for Gmail/Drive resource ids stamped on tool-call
 * events (`message_id_hash`, `resource_id_hash`). Deliberately UNSALTED and
 * truncated: a message id is not a secret (it is meaningless outside the
 * owner's mailbox), and the point is that an operator holding an id from a
 * support email can compute the same hash and find the calls —
 * `sha256(id).slice(0, 16)` — without the raw id ever reaching PostHog.
 */
export function resourceIdHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

export interface McpClientInfo {
  name: string;
  version?: string;
}

export interface RpcEnvelope {
  /** JSON-RPC methods in the body (one, or several for a batch). */
  methods: string[];
  /** `params.name` of the first tools/call in the body, if any. */
  toolName?: string;
  /** True when the body could not be parsed as JSON at all. */
  parseError: boolean;
}

/**
 * Cheap shape of an already-read POST body: which JSON-RPC method(s) it
 * carries and, for tools/call, which tool — the two facts the transport-
 * rejection and input-validation events need to be attributable to a call.
 * Never throws; a non-JSON body reports parseError so the caller can answer
 * with the JSON-RPC parse error the MCP handler itself fails to produce.
 */
export function parseRpcEnvelope(text: string): RpcEnvelope {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { methods: [], parseError: true };
  }
  const messages = Array.isArray(body) ? body : [body];
  const methods: string[] = [];
  let toolName: string | undefined;
  for (const msg of messages) {
    const m = msg as { method?: unknown; params?: { name?: unknown } };
    if (typeof m?.method !== 'string') continue;
    methods.push(m.method.slice(0, 64));
    if (m.method === 'tools/call' && toolName === undefined && typeof m.params?.name === 'string') {
      toolName = m.params.name.slice(0, 64);
    }
  }
  return { methods, toolName, parseError: false };
}

export type TransportRejectionReason =
  | 'parse_error'
  | 'discover_probe'
  | 'unsupported_protocol_version'
  | 'sdk';

export interface TransportRejectionClass {
  reason: Exclude<TransportRejectionReason, 'parse_error'>;
  /** First JSON-RPC method in the body — a scalar the runbook can GROUP BY. */
  rpc_method?: string;
}

const UNSUPPORTED_VERSION_MESSAGE = /^Bad Request: Unsupported protocol version/;
const DISCOVER_METHOD = 'server/discover';

/**
 * Why the MCP transport refused a request, at the granularity the runbook
 * needs to tell benign noise from a broken client.
 *
 * MCP 2026-07-28 replaced `initialize` with a `server/discover` probe that a
 * dual-era client sends FIRST, with `MCP-Protocol-Version: 2026-07-28`. A
 * legacy (SDK 1.x) server like this one answers the header check with the
 * 400 the 2025-06-18 transport spec mandates, and the spec's fallback rule
 * tells the client to read that 400 as "legacy server" and retry with
 * `initialize` — which is exactly what claude.ai does (2026-09-04 analytics
 * review: 148 probes from 59 clients in 10 h, every one followed by a
 * successful initialize within seconds). That row is therefore
 * `discover_probe`: expected, one extra round trip, nobody locked out.
 *
 * The same message on any OTHER method is the opposite: a client that never
 * sends the legacy handshake, i.e. one that is truly refused until the SDK is
 * bumped — `unsupported_protocol_version`. Everything else stays `sdk`.
 */
export function classifyTransportRejection(
  message: string | undefined,
  methods: string[] | undefined,
): TransportRejectionClass {
  const rpc_method = methods?.[0];
  if (rpc_method === DISCOVER_METHOD) return { reason: 'discover_probe', rpc_method };
  if (message && UNSUPPORTED_VERSION_MESSAGE.test(message)) {
    return { reason: 'unsupported_protocol_version', rpc_method };
  }
  return { reason: 'sdk', rpc_method };
}

/**
 * clientInfo from an MCP `initialize` request body, if this request is one.
 *
 * Stateless streamable HTTP builds a fresh McpServer per POST, so the server
 * instance that handles `tools/call` never saw `initialize` and
 * `getClientVersion()` is undefined there — the initialize POST itself is the
 * only place the client self-identifies. Reads a clone, so the body stays
 * available to the MCP handler; size-guarded so tool-call bodies are never
 * parsed twice; never throws.
 */
export async function parseInitializeClientInfo(req: Request): Promise<McpClientInfo | undefined> {
  try {
    if (req.method !== 'POST') return undefined;
    if (!(req.headers.get('content-type') ?? '').includes('application/json')) return undefined;
    const contentLength = Number(req.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PARSE_BYTES) return undefined;

    const text = await req.clone().text();
    if (text.length > MAX_PARSE_BYTES) return undefined;
    if (!/"method"\s*:\s*"initialize"/.test(text)) return undefined;

    const body: unknown = JSON.parse(text);
    const messages = Array.isArray(body) ? body : [body];
    for (const msg of messages) {
      const m = msg as { method?: unknown; params?: { clientInfo?: { name?: unknown; version?: unknown } } };
      if (m?.method !== 'initialize') continue;
      const name = m.params?.clientInfo?.name;
      if (typeof name !== 'string' || !name) continue;
      const version = m.params?.clientInfo?.version;
      return {
        name: name.slice(0, MAX_CLIENT_NAME),
        version: typeof version === 'string' ? version.slice(0, MAX_CLIENT_VERSION) : undefined,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------ */
/* Client classification: registry crawlers vs the clients we sell to.      */
/* ------------------------------------------------------------------------ */

/**
 * Coarse class of an MCP caller, stamped on `connector_install_started` and
 * `mcp_auth_attempt` as `client_class` (with the matching rule in
 * `client_class_signal`) so alerts and funnel queries can leave crawler
 * traffic out without a hand-maintained filter in every query.
 *
 *   - `claude`   — the products the acquisition funnel counts: claude.ai,
 *                  Claude Code, Cowork/Toolbox, the Sheets add-in.
 *   - `internal` — FGAC's own synthetic traffic (auth probe, smoke tests).
 *   - `scanner`  — MCP registry crawlers, directory health probes, "MCP
 *                  security" scanners, SEO bots. A 401 is the correct answer
 *                  for every one of them; nothing is blocked or rate-limited
 *                  on this value — it is a measurement label only.
 *   - `direct`   — everything else: unknown MCP clients, browsers, curl.
 *                  Within it, `client_class_signal = 'ua:stock-runtime-no-name'`
 *                  marks a request from a bare HTTP runtime (`Bun/1.1.45`,
 *                  `Python/3.11 aiohttp/…`, `Go-http-client/2.0`, `node`,
 *                  `undici`, `python-httpx/…`) that carried NO `clientInfo`
 *                  — nothing to name it by. Still `direct` (a stock runtime is
 *                  not evidence of a crawler: the Python and TypeScript MCP
 *                  SDKs run on exactly these), but a tokenless one is not an
 *                  SDK install flow either — every SDK's first request is an
 *                  `initialize` that names itself — so the daily review can
 *                  read those rows as unnamed automation rather than as a
 *                  real client that broke. Measured 2026-09-12: 142 of the
 *                  206 `direct` failures since the listing were this shape,
 *                  and none of the UAs had authenticated in 14 days.
 *
 * Why both user_agent and client_name: the registry ecosystem is split. Most
 * crawlers announce themselves in the user-agent (`SmitheryBot/1.0
 * (+https://smithery.ai)`), but a large minority run on a stock HTTP client
 * (`node`, `undici`, `Go-http-client/2.0`, `python-httpx/0.28.1`, Deno on
 * Supabase) and are only identifiable by the `clientInfo.name` they send in
 * an unauthenticated `initialize` (`glama`, `verifymcp-probe`,
 * `MCP-Marketplace-Scanner`). Measured on the first day after the MCP
 * Registry listing (2026-09-10, ~60 distinct sources in 9 hours): the two
 * fields together cover the population; either alone misses a third of it.
 *
 * Three layers, cheapest first, so a new crawler is usually caught without a
 * code change:
 *   1. explicit names / user-agent prefixes for sources whose strings say
 *      nothing (`glama`, `span-pipeline`, `frndOS`, `python-httpx2/…`);
 *   2. a vocabulary match on whole tokens of either string (`probe`,
 *      `scanner`, `crawler`, `health`, `registry`, `census`, `audit`, …,
 *      plus the `…Bot` suffix), which is how most of them describe
 *      themselves — CamelCase words are split too, so `MCPScoringEngine`
 *      is read as `mcp scoring engine` (it sat in `direct` for three days
 *      as one opaque token; 2026-09-12);
 *   3. the crawler self-identification convention `(+https://…)` /
 *      `(+mailto:…)` in the user-agent, which no interactive MCP client uses.
 *
 * Both inputs are caller-controlled, so the label is spoofable in both
 * directions — acceptable for the same reason `kid='probe'` is (nothing is
 * authorized on it; the tool-call volume floor alert is the compensating
 * control, see docs/monitoring.md 2–3).
 */
export type McpClientClass = 'claude' | 'internal' | 'scanner' | 'direct';

export interface McpClientClassification {
  client_class: McpClientClass;
  /**
   * Which rule matched, e.g. `ua:SmitheryBot/`, `name:glama`, `keyword:probe`,
   * `ua:self-link`; on `direct`, `ua:stock-runtime-no-name` or absent.
   */
  client_class_signal?: string;
}

/** The products whose unauthenticated `initialize` is an install attempt (7.5). */
const CLAUDE_CLIENT_NAMES = new Set([
  'anthropic/claudeai',
  'anthropic/toolbox',
  'claude-code',
  'claude-ai',
  'sheet-add-in',
]);
const CLAUDE_UA_PREFIXES = ['Claude-User', 'claude-code/'];

/** FGAC's own probes and smoke tests (clientInfo names used by our scripts and runbooks). */
const INTERNAL_CLIENT_NAMES = new Set([
  'auth-probe',
  'probe',
  'prod-smoke',
  'smoke-test',
  'deploy-smoke',
  'qa-probe',
  'post-deploy-probe',
  'qa-prod-verify',
  'diag',
]);
const INTERNAL_UA_PREFIXES = ['fgac-'];

/**
 * Sources whose strings carry no crawler vocabulary. Names are compared
 * case-insensitively and whole; user-agent prefixes are case-sensitive
 * (they are the product strings as sent). Measured population, 2026-09-10.
 */
const SCANNER_CLIENT_NAMES = new Set([
  'glama',
  'glama-mcp-inspector',
  'span-pipeline',
  'frndos',
  'reliability-bureau-spike',
  'measure-mcp-schema',
  'cracked',
  'mcp-selection-lab-prospective-gold-lock',
  'selection lab prospective gold lock',
  'directory-admin-dashboard',
  // 2026-09-12: a daily tokenless initialize on a stock `node` UA; the name
  // says what it is, but `check` alone is too common a word to be vocabulary.
  'rpg-connect-check',
]);
const SCANNER_UA_PREFIXES = [
  // Not the real httpx UA (`python-httpx/`): the junk-bearer sender that was
  // every non-probe invalid_token on 2026-09-10.
  'python-httpx2/',
  'mcp-selection-lab-',
  'directory-admin-dashboard-inspection',
  'Mozilla/5.0 (compatible)', // the bare "compatible" UA is a bot convention
];

/**
 * Whole-token vocabulary. Tokens are runs of letters/digits, and a token
 * written in CamelCase is additionally split at its case boundaries
 * (`MCPScoringEngine` → `mcp`, `scoring`, `engine`; `AgentPulse` → `agent`,
 * `pulse`) — the raw token is tried first so `GoogleOther` still matches
 * whole. `bot`, `scan`, `scanner`, `probe`, `crawler` and `index` also match
 * as suffixes (`SmitheryBot`, `mcpscan`, `agentprobe`, `mcpindex`).
 * Deliberately absent: `inspector` (the official MCP Inspector is a person
 * debugging), `client`, `agent`, `gateway`, `router` (aggregators can front
 * real users), `engine`, `check` (too generic to be a tell on their own).
 *
 * `audit`, `scoring`, `study`, `inventory`, `canary`, `pulse` were added
 * 2026-09-12 from the `direct` remainder of the first three days after the
 * registry listing (`SaSame-MCP-Audit/0.1`, `MCPScoringEngine/1.0`,
 * `schema-study/0.1`, `mcp-inventory/0.1` + `mcp-inventory-canary`,
 * `AgentPulse`); none of those words appeared in any authenticated
 * client_name or user-agent in the 14 days before.
 */
const SCANNER_KEYWORDS = new Set([
  'bot', 'bots', 'crawler', 'crawl', 'spider',
  'probe', 'prober', 'probes', 'probing',
  'scanner', 'scan',
  'healthcheck', 'health', 'liveness', 'monitor',
  'census', 'observatory', 'observer', 'witness',
  'indexer', 'index', 'catalog', 'registry', 'marketplace', 'sync', 'archive', 'ledger',
  'verify', 'checker', 'grader', 'reputation', 'research', 'inspection', 'introspect',
  'discovery', 'explorer', 'enricher', 'lab', 'googleother',
  'audit', 'auditor', 'scoring', 'study', 'inventory', 'canary', 'pulse',
]);
const SCANNER_SUFFIXES = ['bot', 'scan', 'scanner', 'probe', 'crawler', 'index'];
const SELF_LINK = /\(\+(https?:\/\/|mailto:|[a-z])/i;

/**
 * The user-agents of bare HTTP runtimes and SDK transports — what a request
 * looks like when nobody set a product string. Matched only when the request
 * also carries no `clientInfo.name`; see `ua:stock-runtime-no-name` above.
 * `curl`/`wget` are deliberately not here: those are tools a person runs.
 */
const STOCK_RUNTIME_UA = new RegExp(
  '^(?:Bun|node-fetch|axios|Deno|python-httpx|python-requests|Python-urllib|Python|aiohttp'
  + '|Go-http-client|okhttp|Java|Apache-HttpClient|GuzzleHttp|reqwest|Dart|ReactorNetty|libcurl)/'
  + '|^(?:node|undici)$',
);

function tokenHit(t: string): string | undefined {
  if (SCANNER_KEYWORDS.has(t)) return t;
  for (const suf of SCANNER_SUFFIXES) {
    if (t.length > suf.length && t.endsWith(suf)) return suf;
  }
  return undefined;
}

function keywordHit(s: string | undefined): string | undefined {
  if (!s) return undefined;
  for (const raw of s.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const whole = tokenHit(raw.toLowerCase());
    if (whole) return whole;
    // CamelCase: `MCPScoringEngine` → MCP | Scoring | Engine. Only worth a
    // second pass when the token actually mixes cases.
    if (!/[a-z]/.test(raw) || !/[A-Z]/.test(raw)) continue;
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ');
    if (parts.length < 2) continue;
    for (const part of parts) {
      const hit = tokenHit(part.toLowerCase());
      if (hit) return hit;
    }
  }
  return undefined;
}

function prefixHit(s: string | undefined, prefixes: readonly string[]): string | undefined {
  if (!s) return undefined;
  return prefixes.find((p) => s.startsWith(p));
}

export function classifyMcpClient(input: {
  userAgent?: string;
  clientName?: string;
}): McpClientClassification {
  const ua = input.userAgent?.trim() || undefined;
  const name = input.clientName?.trim() || undefined;
  const lname = name?.toLowerCase();

  let p = prefixHit(ua, INTERNAL_UA_PREFIXES);
  if (p) return { client_class: 'internal', client_class_signal: `ua:${p}` };
  if (lname && INTERNAL_CLIENT_NAMES.has(lname)) {
    return { client_class: 'internal', client_class_signal: `name:${lname}` };
  }

  p = prefixHit(ua, CLAUDE_UA_PREFIXES);
  if (p) return { client_class: 'claude', client_class_signal: `ua:${p}` };
  if (lname && CLAUDE_CLIENT_NAMES.has(lname)) {
    return { client_class: 'claude', client_class_signal: `name:${lname}` };
  }

  if (lname && SCANNER_CLIENT_NAMES.has(lname)) {
    return { client_class: 'scanner', client_class_signal: `name:${lname}` };
  }
  p = prefixHit(ua, SCANNER_UA_PREFIXES);
  if (p) return { client_class: 'scanner', client_class_signal: `ua:${p}` };
  const kw = keywordHit(name) ?? keywordHit(ua);
  if (kw) return { client_class: 'scanner', client_class_signal: `keyword:${kw}` };
  if (ua && SELF_LINK.test(ua)) return { client_class: 'scanner', client_class_signal: 'ua:self-link' };

  // Unnamed automation on a bare runtime: still `direct` (a stock UA is what
  // the real SDKs send too), but labelled so the review can tell it from an
  // unknown client that self-identified. No clientInfo means this request was
  // not an SDK's `initialize`.
  if (ua && !name && STOCK_RUNTIME_UA.test(ua)) {
    return { client_class: 'direct', client_class_signal: 'ua:stock-runtime-no-name' };
  }

  return { client_class: 'direct' };
}
