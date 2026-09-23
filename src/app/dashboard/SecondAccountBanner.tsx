import { cookies } from 'next/headers';
import { captureServerEvent } from '@/lib/posthogServer';
import {
  LAST_ACCOUNT_COOKIE, PREV_ACCOUNT_COOKIE, decodeLastAccount, decodePrevAccount, priorAccountCandidate,
} from '@/lib/secondAccount';
import { accountAgeSeconds, delegationAlreadyActive, delegationTargetByClerkId } from '@/lib/delegationTargets';
import { DelegateToPanel } from './DelegateToPanel';
import { SwitchAndAttachPanel } from './SwitchAndAttachPanel';

/**
 * "You were signed in as <other account> a moment ago — is that also you?"
 *
 * Server-rendered on the dashboard pages from the second-account markers
 * middleware stamps (src/lib/secondAccount.ts). Shows only when this browser
 * held a DIFFERENT live FGAC account within the adjacency window before the
 * current one, and that account does not already have this mailbox. One
 * click delegates the current mailbox to it; "No, that's someone else"
 * retires the marker. Every lookup is best-effort: the dashboard must never
 * fail because the prompt could not be resolved.
 *
 * Why (2026-09-19 case): a person spent ten minutes cycling "+ Add account"
 * → "Got it" → "+ New profile" on account A, signed out, created account B
 * four seconds later, and repeated the same clicks on B — the explainer told
 * B to "sign in as the other account", which B already was. Nothing on B's
 * dashboard knew A had just been here. Now it does.
 */
export async function SecondAccountBanner({
  currentClerkUserId,
  currentUserId,
  currentEmail,
  accountCreatedAt,
}: {
  currentClerkUserId: string;
  /** users.id — the target of this account's delegate link (switch direction). */
  currentUserId: string;
  currentEmail: string;
  accountCreatedAt: Date;
}) {
  try {
    const jar = await cookies();
    const now = Date.now();
    const prior = priorAccountCandidate(
      decodeLastAccount(jar.get(LAST_ACCOUNT_COOKIE)?.value),
      decodePrevAccount(jar.get(PREV_ACCOUNT_COOKIE)?.value),
      currentClerkUserId,
      now,
    );
    if (!prior) return null;
    const target = await delegationTargetByClerkId(prior.clerkUserId);
    if (!target || target.clerkUserId === currentClerkUserId) return null;
    if (target.email.toLowerCase() === currentEmail.toLowerCase()) return null;
    // Direction. The NEWER account is the accidental one: when that is the
    // account signed in now, offer to attach its mailbox to the older one
    // (a delegation this account can grant right here). When the person is
    // back on the OLDER account — their primary, the one agents are
    // connected to — delegating it away is the wrong direction; offer to
    // switch to the newer account and attach it here via the delegate link.
    const direction: 'delegate' | 'switch' =
      target.createdAt.getTime() > accountCreatedAt.getTime() ? 'switch' : 'delegate';
    if (direction === 'delegate' && await delegationAlreadyActive(currentEmail, target.email)) return null;
    if (direction === 'switch' && await delegationAlreadyActive(target.email, currentEmail)) return null;

    captureServerEvent(currentClerkUserId, 'delegation_prompt_shown', {
      surface: 'dashboard_banner',
      direction,
      prior_gap_s: prior.gapS,
      since_switch_s: prior.sinceSwitchS,
      account_age_s: accountAgeSeconds(accountCreatedAt, now),
    });

    return (
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 pt-8" data-testid="second-account-banner" data-direction={direction}>
        {direction === 'delegate' ? (
          <DelegateToPanel
            targetMasked={target.maskedEmail}
            signedInEmail={currentEmail}
            surface="dashboard_banner"
            target={{ kind: 'user', userId: target.userId, priorGapS: prior.gapS }}
            prominent
            dismissible
          />
        ) : (
          <SwitchAndAttachPanel
            targetMasked={target.maskedEmail}
            currentEmail={currentEmail}
            currentUserId={currentUserId}
          />
        )}
      </div>
    );
  } catch (err) {
    console.error('[SecondAccountBanner] load failed:', err);
    return null;
  }
}
