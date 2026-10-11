import { and, eq, isNull } from 'drizzle-orm';
import * as jose from 'jose';
import { db } from '@/db';
import { proxyKeys, temporaryApiKeys } from '@/db/schema';

/**
 * Rotate a profile's secret IN PLACE: same `proxy_keys` row, new `key` value
 * (and a new RSA keypair when the profile has one).
 *
 * Rolling used to insert a new row, copy key_email_access and
 * key_rule_assignments onto it and revoke the old one. Everything else keyed
 * on `proxy_keys.id` stayed on the dead row — agent_connections (so every MCP
 * connection on the profile went `profile_revoked` and was refused),
 * temporary keys, resumable uploads, approval requests, account refusals —
 * and the copy dropped is_default, drive_default and public_key. Keeping the
 * id makes every reference follow by construction, including tables added
 * later: there is no list of "tables to re-point" to keep in sync.
 *
 * What a rotation does cut off, deliberately (it is the "my key leaked"
 * control): the old `sk_proxy_…` value and the credentials JSON built on it
 * (its JWT issuer is `<old key>@fgac.ai`), and every live temporary key minted
 * under the profile — a leaked standing key can mint those through the REST
 * proxy. MCP connections authenticate with their own OAuth bearer, not the
 * profile secret, so they keep working. Resumable upload sessions stay bound
 * to the profile id; their chunks must still authenticate as the profile.
 *
 * Both writes run in one `db.batch` (a single transaction on neon-http).
 * Returns null when the key is not the user's, is revoked, or vanished.
 */
export interface RotatedKey {
  id: string;
  proxyKey: string;
  /** PKCS8 PEM, only when the profile had a public key (service-account JSON). */
  privateKey: string | null;
  tempKeysRevoked: number;
}

export function newProxyKeyString(): string {
  return `sk_proxy_${crypto.randomUUID().replace(/-/g, '')}`;
}

export async function rotateProfileKey(userId: string, keyId: string, now: Date = new Date()): Promise<RotatedKey | null> {
  const live = and(eq(proxyKeys.id, keyId), eq(proxyKeys.userId, userId), isNull(proxyKeys.revokedAt));
  const existing = await db.select({ id: proxyKeys.id, publicKey: proxyKeys.publicKey })
    .from(proxyKeys).where(live).limit(1).then(res => res[0]);
  if (!existing) return null;

  const proxyKey = newProxyKeyString();
  let publicKeyPem: string | null = null;
  let privateKey: string | null = null;
  if (existing.publicKey) {
    const pair = await jose.generateKeyPair('RS256', { extractable: true });
    publicKeyPem = await jose.exportSPKI(pair.publicKey);
    privateKey = await jose.exportPKCS8(pair.privateKey);
  }

  const [rotated, revokedTemp] = await db.batch([
    db.update(proxyKeys)
      .set(publicKeyPem ? { key: proxyKey, publicKey: publicKeyPem } : { key: proxyKey })
      .where(live)
      .returning({ id: proxyKeys.id }),
    db.update(temporaryApiKeys)
      .set({ revokedAt: now })
      .where(and(eq(temporaryApiKeys.parentKeyId, keyId), eq(temporaryApiKeys.userId, userId), isNull(temporaryApiKeys.revokedAt)))
      .returning({ id: temporaryApiKeys.id }),
  ]);
  // Revoked between the read and the batch: the temp keys it revoked were
  // already dead (parent-revoked), so there is nothing to undo.
  if (rotated.length === 0) return null;
  return { id: existing.id, proxyKey, privateKey, tempKeysRevoked: revokedTemp.length };
}
