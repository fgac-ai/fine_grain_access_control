/**
 * Unit tests for deterministic signed approval links (src/lib/approvalLinks.ts).
 * Run: npx tsx scripts/test-approval-links.ts  (part of `npm run mcp:lint`)
 *
 * These are the unit-level twins of QA capability 14's A5 (wrong user), A7
 * (tampering), A9 (well-formed URL), A10 (action matches), A12 (determinism)
 * and A13 (no expiry).
 */
process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY || 'sk_test_unit_only_signing_seed';

import {
  mintApprovalLink, mintApprovalUrl, verifyApprovalParams, describeApproval,
  approvalRequestId, approvalTargetHash, APPROVAL_ACTIONS, actionTarget,
  type ApprovalAction, type ApprovalSearchParams,
} from '../src/lib/approvalLinks';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

/** Parse a minted URL back into the params the approve page would read. */
function paramsOf(url: string): ApprovalSearchParams {
  const q = new URL(url).searchParams;
  return { a: q.get('a') ?? undefined, k: q.get('k') ?? undefined, r: q.get('r') ?? undefined, s: q.get('s') ?? undefined };
}

const BASE = 'https://fgac.ai';
const SEND: ApprovalAction = { action: 'send_whitelist', recipient: 'a@b.com' };

async function main() {
  // ── A12: determinism ─────────────────────────────────────────────────────
  const first = await mintApprovalLink(BASE, 'user-1', 'key-1', SEND);
  const second = await mintApprovalLink(BASE, 'user-1', 'key-1', SEND);
  const third = await mintApprovalLink(BASE, 'user-1', 'key-1', { action: 'send_whitelist', recipient: 'a@b.com' });
  check('same request mints a byte-identical url', first.url === second.url && second.url === third.url);
  check('same request mints a stable request_id', first.requestId === second.requestId);
  check('different target mints a different url',
    (await mintApprovalLink(BASE, 'user-1', 'key-1', { action: 'send_whitelist', recipient: 'other@b.com' })).url !== first.url);
  check('different key mints a different url',
    (await mintApprovalLink(BASE, 'user-1', 'key-2', SEND)).url !== first.url);
  check('different user mints a different url',
    (await mintApprovalLink(BASE, 'user-2', 'key-1', SEND)).url !== first.url);

  // ── Round-trip: every action recovers its target ─────────────────────────
  const samples: ApprovalAction[] = [
    { action: 'send_whitelist', recipient: 'a@b.com' },
    { action: 'send_all' },
    { action: 'sheets_expose', spreadsheetId: 'ss-1' },
    { action: 'sheets_write', spreadsheetId: 'ss-2' },
    { action: 'docs_expose', documentId: 'doc-1' },
    { action: 'docs_write', documentId: 'doc-2' },
    { action: 'slides_expose', presentationId: 'pres-1' },
    { action: 'slides_write', presentationId: 'pres-2' },
  ];
  check('sample covers every declared action', samples.length === APPROVAL_ACTIONS.length);
  for (const a of samples) {
    const { url } = await mintApprovalLink(BASE, 'u', 'k', a);
    const v = await verifyApprovalParams('u', paramsOf(url));
    if (!v.ok) { check(`${a.action} verifies`, false); continue; }
    // A10: the action claim must survive exactly — a write denial minting a
    // read-level grant is the 2026-08-15 approve→retry→fail regression.
    check(`${a.action} round-trips its action`, v.payload.action === a.action);
    const target = actionTarget(a);
    const recovered = v.payload.recipient ?? v.payload.spreadsheetId ?? v.payload.documentId ?? v.payload.presentationId ?? '';
    check(`${a.action} round-trips its target`, recovered === target);
    check(`${a.action} describes without throwing`, describeApproval(v.payload).length > 0);
  }

  // ── A5: a link is only valid for the user it was authored for ────────────
  const forUser1 = paramsOf(first.url);
  check('owner verifies', (await verifyApprovalParams('user-1', forUser1)).ok);
  check('another user is rejected', !(await verifyApprovalParams('user-2', forUser1)).ok);
  check('user id never appears in the url', !first.url.includes('user-1'));

  // ── A5 wrong-account detection (2026-08-30) ──────────────────────────────
  // The approve page distinguishes "wrong signed-in user" from "forged" by
  // resolving the owner from the cleartext `k` param and recomputing the HMAC
  // against the RESOLVED owner. That recovery is exactly this property: a
  // genuine link fails for the wrong user but re-verifies for the owner,
  // while a tampered link verifies against NOBODY — so tampering can never
  // unlock the wrong-account card or its masked owner email (A7 preserved).
  const asOwner = await verifyApprovalParams('user-1', forUser1);
  check('genuine link recovers against the resolved owner', asOwner.ok);
  check('recovered payload carries the real request_id',
    asOwner.ok && asOwner.payload.requestId === first.requestId);
  check('tampered target does not recover against the owner',
    !(await verifyApprovalParams('user-1', { ...forUser1, r: 'attacker@evil.com' })).ok);
  check('tampered signature does not recover against the owner',
    !(await verifyApprovalParams('user-1', { ...forUser1, s: (forUser1.s ?? '').slice(0, -1) + 'X' })).ok);

  // ── maskEmail: what the wrong-account card is allowed to show ────────────
  const { maskEmail } = await import('../src/lib/maskEmail');
  check('maskEmail keeps first/last local char + domain',
    maskEmail('kenyesh@gmail.com') === 'k•••••h@gmail.com');
  check('maskEmail hides the middle of the local part',
    !maskEmail('somebody@example.com').includes('omebod'));
  check('maskEmail caps mask length for long locals',
    maskEmail('a-very-long-local-part@example.com') === 'a••••••t@example.com');
  check('maskEmail tolerates short locals', maskEmail('ab@x.io') === 'a•••@x.io');
  check('maskEmail tolerates non-emails', maskEmail('not-an-email') === '•••');

  // ── A7: tampering ────────────────────────────────────────────────────────
  check('tampered signature rejected',
    !(await verifyApprovalParams('user-1', { ...forUser1, s: (forUser1.s ?? '').slice(0, -1) + 'X' })).ok);
  check('tampered target rejected',
    !(await verifyApprovalParams('user-1', { ...forUser1, r: 'attacker@evil.com' })).ok);
  check('tampered key rejected',
    !(await verifyApprovalParams('user-1', { ...forUser1, k: 'key-9' })).ok);
  check('escalated action rejected',
    !(await verifyApprovalParams('user-1', { ...forUser1, a: 'send_all' })).ok);
  check('unknown action rejected',
    !(await verifyApprovalParams('user-1', { ...forUser1, a: 'delete_everything' })).ok);
  check('missing signature rejected',
    !(await verifyApprovalParams('user-1', { ...forUser1, s: undefined })).ok);

  // ── Analytics ids must not leak the signature ────────────────────────────
  const rid = await approvalRequestId('user-1', 'key-1', 'send_whitelist', 'a@b.com');
  check('request_id is not the signature', rid !== forUser1.s);
  check('request_id is not a prefix of the signature', !(forUser1.s ?? '').startsWith(rid));
  check('request_id is stable', rid === await approvalRequestId('user-1', 'key-1', 'send_whitelist', 'a@b.com'));

  const th = await approvalTargetHash('a@b.com');
  check('target_hash hides the raw target', !!th && !th.includes('a@b.com') && th !== 'a@b.com');
  check('target_hash is stable', th === await approvalTargetHash('a@b.com'));
  check('target_hash differs per target', th !== await approvalTargetHash('other@b.com'));
  check('empty target has no hash', (await approvalTargetHash('')) === undefined);

  // ── A13: nothing time-dependent ──────────────────────────────────────────
  // There is no expiry to test directly; assert instead that no time-varying
  // component exists — a link minted "long ago" is byte-identical to one
  // minted now, so it cannot go stale.
  check('no exp/iat/jti anywhere in the url', !/exp|iat|jti/.test(first.url));

  // ── A9: well-formed, single-line URLs ────────────────────────────────────
  check('url targets /dashboard/approve', first.url.startsWith('https://fgac.ai/dashboard/approve?'));

  // Regression (tester finding 2026-08-15): env base URLs have shipped with a
  // trailing newline, producing "https://fgac.ai\n/dashboard/..." — unclickable.
  for (const dirty of ['https://fgac.ai\n', 'https://fgac.ai \n', 'https://fgac.ai/', '  https://fgac.ai  ']) {
    const u = await mintApprovalUrl(dirty, 'u', 'k', SEND);
    check(`no whitespace in url minted from ${JSON.stringify(dirty)}`, !/\s/.test(u));
    const parsed = new URL(u);
    check(`url parses to fgac.ai/dashboard/approve from ${JSON.stringify(dirty)}`,
      parsed.host === 'fgac.ai' && parsed.pathname === '/dashboard/approve'
      && !!parsed.searchParams.get('a') && !!parsed.searchParams.get('s'));
  }

  if (failures > 0) { console.error(`\n${failures} approval-link test(s) FAILED`); process.exit(1); }
  console.log('\nAll approval-link tests passed.');
}
main();
