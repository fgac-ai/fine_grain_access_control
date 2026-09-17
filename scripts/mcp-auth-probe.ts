/**
 * Synthetic auth probe for the MCP endpoint (monitoring #4 of the auth
 * optimization rollout — see docs/monitoring.md).
 *
 * Probes, against BASE_URL (default https://fgac.ai):
 *   1. POST /api/mcp with no token        → expect 401 + WWW-Authenticate
 *   2. POST /api/mcp with a garbage token → expect 401 (exercises the
 *      direct-JWT path's pinned-issuer rejection)
 *   3. GET /.well-known/oauth-protected-resource/mcp → expect 200 JSON
 *   4. (optional) PROBE_PROXY_KEY set → GET /api/proxy/gmail/v1/users/me/profile
 *      with the QA proxy key → expect 200. Validates the DB + key-auth +
 *      Google-token path. NOT the MCP OAuth path — a fully authenticated MCP
 *      synthetic needs a live Clerk OAuth client token (documented gap).
 *
 * Exit code 0 = all probes passed; 1 = at least one failed (CI alerts on this).
 * No secrets are required for probes 1–3.
 */

const BASE_URL = (process.env.PROBE_BASE_URL ?? 'https://fgac.ai').replace(/\/$/, '');
const TIMEOUT_MS = 15_000;

// Structurally valid JWT (header/payload/signature) signed by nobody, with an
// issuer we must reject. Never accepted; exercises parse + issuer pinning.
const GARBAGE_JWT = [
  Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'probe' })).toString('base64url'),
  Buffer.from(
    JSON.stringify({ iss: 'https://evil.example.com', sub: 'probe', client_id: 'auth-probe' }),
  ).toString('base64url'),
  'c2lnbmF0dXJl',
].join('.');

type ProbeResult = { name: string; ok: boolean; detail: string };

async function probe(
  name: string,
  path: string,
  init: RequestInit,
  check: (res: Response) => Promise<string | null>,
): Promise<ProbeResult> {
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const problem = await check(res);
    return problem === null
      ? { name, ok: true, detail: `${res.status}` }
      : { name, ok: false, detail: problem };
  } catch (err) {
    return { name, ok: false, detail: `request failed: ${err instanceof Error ? err.message : err}` };
  }
}

const mcpBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
// Self-identifying user-agent: the `fgac-` prefix classifies every request
// this script makes as client_class='internal' (src/lib/mcpClientSignals.ts),
// so the probe's own 401s never read as install attempts or as a 401 storm.
// Before 2026-09-10 the probe sent Node's default `node` UA and its no_token
// rows were indistinguishable from a registry crawler on the same runtime.
const PROBE_USER_AGENT = 'fgac-auth-probe/1 (+https://github.com/fgac-ai/fine_grain_access_control)';
const mcpHeaders = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'user-agent': PROBE_USER_AGENT,
};

async function main() {
  const results: ProbeResult[] = [];

  results.push(
    await probe(
      'mcp-401-no-token',
      '/api/mcp',
      { method: 'POST', headers: mcpHeaders, body: mcpBody },
      async (res) => {
        if (res.status !== 401) return `expected 401, got ${res.status}`;
        if (!res.headers.get('www-authenticate')) return '401 missing WWW-Authenticate header';
        return null;
      },
    ),
  );

  results.push(
    await probe(
      'mcp-401-garbage-token',
      '/api/mcp',
      { method: 'POST', headers: { ...mcpHeaders, authorization: `Bearer ${GARBAGE_JWT}` }, body: mcpBody },
      async (res) => (res.status === 401 ? null : `expected 401, got ${res.status}`),
    ),
  );

  results.push(
    await probe(
      'oauth-resource-metadata',
      '/.well-known/oauth-protected-resource/mcp',
      { method: 'GET', headers: { 'user-agent': PROBE_USER_AGENT } },
      async (res) => {
        if (res.status !== 200) return `expected 200, got ${res.status}`;
        const body = await res.json().catch(() => null);
        if (!body || typeof body.resource !== 'string') return 'metadata missing resource field';
        return null;
      },
    ),
  );

  const proxyKey = process.env.PROBE_PROXY_KEY;
  if (proxyKey) {
    results.push(
      await probe(
        'proxy-authenticated',
        '/api/proxy/gmail/v1/users/me/profile',
        { method: 'GET', headers: { authorization: `Bearer ${proxyKey}`, 'user-agent': PROBE_USER_AGENT } },
        async (res) => (res.status === 200 ? null : `expected 200, got ${res.status}`),
      ),
    );
  }

  let failed = false;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
    if (!r.ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

main();
