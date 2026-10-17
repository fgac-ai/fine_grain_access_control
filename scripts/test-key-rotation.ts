/**
 * Profile key rotation ("Rotate key", src/db/rotateProfileKey.ts).
 * Run: npx tsx scripts/test-key-rotation.ts  (part of `npm run mcp:lint`)
 *
 * Pins the 2026-10-10 fix: rolling a key used to insert a NEW proxy_keys row
 * and revoke the old one, stranding every agent_connections row (and temp
 * keys, uploads, approvals…) on the dead id — every MCP connection on a rolled
 * profile went profile_revoked. Rotation now keeps the row:
 *   - no proxy_keys insert, the id never changes, only key/public_key are set;
 *   - the update is scoped to the caller's own, unrevoked key;
 *   - a connection bound to the profile still resolves to a live profile;
 *   - live temporary keys under the profile are revoked in the same batch;
 *   - every schema reference to proxy_keys.id follows the row (the audit).
 * The stubbed drizzle ignores `where` for row selection, so the WHERE clauses
 * are rendered with drizzle's own dialect and checked as SQL text.
 */
process.env.neon__POSTGRES_URL = ['postgres://fixture', 'ep-test-fixture.invalid/db'].join(':fixture' + String.fromCharCode(64));

import { readFileSync } from 'fs';
import { join } from 'path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${got === undefined ? '' : ` — got: ${JSON.stringify(got).slice(0, 400)}`}`); }
  else console.log(`  ✓ ${name}`);
}

type Row = Record<string, unknown>;
const dialect = new PgDialect();
const sqlText = (w: unknown) => dialect.sqlToQuery(w as SQL).sql;

async function main() {
  const { db } = await import('../src/db');
  const schema = await import('../src/db/schema');
  const { rotateProfileKey } = await import('../src/db/rotateProfileKey');

  const OLD_KEY = 'sk_proxy_' + 'a'.repeat(32);
  let keyRow: Row = {};
  let tempKeys: Row[] = [];
  let owned = true;
  const connections: Row[] = [];
  let inserts: unknown[] = [];
  let updates: Array<{ table: unknown; set: Row; where: string }> = [];
  let batches = 0;

  function reset(opts: { publicKey?: string | null; owned?: boolean } = {}) {
    keyRow = {
      id: 'key-1', userId: 'u1', key: OLD_KEY, publicKey: opts.publicKey ?? null, label: 'Work agent',
      isDefault: true, driveDefault: 'explicit', revokedAt: null, expiresAt: null,
    };
    tempKeys = [
      { id: 't1', parentKeyId: 'key-1', userId: 'u1', revokedAt: null },
      { id: 't2', parentKeyId: 'key-1', userId: 'u1', revokedAt: new Date(0) },
    ];
    connections.length = 0;
    connections.push({ id: 'c1', userId: 'u1', status: 'approved', proxyKeyId: 'key-1' });
    inserts = []; updates = []; batches = 0;
    owned = opts.owned ?? true;
  }

  const stub = db as unknown as Record<string, unknown>;
  stub.select = () => {
    let rows: Row[] = [];
    const q = {
      from(t: unknown) {
        if (t !== schema.proxyKeys) throw new Error('rotation should only read proxy_keys');
        rows = owned && !keyRow.revokedAt ? [keyRow] : [];
        return q;
      },
      where() { return q; },
      limit(n: number) { rows = rows.slice(0, n); return q; },
      then(res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(rows).then(res, rej); },
    };
    return q;
  };
  stub.insert = (table: unknown) => { inserts.push(table); throw new Error('rotation must not insert'); };
  stub.update = (table: unknown) => ({
    set(set: Row) {
      return {
        where(w: unknown) {
          const rec = { table, set, where: sqlText(w) };
          return { returning: () => ({ __pending: rec }) };
        },
      };
    },
  });
  // db.batch = one transaction: apply each recorded update to the fixtures.
  stub.batch = async (items: Array<{ __pending: { table: unknown; set: Row; where: string } }>) => {
    batches++;
    return items.map(({ __pending: u }) => {
      updates.push(u);
      if (u.table === schema.proxyKeys) {
        if (keyRow.revokedAt) return [];
        Object.assign(keyRow, u.set);
        return [{ id: keyRow.id }];
      }
      if (u.table === schema.temporaryApiKeys) {
        const hit = tempKeys.filter(t => t.parentKeyId === 'key-1' && !t.revokedAt);
        hit.forEach(t => Object.assign(t, u.set));
        return hit.map(t => ({ id: t.id }));
      }
      throw new Error('unexpected table in rotation batch');
    });
  };

  // Mirrors connectionState(): approved + bound to a live key row = usable.
  const connectionUsable = (c: Row) =>
    c.status === 'approved' && c.proxyKeyId === keyRow.id && !keyRow.revokedAt;

  console.log('key rotation — the profile row is kept:');
  reset();
  const r = await rotateProfileKey('u1', 'key-1', new Date('2026-10-10T12:00:00Z'));
  check('rotation succeeds', r !== null);
  check('no proxy_keys (or any) insert', inserts.length === 0, inserts.length);
  check('one batch (one transaction)', batches === 1, batches);
  check('id unchanged', keyRow.id === 'key-1' && r?.id === 'key-1');
  check('new key value, standing-key prefix, differs from old', keyRow.key !== OLD_KEY && String(keyRow.key).startsWith('sk_proxy_') && r?.proxyKey === keyRow.key);
  const keyUpdate = updates.find(u => u.table === schema.proxyKeys);
  check('only key is set when the profile has no public key', JSON.stringify(Object.keys(keyUpdate?.set ?? {})) === '["key"]', keyUpdate?.set);
  check('label / is_default / drive_default / revoked_at untouched',
    keyRow.label === 'Work agent' && keyRow.isDefault === true && keyRow.driveDefault === 'explicit' && keyRow.revokedAt === null);
  check('update scoped to caller + unrevoked key',
    /"proxy_keys"\."id" = \$\d/.test(keyUpdate?.where ?? '') && /"proxy_keys"\."user_id" = \$\d/.test(keyUpdate?.where ?? '')
    && /"proxy_keys"\."revoked_at" is null/.test(keyUpdate?.where ?? ''), keyUpdate?.where);
  check('no private key returned without a service-account keypair', r?.privateKey === null);

  console.log('key rotation — connections survive:');
  check('connection bound before the rotation is still usable after it', connectionUsable(connections[0]));
  check('no agent_connections write was needed', !updates.some(u => u.table === schema.agentConnections));

  console.log('key rotation — what is cut off:');
  check('live temporary key revoked at the rotation time', (tempKeys[0].revokedAt as Date)?.toISOString() === '2026-10-10T12:00:00.000Z');
  check('already-revoked temporary key left alone', (tempKeys[1].revokedAt as Date).getTime() === 0);
  check('temp-key count reported', r?.tempKeysRevoked === 1, r?.tempKeysRevoked);
  const tempUpdate = updates.find(u => u.table === schema.temporaryApiKeys);
  check('temp-key revoke scoped to this profile + owner + live keys',
    /"temporary_api_keys"\."parent_key_id" = \$\d/.test(tempUpdate?.where ?? '') && /"temporary_api_keys"\."user_id" = \$\d/.test(tempUpdate?.where ?? '')
    && /"temporary_api_keys"\."revoked_at" is null/.test(tempUpdate?.where ?? ''), tempUpdate?.where);

  console.log('key rotation — service-account profiles get a new keypair:');
  reset({ publicKey: 'OLD-PEM' });
  const sa = await rotateProfileKey('u1', 'key-1');
  check('public key replaced', typeof keyRow.publicKey === 'string' && keyRow.publicKey !== 'OLD-PEM' && String(keyRow.publicKey).includes('BEGIN PUBLIC KEY'));
  check('matching private key returned once', !!sa?.privateKey && sa.privateKey.includes('BEGIN PRIVATE KEY'));

  console.log('key rotation — refusals:');
  reset({ owned: false });
  check("another user's key: null, no writes", (await rotateProfileKey('u2', 'key-1')) === null && batches === 0 && keyRow.key === OLD_KEY);
  reset();
  keyRow.revokedAt = new Date();
  check('revoked key: null, no writes', (await rotateProfileKey('u1', 'key-1')) === null && batches === 0 && keyRow.key === OLD_KEY);

  console.log('key rotation — reference audit:');
  const schemaSrc = readFileSync(join(__dirname, '../src/db/schema.ts'), 'utf8');
  const refs = schemaSrc.match(/references\(\(\) => proxyKeys\.id/g) ?? [];
  // Every one of these follows the row because the id never changes. If this
  // count moves, re-read rotateProfileKey's header: a new reference may need
  // cutting off on rotation (like temporary keys) rather than following.
  check('schema has the 7 audited proxy_keys.id references', refs.length === 7, refs.length);
  const rotateSrc = readFileSync(join(__dirname, '../src/db/rotateProfileKey.ts'), 'utf8');
  check('rotateProfileKey never inserts or sets an id', !/\.insert\(/.test(rotateSrc) && !/set\(\{[^}]*\bid:/.test(rotateSrc));
  const actionsSrc = readFileSync(join(__dirname, '../src/app/dashboard/actions.ts'), 'utf8');
  const rollBody = actionsSrc.slice(actionsSrc.indexOf('export async function rollProxyKey'), actionsSrc.indexOf('// ─── Access Rules'));
  check('rollProxyKey delegates to rotateProfileKey and inserts nothing', rollBody.includes('rotateProfileKey(') && !rollBody.includes('db.insert('));

  if (failures) { console.error(`\n${failures} key-rotation check(s) failed`); process.exit(1); }
  console.log('\nkey rotation: all checks passed');
}

main().catch(e => { console.error(e); process.exit(1); });
