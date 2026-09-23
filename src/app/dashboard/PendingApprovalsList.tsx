"use client";

import { useState, useTransition } from "react";
import { usePostHog } from "posthog-js/react";
import { dismissPendingApproval } from "./actions";

export interface PendingApprovalItem {
  requestId: string;
  action: string;
  /** describeApproval() of the verified payload -- what approving grants. */
  description: string;
  profileLabel: string | null;
  /** The approve page for this request, as minted, with `src=banner`. */
  path: string;
  /** ISO timestamp of the latest mint (when the agent last asked). */
  lastMintedAt: string;
  mintCount: number;
}

/**
 * Client half of the pending-approvals banner: the list, its "Open" links and
 * "Dismiss" buttons, and the two client-side events. "Open" is a plain
 * anchor -- a full navigation into the approve page, exactly as the link the
 * agent showed would have been. "Dismiss" calls the server action, which
 * stamps dismissed_at (hidden until the agent mints the link again) and
 * revalidates the dashboard; the row is hidden optimistically meanwhile.
 */
export function PendingApprovalsList({ items }: { items: PendingApprovalItem[] }) {
  const posthog = usePostHog();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [, startTransition] = useTransition();
  const visible = items.filter(i => !hidden.has(i.requestId));
  if (visible.length === 0) return null;

  const dismiss = (item: PendingApprovalItem) => {
    setHidden(prev => new Set(prev).add(item.requestId));
    startTransition(async () => {
      try {
        await dismissPendingApproval(item.requestId);
      } catch (err) {
        console.error("[PendingApprovalsList] dismiss failed:", err);
      }
    });
  };

  return (
    <div
      className="bg-amber-50 border-l-4 border-amber-400 p-4 rounded-r-md shadow-sm mb-6"
      data-testid="pending-approvals-banner"
    >
      <div className="flex items-start">
        <div className="flex-shrink-0">
          <svg className="h-5 w-5 text-amber-400" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v4.5c0 .414.336.75.75.75h3a.75.75 0 000-1.5h-2.25v-3.75z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="ml-3 flex-1 min-w-0">
          <h3 className="text-sm font-medium text-amber-800">
            {visible.length === 1
              ? "An agent is waiting for your approval"
              : `${visible.length} agent requests are waiting for your approval`}
          </h3>
          <p className="mt-1 text-sm text-amber-700">
            Each one was denied until you approve it. Approving takes one click and the agent can retry right away.
          </p>
          <ul className="mt-3 divide-y divide-amber-200">
            {visible.map(item => (
              <li
                key={item.requestId}
                className="py-2 flex flex-col sm:flex-row sm:items-center gap-2"
                data-testid="pending-approval-item"
                data-action={item.action}
              >
                <div className="flex-1 min-w-0 text-sm text-amber-900 [overflow-wrap:anywhere]">
                  <span>{item.description}</span>
                  <span className="block sm:inline text-amber-700 text-xs sm:ml-2">
                    {item.profileLabel ? `${item.profileLabel} · ` : ""}
                    {describeWhen(item.lastMintedAt)}
                    {item.mintCount > 1 ? ` · asked ${item.mintCount} times` : ""}
                  </span>
                </div>
                <div className="flex-shrink-0 flex items-center gap-2">
                  <a
                    href={item.path}
                    onClick={() => posthog?.capture("approval_banner_clicked", {
                      request_id: item.requestId,
                      action: item.action,
                      pending_count: visible.length,
                    })}
                    className="inline-flex items-center rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 transition-colors"
                    data-testid="pending-approval-open"
                  >
                    Review
                  </a>
                  <button
                    type="button"
                    onClick={() => dismiss(item)}
                    className="inline-flex items-center rounded border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100 transition-colors"
                    data-testid="pending-approval-dismiss"
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** "just now" / "12 minutes ago" / "3 hours ago" / "2 days ago". */
function describeWhen(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
