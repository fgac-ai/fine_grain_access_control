/**
 * Agent-created Drive files — the pure half of the create auto-grant shared
 * by the MCP route and the REST proxy.
 *
 * A file the agent creates is its own output, so the creating profile gets
 * Read & Write on it. Sheets / Docs / Slides keep the per-kind rule the
 * per-file model has always written (the tree resolver reads it as a
 * file-level setting, and it still holds if the flag turns off). Every other
 * kind — text, PDF, image, binary, folder — has no per-kind rule, which was
 * harmless under drive.file (Google itself scoped the app to its own files)
 * but under the Drive tree model every file is gated, so with no setting the
 * profile default (often Read) refused the agent's later rename or update
 * (found 2026-10-03). In tree mode those kinds get a `service: 'drive'`
 * setting on the file's own node.
 *
 * Pure module (no db/env/network) so scripts/test-drive-tree-access.ts covers it.
 */
import { DRIVE_FILE_KINDS, kindForMimeType } from './driveFileKinds';
import { DRIVE_SERVICE, DRIVE_ACTION_TYPES, FOLDER_MIME } from './driveTreeAccess';

export interface CreatedDriveFile {
  id: string;
  name: string | null;
  mimeType: string | null;
}

export interface AgentCreatedGrant {
  service: string;
  actionType: string;
  /** Tree node kind for `service: 'drive'` rules; null for per-kind rules. */
  targetKind: string | null;
}

/** The Read & Write rule an agent-created file gets, or null when none applies (other kinds outside tree mode). */
export function agentCreatedGrant(mimeType: string | null, treeActive: boolean): AgentCreatedGrant | null {
  const kind = kindForMimeType(mimeType);
  if (kind) {
    return { service: DRIVE_FILE_KINDS[kind].service, actionType: DRIVE_FILE_KINDS[kind].actionTypes.readWrite, targetKind: null };
  }
  if (!treeActive) return null;
  return { service: DRIVE_SERVICE, actionType: DRIVE_ACTION_TYPES.write, targetKind: mimeType === FOLDER_MIME ? 'folder' : 'file' };
}

/** The created file named by a Drive `files.create` / `files.copy` response body, or null. */
export function createdDriveFileFromBody(body: unknown): CreatedDriveFile | null {
  if (!body || typeof body !== 'object') return null;
  const f = body as { kind?: unknown; id?: unknown; name?: unknown; mimeType?: unknown };
  if (typeof f.id !== 'string' || !f.id) return null;
  // A `fields` mask can drop `kind`; when present it must be a file.
  if (f.kind !== undefined && f.kind !== 'drive#file') return null;
  return { id: f.id, name: typeof f.name === 'string' ? f.name : null, mimeType: typeof f.mimeType === 'string' ? f.mimeType : null };
}

/** `drive/v3/files` or `upload/drive/v3/files` (query string ignored): the collection a POST creates in. */
export function isDriveCreatePath(path: string): boolean {
  return /^(upload\/)?drive\/v3\/files$/i.test(path.split('?')[0]);
}

/**
 * The first leg of a resumable upload. Google answers it with a session URI
 * and no file; the bytes go straight to that URI, never back through FGAC,
 * so the created file's id is never seen. The proxy therefore names the file
 * up front: it injects a `files.generateIds` id into the metadata and grants
 * that id once Google accepts the initiation.
 */
export function isResumableInitiation(method: string, path: string, query: URLSearchParams): boolean {
  return method === 'POST' && /^upload\/drive\/v3\/files$/i.test(path.split('?')[0]) && query.get('uploadType') === 'resumable' && !query.has('upload_id');
}

/**
 * The initiation metadata with `id` set to a freshly generated id, or null
 * when it cannot be injected. A caller-chosen id is never adopted: granting
 * it would let an agent name an EXISTING file and receive Read & Write on it.
 */
export function injectCreateId(body: string, generatedId: string): string | null {
  let meta: unknown = {};
  if (body.trim() !== '') {
    try { meta = JSON.parse(body); } catch { return null; }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  if ('id' in meta) return null;
  return JSON.stringify({ ...meta, id: generatedId });
}
