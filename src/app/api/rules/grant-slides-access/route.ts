import { NextRequest } from 'next/server';
import { grantFileAccessGET, grantFileAccessPOST, grantFileAccessDELETE } from '../fileAccessHandlers';

export const dynamic = 'force-dynamic';

/** /api/rules/grant-slides-access — see fileAccessHandlers.ts. */
export async function GET() {
  return grantFileAccessGET('slide');
}

export async function POST(request: NextRequest) {
  return grantFileAccessPOST('slide', request);
}

export async function DELETE(request: NextRequest) {
  return grantFileAccessDELETE('slide', request);
}
