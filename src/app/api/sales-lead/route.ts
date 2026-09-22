import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { parseSalesLead, emailSalesLead } from '@/lib/salesLead';

/**
 * POST /api/sales-lead — the /pricing Contact-sales form.
 *
 * Public (no session needed; a signed-in submitter's Clerk id is attached
 * when present). Validates, drops honeypot hits with a quiet 200, then
 * emails the submitter with the sales inbox in copy (`src/lib/salesLead.ts`).
 * The lead itself is already in PostHog from the client; this route only
 * adds the email and reports whether it went out, so the dialog can say so.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const parsed = parseSalesLead(body);
  if (!parsed.ok) {
    if (parsed.error === 'spam') return NextResponse.json({ ok: true, emailed: false, status: 'dropped' });
    return NextResponse.json({ ok: false, error: 'invalid' }, { status: 400 });
  }

  let clerkUserId: string | null = null;
  try {
    clerkUserId = (await auth()).userId ?? null;
  } catch {
    clerkUserId = null;
  }

  const result = await emailSalesLead(parsed.lead, { clerkUserId, source: 'pricing' });
  return NextResponse.json({ ok: true, emailed: result.status === 'sent', status: result.status });
}
