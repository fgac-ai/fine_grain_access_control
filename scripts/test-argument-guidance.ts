/**
 * Tests for argument-name tolerance and guided -32602 refusals
 * (src/lib/mcpArgumentGuidance.ts). Run: npx tsx scripts/test-argument-guidance.ts
 * (part of `npm run mcp:lint`).
 *
 * Background (2026-09-22 analytics review): 75 production tool calls from 18
 * external accounts in one week were refused by the SDK's Zod validation
 * because the agent spelled an argument differently (`spreadsheet_id`,
 * `message_id`/`id`, `url`/`uri`/`api_path`, `resource_type`). The SDK's
 * text named only the canonical key it did not find, inside a JSON issue
 * array, and agents retried the same shape blind.
 *
 * Three parts: (1) normalizeToolArguments against the route's real shapes
 * (copied verbatim for the fields under test); (2) the REAL SDK driven with
 * an aliased call proves the normalised arguments pass validation and the
 * un-normalised ones produce exactly the text rewriteValidationFailureBody
 * replaces; (3) describeArgumentFailure's paragraph names the missing key,
 * the keys the agent sent, and never an argument value.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  normalizeToolArguments, describeArgumentFailure, rewriteValidationFailureBody, isSdkInvalidArgumentsText,
} from '../src/lib/mcpArgumentGuidance';
import { parseValidationFailure } from '../src/lib/mcpClientSignals';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
  else console.log(`  ✓ ${name}`);
}

// The route's shapes, verbatim for the fields under test.
const SHAPES: Record<string, z.ZodRawShape> = {
  sheets_read_range: {
    spreadsheetId: z.string().describe('Google Spreadsheet ID'),
    range: z.string().describe("A1 range: 'Tab name'!A1:D20 (single quotes around a tab name with spaces), or a bare tab name for the whole tab."),
    account: z.string().optional().describe('Email account to use.'),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).optional(),
  },
  gmail_read: {
    account: z.string().optional(),
    messageId: z.string().describe('Gmail message ID — the "id" of an entry returned by gmail_list (not the threadId). The parameter is named messageId.'),
    format: z.enum(['full', 'metadata', 'minimal']).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).optional(),
  },
  google_api_get: {
    path: z.string().describe('API path (e.g. "gmail/v1/users/me/messages" or "v4/spreadsheets/1BxiM.../values/Sheet1")'),
    account: z.string().optional(),
  },
  google_api_modify: {
    path: z.string(),
    method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
    body: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
    account: z.string().optional(),
  },
  request_access: {
    type: z.enum(['send', 'sheets_read', 'sheets_write', 'docs_read', 'docs_write', 'slides_read', 'slides_write']).describe('What to request'),
    recipient: z.string().optional(),
    spreadsheetId: z.string().optional(),
    documentId: z.string().optional(),
    presentationId: z.string().optional(),
    resourceName: z.string().max(200).optional(),
  },
  sheets_update_range: {
    spreadsheetId: z.string(),
    range: z.string(),
    values: z.array(z.array(z.any())).describe('2D array of cell values: an array of rows, each row an array of cells. Pass a real JSON array — not a JSON-encoded string, not a flat list.'),
    account: z.string().optional(),
  },
};

async function callWithRealSdk(tool: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: 'fgac-test', version: '0.0.0' });
  for (const [name, shape] of Object.entries(SHAPES)) {
    server.registerTool(name, { inputSchema: shape }, async (params: unknown) => ({ content: [{ type: 'text', text: `ok ${JSON.stringify(params)}` }] }));
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'probe', version: '0.0.0' });
  await client.connect(clientT);
  const result = await client.callTool({ name: tool, arguments: args });
  await client.close();
  await server.close();
  return result as { isError?: boolean; content: { type: string; text?: string }[] };
}

function sseBody(result: unknown, id = 1): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

(async () => {
  console.log('normalizeToolArguments: the production alias shapes (7.10a, week to 2026-09-22)');
  {
    const r = normalizeToolArguments(Object.keys(SHAPES.sheets_read_range), { spreadsheet_id: '1abc', range: 'A1:B2' });
    check('spreadsheet_id → spreadsheetId', r.args.spreadsheetId === '1abc' && !('spreadsheet_id' in r.args) && r.args.range === 'A1:B2', r);
    check('the alias is reported from → to', JSON.stringify(r.aliased) === '[{"from":"spreadsheet_id","to":"spreadsheetId"}]', r.aliased);
  }
  for (const sent of [{ message_id: 'm1' }, { id: 'm1' }, { account: 'a@b', id: 'm1' }, { messageID: 'm1' }, { MessageId: 'm1' }]) {
    const r = normalizeToolArguments(Object.keys(SHAPES.gmail_read), sent);
    check(`${Object.keys(sent).join('+')} → messageId`, r.args.messageId === 'm1' && r.aliased.length === 1, r);
  }
  for (const sent of [{ url: 'gmail/v1/users/me/messages' }, { uri: 'gmail/v1/users/me/messages' }, { account: 'a@b', url: 'gmail/v1/users/me/messages' }]) {
    const r = normalizeToolArguments(Object.keys(SHAPES.google_api_get), sent);
    check(`${Object.keys(sent).join('+')} → path`, r.args.path === 'gmail/v1/users/me/messages' && r.aliased[0]?.to === 'path', r);
  }
  {
    const r = normalizeToolArguments(Object.keys(SHAPES.google_api_modify), { api_path: 'v4/spreadsheets', method: 'POST', body: {} });
    check('api_path → path (snake_case of a different word still maps via the alias table)', r.args.path === 'v4/spreadsheets', r);
  }
  {
    const r = normalizeToolArguments(Object.keys(SHAPES.request_access), { resource_type: 'sheets_read', resource_id: 'x', resource_name: 'Budget' });
    check('resource_type → type, resource_name → resourceName; resource_id stays (ambiguous across three id keys)',
      r.args.type === 'sheets_read' && r.args.resourceName === 'Budget' && r.args.resource_id === 'x' && r.aliased.length === 2, r);
    const bare = normalizeToolArguments(Object.keys(SHAPES.request_access), { type: 'sheets_read', id: 'x' });
    check('bare `id` is NOT guessed when a tool has several id arguments', bare.aliased.length === 0 && bare.args.id === 'x', bare);
  }
  {
    const r = normalizeToolArguments(Object.keys(SHAPES.sheets_read_range), { spreadsheetId: 'canonical', spreadsheet_id: 'alias', range: 'A1' });
    check('a canonical key the agent DID send is never overwritten by an alias', r.args.spreadsheetId === 'canonical' && r.aliased.length === 0, r);
    const same = normalizeToolArguments(Object.keys(SHAPES.sheets_read_range), { spreadsheetId: 'x', range: 'A1' });
    check('a correct call returns the same object untouched', same.args === ({ spreadsheetId: 'x', range: 'A1' } as unknown) || (same.aliased.length === 0 && same.args.spreadsheetId === 'x'));
  }
  {
    const r = normalizeToolArguments(Object.keys(SHAPES.sheets_update_range), { spreadsheet_id: 's', range: 'A1', rows: [[1]] });
    check('rows → values alongside spreadsheet_id', r.args.values !== undefined && r.args.spreadsheetId === 's' && r.aliased.length === 2, r);
  }

  console.log('real SDK: aliased arguments pass, un-aliased ones produce the text we replace');
  {
    const aliased = normalizeToolArguments(Object.keys(SHAPES.sheets_read_range), { spreadsheet_id: '1abc', range: 'A1:B2' }).args;
    const ok = await callWithRealSdk('sheets_read_range', aliased);
    check('normalised call is accepted by the SDK and reaches the handler', ok.isError !== true && (ok.content[0]?.text ?? '').startsWith('ok '), ok.content[0]);
    const refused = await callWithRealSdk('sheets_read_range', { spreadsheet_id: '1abc', range: 'A1:B2' });
    const text = refused.content[0]?.text ?? '';
    check('the same call un-normalised is refused by the SDK', refused.isError === true);
    check('the SDK text is the prefix rewriteValidationFailureBody keys on', isSdkInvalidArgumentsText(text, 'sheets_read_range'), text.slice(0, 100));
    check('the SDK text never mentions the key the agent sent (why guidance is needed)', !text.includes('spreadsheet_id'));

    const parsed = await z.object(SHAPES.sheets_read_range).safeParseAsync({ spreadsheet_id: '1abc', range: 'A1:B2' });
    const guidance = describeArgumentFailure({
      tool: 'sheets_read_range', shape: SHAPES.sheets_read_range,
      issues: parsed.success ? [] : parsed.error.issues, args: { spreadsheet_id: '1abc', range: 'A1:B2' },
    });
    const body = sseBody(refused);
    const rewritten = rewriteValidationFailureBody(body, 'sheets_read_range', guidance);
    check('SSE body: the SDK frame is rewritten with the guidance', !!rewritten && rewritten.includes('data: ') && rewritten.includes('You sent'), rewritten?.slice(0, 200));
    check('the rewritten frame is still a JSON-RPC isError result with the -32602 code in the text',
      (() => { const line = rewritten?.split('\n').find(l => l.startsWith('data:')) ?? ''; const m = JSON.parse(line.slice(5)); return m.result?.isError === true && m.result.content[0].text.startsWith('MCP error -32602: Invalid arguments for tool sheets_read_range'); })());
    check('the rewritten text no longer matches the tee parser (no double capture)', parseValidationFailure(rewritten ?? '') === undefined);
    check('plain JSON body (enableJsonResponse mode) is rewritten too',
      (rewriteValidationFailureBody(JSON.stringify({ jsonrpc: '2.0', id: 1, result: refused }), 'sheets_read_range', guidance) ?? '').includes('You sent'));
    check('a success body is left alone (undefined)', rewriteValidationFailureBody(sseBody({ content: [{ type: 'text', text: 'ok' }] }), 'sheets_read_range', guidance) === undefined);
    check('another tool\'s failure is left alone', rewriteValidationFailureBody(body, 'gmail_read', guidance) === undefined);
    check("our own isError results are left alone", rewriteValidationFailureBody(sseBody({ isError: true, content: [{ type: 'text', text: '❌ Access denied' }] }), 'sheets_read_range', guidance) === undefined);
  }

  console.log('describeArgumentFailure: what the agent reads');
  {
    const args = { spreadsheet_id: '1abc', range: 'A1:B2' };
    const parsed = await z.object(SHAPES.sheets_read_range).safeParseAsync(args);
    const text = describeArgumentFailure({ tool: 'sheets_read_range', shape: SHAPES.sheets_read_range, issues: parsed.success ? [] : parsed.error.issues, args });
    check('names the missing required key', text.includes('missing required argument `spreadsheetId`'), text);
    check('names the key the agent sent as not an argument of this tool', text.includes('You sent `spreadsheet_id`, which is not an argument of this tool'), text);
    check('lists the exact argument names with required/optional', text.includes('spreadsheetId (string, required)') && text.includes('range (string, required)') && text.includes('account (string, optional)'), text);
    check('never echoes an argument value', !text.includes('1abc') && !text.includes('A1:B2'));
    check('single paragraph, no JSON', !text.includes('\n') && !text.includes('"code"'));
    check('stays well under a tool-result budget', text.length < 1200, text.length);
  }
  {
    const args = { query: 'is:unread' };
    const parsed = await z.object(SHAPES.gmail_read).safeParseAsync(args);
    const text = describeArgumentFailure({ tool: 'gmail_read', shape: SHAPES.gmail_read, issues: parsed.success ? [] : parsed.error.issues, args });
    check('wrong-tool hint: query on gmail_read points at gmail_list', text.includes('gmail_list') && text.includes('missing required argument `messageId`'), text);
    check('enum argument lists its values', text.includes('format (one of "full" | "metadata" | "minimal", optional)'), text);
  }
  {
    const args = { resource_id: '1abc', resource_name: 'Budget', resource_type: 'spreadsheet' };
    const norm = normalizeToolArguments(Object.keys(SHAPES.request_access), args);
    const parsed = await z.object(SHAPES.request_access).safeParseAsync(norm.args);
    const text = describeArgumentFailure({ tool: 'request_access', shape: SHAPES.request_access, issues: parsed.success ? [] : parsed.error.issues, args: norm.args, aliased: norm.aliased });
    check('request_access: after aliasing resource_type → type the enum miss is named with its values',
      text.includes('`type` must be one of "send" | "sheets_read"') && text.includes('"slides_write"'), text);
    check('request_access: resource_id gets the per-kind id hint', text.includes('`spreadsheetId`, `documentId`, or `presentationId`'), text);
    check('never echoes the enum value the agent sent', !text.includes('spreadsheet"') && !text.includes("'spreadsheet'") && !/\bspreadsheet\b(?!Id)/.test(text.replace(/spreadsheetId/g, '')), text);
  }
  {
    const args = { spreadsheetId: 's', range: 'A1', values: '[[1]]' };
    const parsed = await z.object(SHAPES.sheets_update_range).safeParseAsync(args);
    const text = describeArgumentFailure({ tool: 'sheets_update_range', shape: SHAPES.sheets_update_range, issues: parsed.success ? [] : parsed.error.issues, args });
    check('values as a string: names the type mismatch and carries the description', text.includes('`values` must be array of arrays (rows of cells), not string') && text.includes('not a JSON-encoded string'), text);
    check('never echoes the value', !text.includes('[[1]]'));
  }
  {
    const args = { path: 'p', method: 'get', body: [1] };
    const parsed = await z.object(SHAPES.google_api_modify).safeParseAsync(args);
    const text = describeArgumentFailure({ tool: 'google_api_modify', shape: SHAPES.google_api_modify, issues: parsed.success ? [] : parsed.error.issues, args });
    check('lowercase method: enum values named', text.includes('`method` must be one of "POST" | "PUT" | "PATCH"'), text);
    check('bare array body: union expectation named', text.includes('`body` must be string or object, not array'), text);
  }
  {
    const parsed = await z.object(SHAPES.gmail_read).safeParseAsync({});
    const text = describeArgumentFailure({ tool: 'gmail_read', shape: SHAPES.gmail_read, issues: parsed.success ? [] : parsed.error.issues, args: {} });
    check('no arguments at all: missing key named, no "you sent" clause', text.includes('missing required argument `messageId`') && !text.includes('You sent'), text);
  }

  if (failures) { console.error(`\n${failures} argument-guidance test(s) failed`); process.exit(1); }
  console.log('\nAll argument-guidance tests passed.');
})();
