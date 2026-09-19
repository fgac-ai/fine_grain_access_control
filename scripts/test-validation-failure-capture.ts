/**
 * Tests for the structured capture of SDK input-validation failures
 * (src/lib/mcpClientSignals.ts: parseValidationFailure, validationFailureProps,
 * parseRpcEnvelope.argumentKeys) plus a structural guard on the route's tee.
 * Run: npx tsx scripts/test-validation-failure-capture.ts  (part of `npm run mcp:lint`)
 *
 * Background (2026-09-17 analytics review): `mcp_input_validation_failed`
 * had fired 137 times in production and every row's `message` ended at
 * `Invalid arguments for tool <name>: [` — the SDK embeds Zod 4's JSON issue
 * array in the error text, the text is JSON-encoded inside the response
 * body, and the old `[^"\\]{0,300}` capture stopped at the first escape.
 * The event could count failures but never say which argument was wrong.
 *
 * The first half drives the REAL SDK (McpServer + Client over an in-memory
 * transport) with the route's actual Zod shapes, so the fixture text is
 * whatever this SDK version emits — a format change fails here, not in
 * production. The second half feeds that text through the SSE framing the
 * streamable-HTTP transport writes and asserts the decoded props.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseRpcEnvelope, parseValidationFailure, validationFailureProps } from '../src/lib/mcpClientSignals';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
  else console.log(`  ✓ ${name}`);
}

/** The route's `event: message\ndata: …` SSE framing around a JSON-RPC result. */
function sseBody(result: unknown, id = 1): string {
  return `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`;
}

async function callWithRealSdk(tool: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: 'fgac-test', version: '0.0.0' });
  // The route's shapes, verbatim for the fields under test.
  server.registerTool('gmail_read', {
    inputSchema: {
      account: z.string().optional(),
      messageId: z.string(),
      format: z.enum(['full', 'metadata', 'minimal']).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    },
  }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.registerTool('google_api_modify', {
    inputSchema: {
      path: z.string(),
      method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
      body: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
    },
  }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  server.registerTool('sheets_update_range', {
    inputSchema: { spreadsheetId: z.string(), range: z.string(), values: z.array(z.array(z.any())) },
  }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'probe', version: '0.0.0' });
  await client.connect(clientT);
  const result = await client.callTool({ name: tool, arguments: args });
  await client.close();
  await server.close();
  return result as { isError?: boolean; content: { type: string; text?: string }[] };
}

(async () => {
  console.log('real SDK: what a -32602 tool result looks like');
  const idNotMessageId = await callWithRealSdk('gmail_read', { id: 'abc' });
  check('invalid arguments come back as isError:true, not a thrown JSON-RPC error', idNotMessageId.isError === true);
  const text = idNotMessageId.content[0]?.text ?? '';
  check('text carries the -32602 prefix and the tool name',
    text.startsWith('MCP error -32602: Input validation error: Invalid arguments for tool gmail_read: '), text.slice(0, 120));
  check('the tail is a JSON issue array (Zod 4 ZodError.message)',
    /: \[\s*\{/.test(text) && text.trimEnd().endsWith(']'), text.slice(-40));
  check('the old regex capture ends at the opening bracket (the production truncation)',
    (JSON.stringify(text).match(/MCP error -32602: (Input validation error|Tool [^"\\]{1,64} not found)[^"\\]{0,300}/)?.[0] ?? '').endsWith(': ['));

  console.log('parseValidationFailure: SSE-framed bodies');
  {
    const f = parseValidationFailure(sseBody(idNotMessageId));
    check('decodes kind/tool', f?.kind === 'invalid_arguments' && f.tool === 'gmail_read', f);
    check('names the failing argument', f?.issues[0]?.path === 'messageId', f?.issues);
    check('records expected vs received', f?.issues[0]?.code === 'invalid_type' && f?.issues[0]?.expected === 'string' && f?.issues[0]?.received === 'undefined', f?.issues[0]);
    check('issue_count and issues_parsed', f?.issue_count === 1 && f?.issues_parsed === true);
    check('message is whitespace-collapsed and capped at 300', !!f && !/\n/.test(f.message) && f.message.length <= 300 && f.message.includes('messageId'), f?.message);
  }
  {
    const r = await callWithRealSdk('gmail_read', { messageId: 'x', format: 'FULL', offset: '0' });
    const f = parseValidationFailure(sseBody(r));
    check('multiple issues keep order: format then offset', JSON.stringify(f?.issues.map(i => i.path)) === '["format","offset"]', f?.issues);
    check('enum failure lists the allowed values as expected', f?.issues[0]?.code === 'invalid_value' && f?.issues[0]?.expected === 'full|metadata|minimal', f?.issues[0]);
    check('string-for-number is invalid_type expected number received string', f?.issues[1]?.expected === 'number' && f?.issues[1]?.received === 'string', f?.issues[1]);
  }
  {
    const r = await callWithRealSdk('google_api_modify', { path: 'p', method: 'get', body: [1] });
    const f = parseValidationFailure(sseBody(r));
    const body = f?.issues.find(i => i.path === 'body');
    check('lowercase method is an invalid_value on method', f?.issues[0]?.path === 'method' && f?.issues[0]?.code === 'invalid_value');
    check('union failure joins branch expectations and surfaces received', body?.code === 'invalid_union' && body?.expected === 'string|record' && body?.received === 'array', body);
  }
  {
    const r = await callWithRealSdk('sheets_update_range', { spreadsheetId: 's', range: 'A1', values: [1, 2] });
    const f = parseValidationFailure(sseBody(r));
    check('nested paths are dotted (values.0)', f?.issues[0]?.path === 'values.0' && f?.issues[0]?.received === 'number', f?.issues[0]);
    const p = validationFailureProps(f!, ['spreadsheetId', 'range', 'values']);
    check('props: first_issue_* scalars', p.first_issue_path === 'values.0' && p.first_issue_code === 'invalid_type' && p.first_issue_expected === 'array' && p.first_issue_received === 'number', p);
    check('props: issue_paths / issue_codes arrays', JSON.stringify(p.issue_paths) === '["values.0","values.1"]' && JSON.stringify(p.issue_codes) === '["invalid_type","invalid_type"]', p);
    check('props: sent keys ride along with a count', JSON.stringify(p.sent_keys) === '["spreadsheetId","range","values"]' && p.sent_key_count === 3);
    check('props never carry an argument value', !JSON.stringify(p).includes('"s"') && !JSON.stringify(p).includes('A1'));
  }
  {
    const r = await callWithRealSdk('gmail_search', { query: 'is:unread' });
    const f = parseValidationFailure(sseBody(r));
    check('unknown tool → kind unknown_tool with the requested name', f?.kind === 'unknown_tool' && f.tool === 'gmail_search', f);
    const p = validationFailureProps(f!, ['query']);
    check('unknown tool props carry no issue fields but keep sent keys', p.issue_count === undefined && p.first_issue_path === undefined && JSON.stringify(p.sent_keys) === '["query"]');
  }

  console.log('parseValidationFailure: other framings and non-matches');
  check('plain JSON body (enableJsonResponse mode) parses too',
    parseValidationFailure(JSON.stringify({ jsonrpc: '2.0', id: 1, result: idNotMessageId }))?.issues[0]?.path === 'messageId');
  check('a batch array body parses',
    parseValidationFailure(JSON.stringify([{ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }, { jsonrpc: '2.0', id: 2, result: idNotMessageId }]))?.tool === 'gmail_read');
  check('a success result is undefined', parseValidationFailure(sseBody({ content: [{ type: 'text', text: 'ok' }] })) === undefined);
  check("our own isError results (not the SDK's) are undefined",
    parseValidationFailure(sseBody({ isError: true, content: [{ type: 'text', text: '❌ Access denied: rule blocks this label' }] })) === undefined);
  check('a non-JSON issue tail is counted but not decoded',
    (() => { const f = parseValidationFailure(sseBody({ isError: true, content: [{ type: 'text', text: 'MCP error -32602: Input validation error: Invalid arguments for tool gmail_read: Required' }] })); return f?.kind === 'invalid_arguments' && f.issues_parsed === false && f.issue_count === 0; })());
  check('garbage bodies are undefined, never a throw', parseValidationFailure('data: {nope') === undefined && parseValidationFailure('') === undefined);
  check('multiple SSE frames: the error frame is found after a notification frame',
    parseValidationFailure(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n${sseBody(idNotMessageId)}`)?.tool === 'gmail_read');

  console.log('parseRpcEnvelope: argument keys');
  {
    const e = parseRpcEnvelope(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gmail_read', arguments: { id: 'secret-id', account: 'a@b.c' } } }));
    check('captures the keys the agent sent', JSON.stringify(e.argumentKeys) === '["id","account"]', e);
    check('never the values', !JSON.stringify(e).includes('secret-id') && !JSON.stringify(e).includes('a@b.c'));
  }
  check('no arguments → no keys', parseRpcEnvelope(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_accounts' } })).argumentKeys === undefined);
  check('array arguments → no keys', parseRpcEnvelope(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: [1] } })).argumentKeys === undefined);
  check('key list is capped at 20', parseRpcEnvelope(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])) } })).argumentKeys?.length === 20);

  console.log('route wiring (structural)');
  const route = readFileSync(join(__dirname, '..', 'src', 'app', 'api', 'mcp', 'route.ts'), 'utf8');
  const tee = route.slice(route.indexOf('const tee = res.clone();'), route.indexOf('const tee = res.clone();') + 1500);
  check('the tee decodes with parseValidationFailure(body)', /parseValidationFailure\(body\)/.test(tee));
  check('the tee spreads validationFailureProps with the envelope argument keys', /\.\.\.validationFailureProps\(failure, envelope\?\.argumentKeys\)/.test(tee));
  check('the truncating regex is gone', !/MCP error -32602: \(Input validation error\|Tool/.test(route));
  check('both helpers are imported from @/lib/mcpClientSignals',
    /import \{[^}]*parseValidationFailure[^}]*validationFailureProps[^}]*\} from '@\/lib\/mcpClientSignals'/.test(route));

  if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
  console.log('\nall validation-failure-capture checks passed');
})().catch(e => { console.error(e); process.exit(1); });
