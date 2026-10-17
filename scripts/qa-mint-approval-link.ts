/**
 * Mint a deterministic approval link for a QA account — the capability 14 A5
 * / A19 harness ("another user's session cannot approve" and the wrong-account
 * card's one-click delegation), without needing an MCP bearer token first.
 *
 *   npm run qa:mint-link -- --email <owner email> [--action sheets_expose]
 *                           [--file <spreadsheet/document id>] [--base http://localhost:3000]
 *                           [--profile <profile slug>]
 *
 * `--profile` signs for that profile instead of the default one (capability
 * 14 A21: "Back to dashboard" must return to the profile the approval changed).
 *
 * Read-only against the branch database (owner row + their live Default
 * Profile, else newest live key) and signs with THIS checkout's
 * CLERK_SECRET_KEY, so the URL is byte-identical to what the running dev
 * server would mint for the same request (approvalLinks.ts). Nothing is
 * written: no ledger row, no rule, no event — opening the link is what the
 * test measures. Refuses to run against production (connectionSafety).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { ApprovalAction } from '../src/lib/approvalLinks';

type Args = { email?: string; action: string; file: string; base: string; profile?: string };

function parseArgs(argv: string[]): Args {
  const out: Args = { action: 'sheets_expose', file: '1QaSecondAccountFixtureSheetIdxxxxxxxxxxxx', base: process.env.NEXT_PUBLIC_APP_URL?.trim() || 'http://localhost:3000' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--email') out.email = next()?.toLowerCase();
    else if (a === '--action') out.action = next() ?? out.action;
    else if (a === '--file') out.file = next() ?? out.file;
    else if (a === '--base') out.base = next() ?? out.base;
    else if (a === '--profile') out.profile = next();
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) {
    console.error('usage: npm run qa:mint-link -- --email <owner email> [--action sheets_expose|sheets_write|docs_expose|docs_write|slides_expose|slides_write|send_all] [--file <id>] [--base <origin>] [--profile <slug>]');
    process.exit(2);
  }
  const { db } = await import('../src/db');
  const { users, proxyKeys } = await import('../src/db/schema');
  const { mintApprovalLink } = await import('../src/lib/approvalLinks');
  const { slugifyProfileLabel } = await import('../src/lib/profileSlugs');

  const owner = await db.select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.email, args.email), isNull(users.deletedAt)))
    .orderBy(desc(users.createdAt))
    .limit(1).then(r => r[0]);
  if (!owner) { console.error(`no live users row for ${args.email} on this branch`); process.exit(1); }

  const keys = await db.select({ id: proxyKeys.id, label: proxyKeys.label, isDefault: proxyKeys.isDefault })
    .from(proxyKeys)
    .where(and(eq(proxyKeys.userId, owner.id), isNull(proxyKeys.revokedAt)))
    .orderBy(desc(proxyKeys.isDefault), desc(proxyKeys.createdAt));
  const key = args.profile ? keys.find(k => slugifyProfileLabel(k.label) === args.profile) : keys[0];
  if (!key) {
    console.error(args.profile
      ? `no live profile with slug ${args.profile} for ${args.email} (have: ${keys.map(k => slugifyProfileLabel(k.label)).join(', ') || 'none'})`
      : `no live proxy key for ${args.email}`);
    process.exit(1);
  }

  let action: ApprovalAction;
  switch (args.action) {
    case 'send_all': action = { action: 'send_all' }; break;
    case 'sheets_expose': action = { action: 'sheets_expose', spreadsheetId: args.file, resourceName: 'QA second-account fixture' }; break;
    case 'sheets_write': action = { action: 'sheets_write', spreadsheetId: args.file, resourceName: 'QA second-account fixture' }; break;
    case 'docs_expose': action = { action: 'docs_expose', documentId: args.file }; break;
    case 'docs_write': action = { action: 'docs_write', documentId: args.file }; break;
    case 'slides_expose': action = { action: 'slides_expose', presentationId: args.file }; break;
    case 'slides_write': action = { action: 'slides_write', presentationId: args.file }; break;
    default: console.error(`unsupported action ${args.action}`); process.exit(2);
  }

  const link = await mintApprovalLink(args.base, owner.id, key.id, action);
  console.log(JSON.stringify({ owner: owner.email, owner_id: owner.id, profile: key.label, profile_slug: slugifyProfileLabel(key.label), proxy_key_id: key.id, action: action.action, url: link.url, request_id: link.requestId }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
