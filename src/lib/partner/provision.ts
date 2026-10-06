/**
 * Consent-time provisioning: everything the user assembles by hand for an MCP
 * agent today, executed as one transaction when they click Approve on the
 * /oauth/authorize interstitial.
 *
 *  1. Proxy key labeled with the partner name
 *  2. key_email_access for the selected mailboxes (delegation-backed for
 *     non-own addresses — same invariant as createProxyKey)
 *  3. COPIES of the manifest's rule templates bound to that key (copies, not
 *     references: a later manifest edit must never widen an existing grant)
 *  4. agent_connections row approved + pinned to the consented manifestVersion
 *  5. (post-transaction) notification subscription + watch arm, if requested
 */
import crypto from 'crypto';
import { db } from '@/db';
import { findActiveDelegationOwner } from '@/db/delegationOwner';
import {
  proxyKeys, keyEmailAccess, accessRules, keyRuleAssignments,
  agentConnections,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import type { PartnerManifest } from './manifest';
import { ensureSubscription } from '@/lib/notifications/subscriptions';

interface PartnerAppRow {
  id: string;
  clientId: string;
  name: string;
  manifestVersion: number;
  webhookUrl: string | null;
}

interface ProvisionInput {
  user: { id: string; email: string };
  partner: PartnerAppRow;
  manifest: PartnerManifest;
  selectedEmails: string[];
}

export interface ProvisionOutput {
  connectionId: string;
  proxyKeyId: string;
}

export async function provisionPartnerConnection(input: ProvisionInput): Promise<ProvisionOutput> {
  const { user, partner, manifest, selectedEmails } = input;
  if (selectedEmails.length === 0) throw new Error('No mailbox selected');

  // Resolve delegation backing BEFORE the transaction (reads only).
  const emailBindings: Array<{ email: string; delegationId: string | null }> = [];
  for (const email of selectedEmails) {
    if (email.toLowerCase() === user.email.toLowerCase()) {
      emailBindings.push({ email, delegationId: null });
      continue;
    }
    // An address can have several users rows — start from the delegation.
    const delegated = await findActiveDelegationOwner(email, user.id);
    if (!delegated) throw new Error(`No active delegation grants you access to ${email}`);
    emailBindings.push({ email, delegationId: delegated.delegation.id });
  }

  // The neon-http driver has no transaction support, so provisioning runs as
  // ordered inserts with explicit compensation: if any later step fails, the
  // key is deleted (cascading away email access + rule assignments) and the
  // rule copies are removed — never leaving a partially-granted key behind.
  // Order matters: the connection upsert is LAST, so approval only ever points
  // at a fully-assembled key.
  const [key] = await db.insert(proxyKeys).values({
    userId: user.id,
    key: `sk_proxy_${crypto.randomUUID().replace(/-/g, '')}`,
    label: partner.name,
  }).returning();

  const createdRuleIds: string[] = [];
  let output: ProvisionOutput;
  try {
    for (const binding of emailBindings) {
      await db.insert(keyEmailAccess).values({
        proxyKeyId: key.id,
        delegationId: binding.delegationId,
        targetEmail: binding.email,
      });
    }

    for (const template of manifest.rule_templates ?? []) {
      const [rule] = await db.insert(accessRules).values({
        userId: user.id,
        ruleName: `${partner.name}: ${template.ruleName}`,
        service: template.service,
        actionType: template.actionType,
        regexPattern: template.regexPattern ?? null,
      }).returning();
      createdRuleIds.push(rule.id);
      // Binding the copy to the key keeps it scoped — never global.
      await db.insert(keyRuleAssignments).values({
        proxyKeyId: key.id,
        accessRuleId: rule.id,
      });
    }

    const [connection] = await db.insert(agentConnections).values({
      userId: user.id,
      clientId: partner.clientId,
      clientName: partner.name,
      nickname: partner.name,
      proxyKeyId: key.id,
      status: 'approved',
      partnerAppId: partner.id,
      manifestVersion: partner.manifestVersion,
      approvedAt: new Date(),
    }).onConflictDoUpdate({
      target: [agentConnections.userId, agentConnections.clientId],
      set: {
        clientName: partner.name,
        proxyKeyId: key.id,
        status: 'approved',
        partnerAppId: partner.id,
        manifestVersion: partner.manifestVersion,
        approvedAt: new Date(),
      },
    }).returning();

    output = { connectionId: connection.id, proxyKeyId: key.id };
  } catch (err) {
    try {
      await db.delete(proxyKeys).where(eq(proxyKeys.id, key.id));
      if (createdRuleIds.length > 0) {
        const { inArray } = await import('drizzle-orm');
        await db.delete(accessRules).where(inArray(accessRules.id, createdRuleIds));
      }
    } catch (cleanupErr) {
      console.error('[Provision] Compensation cleanup failed:', cleanupErr);
    }
    throw err;
  }

  // Outside the transaction: watch arming talks to Gmail and must not be able
  // to roll back a completed consent. Failure leaves watchExpiresAt NULL for
  // the renewal cron to retry.
  if (manifest.notifications?.trigger === 'new_email' && partner.webhookUrl) {
    for (const binding of emailBindings) {
      await ensureSubscription(output.connectionId, binding.email);
    }
  }

  return output;
}
