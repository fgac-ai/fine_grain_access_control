/**
 * Server helpers for the dashboard's Drive tree card (feature-flagged):
 * who may call the Drive routes, and the Drive listings they return.
 *
 * Every route here is reachable only when BOTH gates hold — the caller's
 * feature flag and a live token carrying the full `drive` scope — because
 * listing a user's whole Drive is exactly what the narrower scope forbids.
 * The listings use the signed-in user's own Google token through Clerk.
 */
import { NextResponse } from 'next/server';
import { currentUser, clerkClient } from '@clerk/nextjs/server';
import { driveTreeFlagOn } from '@/lib/featureFlags';
import { liveTokenScopes, DRIVE_FULL_SCOPE } from '@/lib/googleTokenScopes';
import { clerkPrimaryEmail } from '@/lib/clerkPrimaryEmail';
import { GOOGLE_FETCH_TIMEOUT_MS } from '@/lib/upstreamTimeouts';
import { kindForMimeType } from '@/lib/driveFileKinds';
import {
  FOLDER_MIME, SHORTCUT_MIME, SHARED_WITH_ME_ID, SHARED_DRIVES_ID, type DriveNodeKind, type LineageNode,
} from '@/lib/driveTreeAccess';
import { parseDriveFileMeta, resolveLineageFrom, type MetaFetcher, driveMetaUrl, type DriveFileMeta } from '@/lib/driveLineage';

export type DriveTreeSession = { clerkUserId: string; token: string };

/** The signed-in, flagged, full-scope user — or the response that says why not. */
export async function requireDriveTreeSession(): Promise<DriveTreeSession | NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!(await driveTreeFlagOn({ clerkUserId: user.id, email: clerkPrimaryEmail(user) }))) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const client = await clerkClient();
  let token: string | undefined;
  try {
    const res = await client.users.getUserOauthAccessToken(user.id, 'google');
    token = res.data?.[0]?.token;
  } catch (err) {
    console.error('[drive-tree] Clerk token lookup failed:', err instanceof Error ? err.message : err);
  }
  if (!token) return NextResponse.json({ error: 'google_disconnected' }, { status: 403 });
  const scopes = await liveTokenScopes(token);
  if (!scopes || !scopes.includes(DRIVE_FULL_SCOPE)) {
    return NextResponse.json({ error: 'drive_scope_missing' }, { status: 403 });
  }
  return { clerkUserId: user.id, token };
}

/** What the dashboard renders per node. */
export interface DriveTreeNode {
  id: string;
  name: string;
  kind: DriveNodeKind;
  mimeType?: string;
  /** For files: the typed kind, 'pdf' for PDFs, 'other' for everything else. */
  fileKind?: 'sheet' | 'doc' | 'slide' | 'pdf' | 'other';
  isShortcut?: boolean;
  /** Search results: root … parent, so the client knows the inheritance chain. */
  path?: LineageNode[];
}

type DriveApiResult = { ok: true; data: unknown } | { ok: false; status: number; error: string };

async function driveGet(token: string, url: string): Promise<DriveApiResult> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GOOGLE_FETCH_TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) {
      let message = `Google ${res.status}`;
      try { message = (await res.json())?.error?.message ?? message; } catch { /* keep */ }
      return { ok: false, status: res.status, error: message };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, status: 502, error: err instanceof Error ? err.message : String(err) };
  }
}

export function metaFetcherFor(token: string): MetaFetcher {
  return async (id) => {
    const r = await driveGet(token, driveMetaUrl(id));
    if (!r.ok) return { ok: false, status: r.status, error: r.error };
    const meta = parseDriveFileMeta(r.data);
    return meta ? { ok: true, meta } : { ok: false, error: 'Drive returned file metadata without an id.' };
  };
}

export function toTreeNode(meta: DriveFileMeta, kindOverride?: DriveNodeKind): DriveTreeNode {
  const isShortcut = meta.mimeType === SHORTCUT_MIME;
  const kind: DriveNodeKind = kindOverride ?? (meta.mimeType === FOLDER_MIME ? 'folder' : 'file');
  const typed = kindForMimeType(meta.mimeType);
  const fileKind = kind !== 'file' ? undefined
    : typed === 'sheet' ? 'sheet' : typed === 'doc' ? 'doc' : typed === 'slide' ? 'slide'
    : meta.mimeType === 'application/pdf' ? 'pdf' : 'other';
  return { id: meta.id, name: meta.name, kind, mimeType: meta.mimeType, fileKind, isShortcut: isShortcut || undefined };
}

const LIST_FIELDS = 'nextPageToken,files(id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails)';

function escapeQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** The three roots. My Drive's real id is resolved so settings key on the id the lineage walk reaches. */
export async function listRoots(token: string): Promise<{ roots: DriveTreeNode[] } | { error: string; status: number }> {
  const r = await driveGet(token, 'https://www.googleapis.com/drive/v3/files/root?fields=id,name');
  if (!r.ok) return { error: r.error, status: r.status };
  const root = r.data as { id: string; name?: string };
  return {
    roots: [
      { id: root.id, name: 'My Drive', kind: 'folder', mimeType: FOLDER_MIME },
      { id: SHARED_WITH_ME_ID, name: 'Shared with me', kind: 'shared_with_me' },
      { id: SHARED_DRIVES_ID, name: 'Shared drives', kind: 'shared_drives' },
    ],
  };
}

/** Children of a folder, a shared drive, or one of the pseudo-roots. */
export async function listChildren(
  token: string,
  parent: string,
  pageToken?: string | null,
): Promise<{ nodes: DriveTreeNode[]; nextPageToken: string | null } | { error: string; status: number }> {
  if (parent === SHARED_DRIVES_ID) {
    const params = new URLSearchParams({ pageSize: '100', fields: 'nextPageToken,drives(id,name)' });
    if (pageToken) params.set('pageToken', pageToken);
    const r = await driveGet(token, `https://www.googleapis.com/drive/v3/drives?${params}`);
    if (!r.ok) return { error: r.error, status: r.status };
    const data = r.data as { drives?: Array<{ id: string; name: string }>; nextPageToken?: string };
    return {
      nodes: (data.drives ?? []).map(d => ({ id: d.id, name: d.name, kind: 'shared_drive' as const, mimeType: FOLDER_MIME })),
      nextPageToken: data.nextPageToken ?? null,
    };
  }
  const q = parent === SHARED_WITH_ME_ID
    ? 'sharedWithMe = true and trashed = false'
    : `'${escapeQuery(parent)}' in parents and trashed = false`;
  const params = new URLSearchParams({
    q, pageSize: '100', fields: LIST_FIELDS, orderBy: 'folder,name',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives',
  });
  if (pageToken) params.set('pageToken', pageToken);
  const r = await driveGet(token, `https://www.googleapis.com/drive/v3/files?${params}`);
  if (!r.ok) return { error: r.error, status: r.status };
  const data = r.data as { files?: unknown[]; nextPageToken?: string };
  const nodes = (data.files ?? []).map(parseDriveFileMeta).filter((m): m is DriveFileMeta => !!m).map(m => toTreeNode(m));
  return { nodes, nextPageToken: data.nextPageToken ?? null };
}

/** Name search across the whole Drive, each hit with its path (root … parent). */
export async function searchDrive(
  session: DriveTreeSession,
  query: string,
): Promise<{ results: DriveTreeNode[] } | { error: string; status: number }> {
  const params = new URLSearchParams({
    q: `name contains '${escapeQuery(query)}' and trashed = false`,
    pageSize: '25', fields: LIST_FIELDS,
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', corpora: 'allDrives',
  });
  const r = await driveGet(session.token, `https://www.googleapis.com/drive/v3/files?${params}`);
  if (!r.ok) return { error: r.error, status: r.status };
  const data = r.data as { files?: unknown[] };
  const metas = (data.files ?? []).map(parseDriveFileMeta).filter((m): m is DriveFileMeta => !!m);
  const fetchMeta = metaFetcherFor(session.token);
  const results: DriveTreeNode[] = [];
  for (const meta of metas) {
    const node = toTreeNode(meta);
    try {
      const lineage = await resolveLineageFrom(session.clerkUserId, meta, fetchMeta);
      // lineage[0] is the file itself; the rest, reversed, is root … parent.
      node.path = lineage.nodes.slice(1).reverse();
      if (lineage.nodes[0].kind === 'shared_drive') node.kind = 'shared_drive';
    } catch {
      node.path = [];
    }
    results.push(node);
  }
  // Folders first: a setting on a folder result covers everything inside it.
  results.sort((a, b) => Number(b.kind !== 'file') - Number(a.kind !== 'file'));
  return { results };
}
