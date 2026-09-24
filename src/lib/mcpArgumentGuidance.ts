/**
 * Argument-name tolerance and guided refusals for MCP tool calls.
 *
 * In the 7 days to 2026-09-22, 75 production tool calls from 18 external
 * accounts (about one in six people who called a tool that week) were
 * refused by the SDK's Zod validation before any FGAC code ran — and in
 * almost every decoded row the agent knew exactly what it wanted and had
 * only spelled the argument differently: `spreadsheet_id` for
 * `spreadsheetId`, `message_id` / `id` for `messageId`, `url` / `uri` /
 * `api_path` for `path`, `resource_type` for `type`. Zod strips unknown keys
 * silently, so the SDK's answer was "expected string, received undefined"
 * on the canonical key with no mention of the key that WAS sent, embedded
 * in a pretty-printed JSON issue array; agents retried blind (one person
 * sent the same rejected `sheets_update_range` shape 15 times).
 *
 * The SDK (1.26) offers no hook on that text: `validateToolInput` throws
 * `McpError(InvalidParams, ZodError.message)` and mcp-handler builds a fresh
 * `McpServer` per request, so both halves of the fix live in the transport
 * wrapper around the handler (route.ts `withTransportObservability`):
 *
 *   1. `normalizeToolArguments` — before the SDK sees the request, move a
 *      known alias onto its canonical key (only when the canonical key is
 *      absent, so a correct call is never touched). The call then simply
 *      works, and the alias is recorded on `$mcp_tool_call.arg_aliases`.
 *   2. `describeArgumentFailure` — when validation still fails, one plain
 *      paragraph that names the missing / wrong argument, the keys the agent
 *      sent that this tool does not have, and the tool's exact argument
 *      list, in place of the JSON dump. The -32602 code stays.
 *
 * Pure: no db/env imports, so `scripts/test-argument-guidance.ts` can drive
 * it against the real SDK.
 */
import { z } from 'zod';

/** Alternative spellings agents send, per canonical argument name (measured 2026-09-22, runbook 7.10a). */
export const ARGUMENT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  spreadsheetId: ['spreadsheet_id', 'sheet_id', 'sheetId', 'spreadsheet', 'spreadsheetID'],
  documentId: ['document_id', 'doc_id', 'docId', 'document', 'documentID'],
  presentationId: ['presentation_id', 'slides_id', 'slidesId', 'presentation', 'presentationID'],
  fileId: ['file_id', 'fileID'],
  messageId: ['message_id', 'messageID', 'mail_id', 'email_id', 'emailId', 'msgId', 'msg_id'],
  attachmentId: ['attachment_id', 'attachmentID'],
  commentId: ['comment_id', 'commentID'],
  path: ['url', 'uri', 'api_path', 'apiPath', 'endpoint', 'api_url', 'apiUrl'],
  type: ['resource_type', 'resourceType', 'request_type', 'requestType', 'access_type', 'accessType', 'permission', 'kind'],
  recipient: ['recipient_email', 'recipientEmail', 'email'],
  resourceName: ['resource_name', 'file_name', 'fileName', 'title', 'name'],
  range: ['cell_range', 'cellRange', 'a1_range', 'a1Range'],
  values: ['rows', 'data', 'cells'],
  requests: ['batch_requests', 'batchUpdate', 'batch_update'],
  account: ['email_account', 'emailAccount', 'account_email', 'accountEmail', 'mailbox'],
  query: ['q', 'search', 'search_query', 'searchQuery'],
  pageToken: ['page_token', 'next_page_token', 'nextPageToken'],
  to: ['recipient', 'recipients', 'to_email', 'toEmail'],
  offset: ['start', 'start_offset', 'startOffset'],
  limit: ['max_chars', 'maxChars', 'chars'],
};

/**
 * `id` on its own is ambiguous only when a tool takes several ids
 * (request_access: spreadsheetId / documentId / presentationId). With exactly
 * one `…Id` argument it can only mean that one.
 */
const BARE_ID_KEYS = ['id', 'ID', 'Id'];

const MAX_ALIASES_PER_CALL = 10;

export interface AliasHit { from: string; to: string }

export interface NormalizedArguments {
  args: Record<string, unknown>;
  aliased: AliasHit[];
}

function camelFromSnake(key: string): string {
  return key.replace(/_([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Move aliased keys onto their canonical names for one tool. Never
 * overwrites a canonical key the agent did send; never invents a value.
 * Returns the same object untouched (aliased = []) when nothing applies.
 */
export function normalizeToolArguments(
  shapeKeys: readonly string[],
  args: Record<string, unknown>,
): NormalizedArguments {
  const canonical = new Set(shapeKeys);
  const idKeys = shapeKeys.filter(k => /Id$/.test(k));
  const aliased: AliasHit[] = [];
  let out = args;

  for (const key of shapeKeys) {
    if (out[key] !== undefined) continue;
    const candidates: string[] = [...(ARGUMENT_ALIASES[key] ?? [])];
    if (idKeys.length === 1 && idKeys[0] === key) candidates.push(...BARE_ID_KEYS);
    // Generic spellings: snake_case of the key, and a case-insensitive match.
    for (const sent of Object.keys(out)) {
      if (canonical.has(sent) || candidates.includes(sent)) continue;
      if (camelFromSnake(sent) === key || sent.toLowerCase() === key.toLowerCase()) candidates.push(sent);
    }
    const hit = candidates.find(c => !canonical.has(c) && out[c] !== undefined);
    if (!hit) continue;
    if (out === args) out = { ...args };
    out[key] = out[hit];
    delete out[hit];
    aliased.push({ from: hit, to: key });
    if (aliased.length >= MAX_ALIASES_PER_CALL) break;
  }
  return { args: out, aliased };
}

// ─── Guided refusal text ────────────────────────────────────────────────────

/**
 * Wrong-key hints that mean "different tool", not "different spelling" —
 * an alias would send the agent further down the wrong path.
 */
const WRONG_TOOL_HINTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  gmail_read: {
    query: 'To search or list messages call gmail_list with `query`; gmail_read reads ONE message by its `messageId` from that list.',
    threadId: 'For a whole thread call google_api_get with path gmail/v1/users/me/threads/{threadId}; gmail_read takes a single `messageId`.',
    thread_id: 'For a whole thread call google_api_get with path gmail/v1/users/me/threads/{threadId}; gmail_read takes a single `messageId`.',
  },
  request_access: {
    fileId: 'Pass the id under the key for its kind — `spreadsheetId`, `documentId`, or `presentationId` — together with the matching `type`.',
    file_id: 'Pass the id under the key for its kind — `spreadsheetId`, `documentId`, or `presentationId` — together with the matching `type`.',
    resource_id: 'Pass the id under the key for its kind — `spreadsheetId`, `documentId`, or `presentationId` — together with the matching `type`.',
    resourceId: 'Pass the id under the key for its kind — `spreadsheetId`, `documentId`, or `presentationId` — together with the matching `type`.',
  },
};

type JsonSchemaNode = {
  type?: string | string[];
  enum?: unknown[];
  anyOf?: JsonSchemaNode[];
  items?: JsonSchemaNode;
  description?: string;
};

type JsonSchemaObject = {
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
};

function typeLabel(node: JsonSchemaNode | undefined): string {
  if (!node) return 'value';
  if (Array.isArray(node.enum) && node.enum.length) return `one of ${node.enum.map(v => JSON.stringify(v)).join(' | ')}`;
  if (Array.isArray(node.anyOf) && node.anyOf.length) return node.anyOf.map(typeLabel).join(' or ');
  const t = Array.isArray(node.type) ? node.type.join('|') : node.type;
  if (t === 'array') {
    const inner = node.items;
    if (inner && (inner.type === 'array')) return 'array of arrays (rows of cells)';
    if (inner && inner.type === 'object') return 'array of objects';
    return 'array';
  }
  return t ?? 'value';
}

const MAX_DESCRIPTION_IN_HINT = 220;

function shortDescription(node: JsonSchemaNode | undefined): string | undefined {
  const d = node?.description?.trim().replace(/\.$/, '');
  if (!d) return undefined;
  return d.length > MAX_DESCRIPTION_IN_HINT ? `${d.slice(0, MAX_DESCRIPTION_IN_HINT - 1)}…` : d;
}

/** Zod 4 issue fields this module reads (a structural subset, never the class). */
export interface ZodIssueLike {
  code?: string;
  path?: ReadonlyArray<PropertyKey>;
  message?: string;
  expected?: unknown;
  values?: unknown[];
}

export interface ArgumentFailureInput {
  tool: string;
  shape: z.ZodRawShape;
  issues: ReadonlyArray<ZodIssueLike>;
  /** The arguments AFTER alias normalisation (what the schema was checked against). */
  args: Record<string, unknown>;
  aliased?: ReadonlyArray<AliasHit>;
}

function jsonSchemaFor(shape: z.ZodRawShape): JsonSchemaObject {
  try {
    return z.toJSONSchema(z.object(shape), { unrepresentable: 'any' }) as JsonSchemaObject;
  } catch {
    return { properties: {}, required: [] };
  }
}

function receivedLabel(message: string | undefined, value: unknown): string {
  const m = message?.match(/received ([A-Za-z_]+)/);
  if (m) return m[1];
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * One paragraph an agent can act on without decoding JSON. Shape:
 *
 *   MCP error -32602: Invalid arguments for tool sheets_read_range —
 *   missing required argument `spreadsheetId` (you sent `spreadsheet_id`,
 *   which is not an argument of this tool). Arguments: spreadsheetId
 *   (string, required) — Google Spreadsheet ID; range (string, required) —
 *   …; account (string, optional). Retry with exactly these names.
 *
 * Never echoes an argument VALUE: the text goes back to the agent, and the
 * capped copy of it lands on `mcp_input_validation_failed.message`.
 */
export function describeArgumentFailure(input: ArgumentFailureInput): string {
  const { tool, shape, issues, args } = input;
  const schema = jsonSchemaFor(shape);
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shapeKeys = Object.keys(shape);
  const canonical = new Set(shapeKeys);
  const unknownSent = Object.keys(args).filter(k => !canonical.has(k));
  const mentioned = new Set<string>();
  const problems: string[] = [];

  for (const issue of issues.slice(0, 6)) {
    const path = (issue.path ?? []).map(String);
    const key = path[0] ?? '';
    const dotted = path.join('.');
    const node = props[key];
    if (!key) {
      problems.push(issue.message ?? 'invalid arguments');
      continue;
    }
    const value = key in args ? args[key] : undefined;
    const missing = value === undefined && path.length === 1;
    let line: string;
    if (missing) {
      line = `missing required argument \`${key}\` (${typeLabel(node)})`;
    } else if (issue.code === 'invalid_value' && Array.isArray(issue.values)) {
      line = `\`${dotted}\` must be one of ${issue.values.map(v => JSON.stringify(v)).join(' | ')}`;
    } else if (issue.code === 'invalid_type' || issue.code === 'invalid_union') {
      const expected = path.length === 1 ? typeLabel(node) : (issue.expected ? String(issue.expected) : 'a different type');
      line = `\`${dotted}\` must be ${expected}, not ${receivedLabel(issue.message, path.length === 1 ? value : undefined)}`;
    } else {
      line = `\`${dotted}\`: ${issue.message ?? issue.code ?? 'invalid'}`;
    }
    const desc = shortDescription(node);
    if (desc && !mentioned.has(key)) line += ` — ${desc}`;
    mentioned.add(key);
    problems.push(line);
  }

  const parts: string[] = [];
  parts.push(`MCP error -32602: Invalid arguments for tool ${tool} — ${problems.join('; ')}.`);

  if (unknownSent.length) {
    const hints = unknownSent
      .map(k => WRONG_TOOL_HINTS[tool]?.[k])
      .filter((h): h is string => !!h);
    parts.push(
      `You sent ${unknownSent.map(k => `\`${k}\``).join(', ')}, which ${unknownSent.length === 1 ? 'is not an argument' : 'are not arguments'} of this tool and ${unknownSent.length === 1 ? 'was' : 'were'} ignored.`,
    );
    for (const h of new Set(hints)) parts.push(h);
  }

  const signature = shapeKeys.map(k => {
    const node = props[k];
    const req = required.has(k) ? 'required' : 'optional';
    if (mentioned.has(k)) return `${k} (${typeLabel(node)}, ${req})`;
    const desc = required.has(k) ? shortDescription(node) : undefined;
    return desc ? `${k} (${typeLabel(node)}, ${req}) — ${desc}` : `${k} (${typeLabel(node)}, ${req})`;
  });
  parts.push(`Arguments of ${tool}: ${signature.join('; ')}.`);
  parts.push('Retry with exactly these argument names.');
  return parts.join(' ');
}

/** The SDK's own prefix for the result this module replaces (mcp.js validateToolInput). */
export function isSdkInvalidArgumentsText(text: string, tool: string): boolean {
  return text.startsWith(`MCP error -32602: Input validation error: Invalid arguments for tool ${tool}: `);
}

/**
 * Replace the SDK's -32602 text for `tool` inside a streamable-HTTP POST body
 * (SSE frames or plain JSON) with `guidance`. Returns undefined when no frame
 * carried the SDK text — the caller then returns the original response.
 */
export function rewriteValidationFailureBody(body: string, tool: string, guidance: string): string | undefined {
  let replaced = false;
  const rewriteMessage = (msg: unknown): unknown => {
    const m = msg as { result?: { isError?: unknown; content?: unknown } } | null;
    const result = m?.result;
    if (!result || result.isError !== true || !Array.isArray(result.content)) return msg;
    const content = result.content.map((item: unknown) => {
      const c = item as { type?: unknown; text?: unknown };
      if (c?.type === 'text' && typeof c.text === 'string' && isSdkInvalidArgumentsText(c.text, tool)) {
        replaced = true;
        return { ...c, text: guidance };
      }
      return item;
    });
    return { ...m, result: { ...result, content } };
  };

  if (/^data:/m.test(body)) {
    const lines = body.split('\n').map(line => {
      if (!line.startsWith('data:')) return line;
      try {
        const parsed: unknown = JSON.parse(line.slice(5).trim());
        return `data: ${JSON.stringify(Array.isArray(parsed) ? parsed.map(rewriteMessage) : rewriteMessage(parsed))}`;
      } catch {
        return line;
      }
    });
    return replaced ? lines.join('\n') : undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    const out = Array.isArray(parsed) ? parsed.map(rewriteMessage) : rewriteMessage(parsed);
    return replaced ? JSON.stringify(out) : undefined;
  } catch {
    return undefined;
  }
}
