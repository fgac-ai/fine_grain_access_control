/**
 * Regression test for the "DELETE is never available" product guarantee.
 * Run: npx tsx scripts/test-raw-method-guard.ts  (part of `npm run mcp:lint`)
 *
 * Until 2026-09-16 the guarantee (google_api_modify description +
 * get_my_permissions.defaults.deletion) rested on the tool's `method` zod enum
 * alone, and Google would not backstop a slip: the drive.file grant accepts
 * `files.delete` (permanent, bypasses trash) on every file the app created or
 * the user picked, and `files/trash` (emptyTrash) is DELETE-only. The method
 * set now lives once in googleApiPolicy.ts (RAW_MODIFY_METHODS) and four layers
 * derive from it; this test pins each one so a future edit to any single layer
 * fails CI instead of silently opening deletion:
 *   1. the constant itself excludes DELETE;
 *   2. the REGISTERED tool schema — built the way route.ts builds it and served
 *      by the real MCP SDK server to a real in-memory client — rejects DELETE
 *      before the handler runs (the handler is a probe that records if it ran);
 *   3. the tool catalog (`freeformMethods`, what mcp-tool-lint checks) equals
 *      the constant;
 *   4. the classifier and the executor's defensive check refuse DELETE
 *      independently of the schema (`isForwardableGoogleMethod` /
 *      `methodDenial`, which the executor calls).
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  RAW_MODIFY_METHODS, RAW_READ_METHODS, isForwardableGoogleMethod, methodDenial, classifyGoogleApiCall,
} from '../src/app/api/mcp/googleApiPolicy';
import { TOOL_DEFS } from '../src/app/api/mcp/toolDefs';

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got)}`}`); }
  else console.log(`  ✓ ${name}`);
}
function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map(c => c.text ?? '').join('\n');
}

async function main() {
  console.log('raw-method-guard:');

  // 1. The single source of truth.
  check('RAW_MODIFY_METHODS excludes DELETE', !(RAW_MODIFY_METHODS as readonly string[]).includes('DELETE'));
  check('RAW_READ_METHODS is exactly GET', RAW_READ_METHODS.length === 1 && RAW_READ_METHODS[0] === 'GET');
  check('modify set is exactly POST/PUT/PATCH (a widening is a deliberate, reviewed change)',
    [...RAW_MODIFY_METHODS].sort().join(',') === 'PATCH,POST,PUT', RAW_MODIFY_METHODS);

  // 2. The registered schema, through the real SDK.
  const server = new McpServer({ name: 'test', version: '0' });
  const forwarded: string[] = [];
  server.registerTool(
    TOOL_DEFS.google_api_modify.name,
    {
      description: 'probe',
      inputSchema: {
        path: z.string(),
        method: z.enum(RAW_MODIFY_METHODS).optional(),
        body: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
      },
    },
    async ({ method = 'POST' }) => {
      forwarded.push(method);
      return { content: [{ type: 'text' as const, text: `FORWARDED ${method}` }] };
    },
  );
  const client = new Client({ name: 'test-client', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = (method?: string) => client.callTool({
    name: TOOL_DEFS.google_api_modify.name,
    arguments: { path: 'drive/v3/files/1BxiM2doc-ID_x', ...(method ? { method } : {}) },
  });

  for (const bad of ['DELETE', 'delete', 'Delete', 'HEAD', 'OPTIONS', 'GET']) {
    const res = await call(bad);
    const text = textOf(res);
    check(`schema rejects method '${bad}' before the handler runs`,
      (res as { isError?: boolean }).isError === true && !text.includes('FORWARDED'), text.slice(0, 120));
  }
  check('no rejected method reached the handler', forwarded.length === 0, forwarded);
  for (const good of RAW_MODIFY_METHODS) {
    const res = await call(good);
    check(`schema accepts '${good}'`, textOf(res) === `FORWARDED ${good}`, textOf(res));
  }
  const dflt = await call();
  check('omitted method defaults to POST', textOf(dflt) === 'FORWARDED POST');
  await client.close();
  await server.close();

  // 3. The catalog the directory reads (mcp-tool-lint checks it for DELETE).
  check('google_api_modify.freeformMethods === RAW_MODIFY_METHODS',
    TOOL_DEFS.google_api_modify.freeformMethods === RAW_MODIFY_METHODS);
  check('google_api_get.freeformMethods === RAW_READ_METHODS',
    TOOL_DEFS.google_api_get.freeformMethods === RAW_READ_METHODS);
  check('google_api_modify description still states DELETE is never available',
    /DELETE is never available/.test(TOOL_DEFS.google_api_modify.description));

  // 4. Classifier + executor check, independent of the schema.
  for (const bad of ['DELETE', 'delete', 'HEAD', 'OPTIONS', 'PROPFIND', '']) {
    check(`isForwardableGoogleMethod('${bad}') is false`, !isForwardableGoogleMethod(bad));
    const cls = classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x', bad);
    check(`classifier denies '${bad}' with raw_api_method_unsupported`,
      cls.kind === 'denied' && cls.code === 'raw_api_method_unsupported', cls);
  }
  for (const good of [...RAW_READ_METHODS, ...RAW_MODIFY_METHODS]) {
    check(`isForwardableGoogleMethod('${good}') is true`, isForwardableGoogleMethod(good));
  }
  const d = methodDenial('DELETE');
  check('DELETE denial is a 🚫 refusal (denied_by_policy outcome), names the guarantee and the reversible alternative',
    d.reason.startsWith('🚫') && /never available/.test(d.reason) && /trash/i.test(d.reason), d.reason);
  check('emptyTrash (DELETE drive/v3/files/trash) is denied before any path classification',
    classifyGoogleApiCall('drive/v3/files/trash', 'DELETE').kind === 'denied');
  check('permanent Gmail delete (DELETE …/messages/{id}) is denied',
    classifyGoogleApiCall('gmail/v1/users/me/messages/abc', 'DELETE').kind === 'denied');

  if (failures > 0) {
    console.error(`\n✗ raw-method-guard: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\n✓ raw-method-guard: all checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
