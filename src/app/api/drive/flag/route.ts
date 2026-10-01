import { NextResponse } from 'next/server';
import { currentUser } from '@clerk/nextjs/server';
import { driveTreeFlagOn } from '@/lib/featureFlags';
import { clerkPrimaryEmail } from '@/lib/clerkPrimaryEmail';

export const dynamic = 'force-dynamic';

/** Is the Drive tree feature flag on for the signed-in user? (Drives the nav's OAuth scope list.) */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ flagOn: false }, { status: 401 });
  return NextResponse.json({ flagOn: driveTreeFlagOn({ clerkUserId: user.id, email: clerkPrimaryEmail(user) }) });
}
