/**
 * PostHog capture for the EDGE runtime (middleware).
 *
 * `posthogServer.ts` wraps `posthog-node` and flushes through Next's
 * `after()`, neither of which is available in middleware. Middleware is the
 * only place a signed-out `/dashboard/approve` visit can be observed (Clerk
 * redirects before any page code runs), so this is a dependency-free POST to
 * PostHog's single-event endpoint. Fire-and-forget: hand the returned promise
 * to `event.waitUntil` so the redirect is not delayed and the request is not
 * cancelled with the response. Never throws; no-ops when PostHog is not
 * configured (CI), exactly like the server helper.
 */
export function captureEdgeEvent(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  if (!key || !host) return Promise.resolve();
  const body = JSON.stringify({
    api_key: key,
    event,
    distinct_id: distinctId,
    timestamp: new Date().toISOString(),
    properties: {
      environment: process.env.VERCEL_ENV ?? 'development',
      $lib: 'fgac-edge',
      ...properties,
    },
  });
  return fetch(`${host.trim().replace(/\/+$/, '')}/i/v0/e/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
    .then(() => undefined)
    .catch(err => {
      console.warn('[posthogEdge] capture failed:', err instanceof Error ? err.message : err);
    });
}
