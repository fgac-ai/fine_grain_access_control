/**
 * Drive lineage: the chain from a file up to its root, resolved through Google
 * with the user's own token and cached in-process.
 *
 * One `files.get` per uncached hop (`id,name,mimeType,parents,driveId,
 * ownedByMe,shortcutDetails`, supportsAllDrives). Where the chain ends:
 *   - My Drive: the top node has no parents and is the user's own (the root
 *     folder itself, or an orphan the user owns) — the chain ends there;
 *   - a shared drive: the node whose id equals its `driveId` is the drive's
 *     root → a `shared_drive` node, then the `shared-drives` pseudo-root;
 *   - shared with me: the top visible node is not the user's own, or an
 *     ancestor 404s (the sharer's own folders are invisible) → the
 *     `shared-with-me` pseudo-root.
 * Shortcuts resolve by their own id and place; they never grant to a target.
 *
 * The cache is keyed per token owner (Clerk id) and file id, 10 minutes, so
 * a moved file is seen within that bound; moves the agent performs through
 * FGAC can call `invalidateLineage`. Pure apart from the injected fetcher, so
 * scripts/test-drive-tree-access.ts drives it with a fake Drive.
 */
import {
  type LineageNode, FOLDER_MIME, SHARED_WITH_ME_NODE, SHARED_DRIVES_NODE, nodeKindFor,
} from './driveTreeAccess';

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  driveId?: string;
  ownedByMe?: boolean;
  shortcutTargetId?: string;
}

export type MetaResult =
  | { ok: true; meta: DriveFileMeta }
  | { ok: false; status?: number; error: string };

export type MetaFetcher = (fileId: string) => Promise<MetaResult>;

export const LINEAGE_META_FIELDS = 'id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails';
export const MAX_LINEAGE_HOPS = 25;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 5_000;

type CacheEntry = { meta: DriveFileMeta | 'missing'; at: number };
const cache = new Map<string, CacheEntry>();

export class LineageError extends Error {
  code: 'file_not_found' | 'lineage_unavailable' | 'lineage_too_deep';
  status?: number;
  constructor(code: LineageError['code'], message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Parse a Drive `files.get` body into the metadata the walk needs. */
export function parseDriveFileMeta(data: unknown): DriveFileMeta | null {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d.id !== 'string') return null;
  const shortcut = d.shortcutDetails as { targetId?: unknown } | undefined;
  return {
    id: d.id,
    name: typeof d.name === 'string' ? d.name : d.id,
    mimeType: typeof d.mimeType === 'string' ? d.mimeType : '',
    parents: Array.isArray(d.parents) ? d.parents.filter((p): p is string => typeof p === 'string') : [],
    driveId: typeof d.driveId === 'string' ? d.driveId : undefined,
    ownedByMe: typeof d.ownedByMe === 'boolean' ? d.ownedByMe : undefined,
    shortcutTargetId: typeof shortcut?.targetId === 'string' ? shortcut.targetId : undefined,
  };
}

function cacheKey(userKey: string, fileId: string) { return `${userKey}:${fileId}`; }

export function invalidateLineage(userKey: string, fileId: string): void {
  cache.delete(cacheKey(userKey, fileId));
}

/** Test seam. */
export function _resetLineageCache(): void { cache.clear(); }

async function getMeta(userKey: string, fileId: string, fetchMeta: MetaFetcher, stats: { hits: number }): Promise<DriveFileMeta | 'missing'> {
  const key = cacheKey(userKey, fileId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    stats.hits++;
    return hit.meta;
  }
  const result = await fetchMeta(fileId);
  let value: DriveFileMeta | 'missing';
  if (result.ok) value = result.meta;
  else if (result.status === 404) value = 'missing';
  else throw new LineageError('lineage_unavailable', result.error, result.status);
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { meta: value, at: Date.now() });
  return value;
}

export interface Lineage {
  /** lineage[0] is the file itself; the last entry is a root or pseudo-root. */
  nodes: LineageNode[];
  file: DriveFileMeta;
  /** Parent hops actually walked (excludes pseudo-roots). */
  hops: number;
  cacheHits: number;
}

/**
 * Resolve the lineage of `fileId`. Throws LineageError('file_not_found') when
 * the file itself is invisible to this token, 'lineage_unavailable' on any
 * other Google failure (callers fail closed), 'lineage_too_deep' past
 * MAX_LINEAGE_HOPS.
 */
export async function resolveDriveLineage(userKey: string, fileId: string, fetchMeta: MetaFetcher): Promise<Lineage> {
  const stats = { hits: 0 };
  const nodes: LineageNode[] = [];
  let file: DriveFileMeta | null = null;
  let id = fileId;
  let hops = 0;
  // Guards a cycle that Drive should never return but a cache could.
  const seen = new Set<string>();

  for (;;) {
    if (seen.has(id)) break;
    seen.add(id);
    const meta = await getMeta(userKey, id, fetchMeta, stats);
    if (meta === 'missing') {
      if (!file) throw new LineageError('file_not_found', `Drive file '${fileId}' was not found with this account's token.`, 404);
      // An ancestor the user cannot see: the chain left the user's own tree.
      nodes.push(SHARED_WITH_ME_NODE);
      break;
    }
    if (!file) file = meta;
    const kind = nodeKindFor(meta);
    nodes.push({ id: meta.id, name: meta.name, kind, mimeType: meta.mimeType });
    if (kind === 'shared_drive') {
      nodes.push(SHARED_DRIVES_NODE);
      break;
    }
    if (meta.parents.length === 0) {
      // Top of what this token can see. The user's own root (or an orphan
      // they own) ends the chain; anything else was shared with them.
      if (meta.ownedByMe === false && !meta.driveId) nodes.push(SHARED_WITH_ME_NODE);
      break;
    }
    if (hops >= MAX_LINEAGE_HOPS) {
      throw new LineageError('lineage_too_deep', `Drive folder lineage for '${fileId}' exceeds ${MAX_LINEAGE_HOPS} levels.`);
    }
    id = meta.parents[0];
    hops++;
  }

  return { nodes, file: file as DriveFileMeta, hops, cacheHits: stats.hits };
}

/** Lineage of a node whose metadata is already in hand (a files.list entry). */
export async function resolveLineageFrom(userKey: string, meta: DriveFileMeta, fetchMeta: MetaFetcher): Promise<Lineage> {
  cache.set(cacheKey(userKey, meta.id), { meta, at: Date.now() });
  return resolveDriveLineage(userKey, meta.id, fetchMeta);
}

/** Convenience for callers that only need the human path (root … parent). */
export function lineagePath(nodes: LineageNode[]): LineageNode[] {
  return nodes.slice(1).reverse();
}

export function isFolderMeta(meta: Pick<DriveFileMeta, 'mimeType'>): boolean {
  return meta.mimeType === FOLDER_MIME;
}

/** Build the Drive metadata URL the walk fetches for one id. */
export function driveMetaUrl(fileId: string): string {
  return `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(LINEAGE_META_FIELDS)}&supportsAllDrives=true`;
}
