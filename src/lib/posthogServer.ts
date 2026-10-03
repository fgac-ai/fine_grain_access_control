import { PostHog } from 'posthog-node';
import { after } from 'next/server';

let client: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (client !== undefined) return client;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;
  client = key && host ? new PostHog(key, { host, flushAt: 1, flushInterval: 0 }) : null;
  return client;
}

/** The shared server client (null when PostHog is not configured) — feature
 * flag evaluation (src/lib/featureFlags.ts) rides the same instance. */
export function posthogClient(): PostHog | null {
  return getClient();
}

/**
 * Fire-and-forget server-side PostHog capture. Pass the Clerk user id as
 * distinctId whenever one is known — the dashboard identifies with the same id,
 * so server events merge into the same PostHog person. No-ops when PostHog is
 * not configured (e.g. CI).
 */
export function captureServerEvent(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  const ph = getClient();
  if (!ph) return;
  ph.capture({
    distinctId,
    event,
    properties: {
      environment: process.env.VERCEL_ENV ?? 'development',
      ...properties,
    },
  });
  try {
    after(() => ph.flush().catch(() => {}));
  } catch {
    // No request scope (scripts, build) — flush best-effort instead.
    void ph.flush().catch(() => {});
  }
}

/**
 * Server-side exception capture, shaped like PostHog Error Tracking's
 * `$exception` so server failures land in the same issue list as client ones.
 *
 * Deliberately sends only the error's type, message and stack plus a `where`
 * label — never interpolated user input. Rule patterns in particular are real
 * email addresses; validation failures are returned to the caller rather than
 * thrown, so they never reach this path at all.
 */
export function captureServerError(
  distinctId: string,
  where: string,
  error: unknown,
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  captureServerEvent(distinctId, '$exception', {
    $exception_list: [{
      type: err.name,
      value: err.message,
      mechanism: { handled: true, synthetic: false },
      stacktrace: { type: 'raw', frames: [] },
    }],
    $exception_type: err.name,
    $exception_message: err.message,
    $exception_source: where,
    $exception_stack_trace_raw: err.stack ?? '',
    where,
  });
}
