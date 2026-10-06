/**
 * Folder-inherited Drive access — the pure decision behind the feature-flagged
 * "Drive tree" model (plan docs/implementation_plans/
 * claude_google-drive-permissions-ux-427163_v1.md).
 *
 * A profile has a DEFAULT for every file in the user's Drive ('read' = Read
 * everything, 'write' = Read & write everything, 'explicit' = Only files I
 * allow) and any node — a file, a folder, a shared drive, or one of the two
 * pseudo-roots — can carry a SETTING (read / write / block). A file's
 * effective access is the nearest setting on its lineage (the file itself,
 * then its folder, its folder's folder, … up to the root); with none, the
 * default applies. Nearest wins in both directions: a Write on a file inside a
 * Blocked folder allows it, a Block on a file inside a Write folder blocks it.
 *
 * Settings are `access_rules` rows. New rows use `service: 'drive'` with
 * `target_kind` naming what the id is; the legacy per-file kinds (sheet_* /
 * doc_* / slide_*) written by the Picker, the approval links and the
 * agent-created-file auto-grant are read here as FILE-level settings, so an
 * existing user's rules keep their meaning when the flag turns on.
 *
 * Pure module (no db/env/network) so scripts/test-drive-tree-access.ts can
 * exercise every precedence case. Lineage fetching lives in driveLineage.ts.
 */
import { DRIVE_FILE_KINDS, ACTIVE_DRIVE_FILE_KINDS, kindForService } from './driveFileKinds';

export type DriveAccess = 'read' | 'write' | 'block';
export type DriveDefault = 'read' | 'write' | 'explicit';
export type DriveNodeKind = 'file' | 'folder' | 'shared_drive' | 'shared_with_me' | 'shared_drives';
export type DriveMatchLevel = DriveNodeKind | 'default';

/** Pseudo-root ids: nodes that exist only in FGAC's model, never at Google. */
export const SHARED_WITH_ME_ID = 'shared-with-me';
export const SHARED_DRIVES_ID = 'shared-drives';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

export const DRIVE_SERVICE = 'drive';
export const DRIVE_ACTION_TYPES = { read: 'drive_read', write: 'drive_read_write', block: 'drive_block' } as const;
export const DRIVE_TARGET_KINDS: DriveNodeKind[] = ['file', 'folder', 'shared_drive', 'shared_with_me', 'shared_drives'];

export interface LineageNode {
  id: string;
  name: string;
  kind: DriveNodeKind;
  mimeType?: string;
}

export interface DriveSetting {
  nodeId: string;
  access: DriveAccess;
  ruleId: string;
  /** 'drive' = a tree rule (any level); 'legacy' = a per-file sheet/doc/slide rule (file level only). */
  source: 'drive' | 'legacy';
  name?: string | null;
  createdAt?: Date;
}

export interface DriveEffective {
  access: DriveAccess;
  level: DriveMatchLevel;
  /** 0 = the file itself, 1 = its folder, … ; -1 when the default decided. */
  hops: number;
  decidedBy?: { nodeId: string; name: string; ruleIds: string[] };
}

export type DriveDenial = 'blocked' | 'read_only' | 'not_exposed';

export interface DriveDecision extends DriveEffective {
  allowed: boolean;
  denial?: DriveDenial;
  /** Newest deciding rule's creation time (post-approval grace retry input). */
  newestRuleAt: Date | null;
}

export function normalizeDriveDefault(value: string | null | undefined): DriveDefault {
  return value === 'write' || value === 'explicit' ? value : 'read';
}

export function driveDefaultLabel(value: DriveDefault): string {
  return value === 'write' ? 'Read & write everything' : value === 'explicit' ? 'Only files I allow' : 'Read everything';
}

export function accessLabel(access: DriveAccess): string {
  return access === 'write' ? 'Read & write' : access === 'block' ? 'Blocked' : 'Read';
}

/** The access a rule's actionType grants, for drive rules and the legacy per-file kinds. */
export function accessFromActionType(actionType: string): DriveAccess | null {
  if (actionType === DRIVE_ACTION_TYPES.read) return 'read';
  if (actionType === DRIVE_ACTION_TYPES.write) return 'write';
  if (actionType === DRIVE_ACTION_TYPES.block) return 'block';
  for (const k of ACTIVE_DRIVE_FILE_KINDS) {
    const t = DRIVE_FILE_KINDS[k].actionTypes;
    if (actionType === t.read) return 'read';
    if (actionType === t.readWrite) return 'write';
    if (actionType === t.block) return 'block';
  }
  return null;
}

export function actionTypeForAccess(access: DriveAccess): string {
  return access === 'write' ? DRIVE_ACTION_TYPES.write : access === 'block' ? DRIVE_ACTION_TYPES.block : DRIVE_ACTION_TYPES.read;
}

export type RuleLike = {
  id: string;
  service: string;
  actionType: string;
  targetResourceId: string | null;
  regexPattern?: string | null;
  targetKind?: string | null;
  resourceName?: string | null;
  createdAt?: Date;
};

/**
 * Index the rules that apply to a profile by Drive node id. Drive rules key on
 * `targetResourceId`; legacy per-file rules on `targetResourceId` with the
 * historical `regexPattern` fallback the per-file guards also accept.
 */
export function settingsFromRules(rules: RuleLike[]): Map<string, DriveSetting[]> {
  const map = new Map<string, DriveSetting[]>();
  for (const r of rules) {
    const isDrive = r.service === DRIVE_SERVICE;
    if (!isDrive && !kindForService(r.service)) continue;
    const access = accessFromActionType(r.actionType);
    const nodeId = r.targetResourceId || r.regexPattern;
    if (!access || !nodeId) continue;
    const list = map.get(nodeId) ?? [];
    list.push({ nodeId, access, ruleId: r.id, source: isDrive ? 'drive' : 'legacy', name: r.resourceName, createdAt: r.createdAt });
    map.set(nodeId, list);
  }
  return map;
}

/** Combine several settings on one node: a block wins, then write, then read. */
function combine(settings: DriveSetting[]): DriveAccess {
  if (settings.some(s => s.access === 'block')) return 'block';
  if (settings.some(s => s.access === 'write')) return 'write';
  return 'read';
}

/**
 * The effective access of the file at `lineage[0]`: the nearest node with a
 * setting decides; the default decides when none has one. Legacy per-file
 * rules count only on the file itself (index 0) — a folder id never carries
 * one, but the guard keeps the model honest.
 */
export function effectiveDriveAccess(
  lineage: LineageNode[],
  settings: Map<string, DriveSetting[]>,
  driveDefault: DriveDefault,
): DriveEffective {
  for (let i = 0; i < lineage.length; i++) {
    const node = lineage[i];
    const all = (settings.get(node.id) ?? []).filter(s => i === 0 || s.source === 'drive');
    if (all.length === 0) continue;
    // A tree setting the user made on this node is the newer, explicit
    // model: it outranks legacy per-file rules on the same node (which the
    // dashboard still shows as the file's setting until one is made).
    const tree = all.filter(s => s.source === 'drive');
    const here = tree.length > 0 ? tree : all;
    return {
      access: combine(here),
      level: node.kind,
      hops: i,
      decidedBy: { nodeId: node.id, name: node.name, ruleIds: here.map(s => s.ruleId) },
    };
  }
  return {
    access: driveDefault === 'write' ? 'write' : driveDefault === 'explicit' ? 'block' : 'read',
    level: 'default',
    hops: -1,
  };
}

/** Allow or deny one operation on the file at `lineage[0]`. */
export function resolveDriveTreeAccess(
  lineage: LineageNode[],
  settings: Map<string, DriveSetting[]>,
  driveDefault: DriveDefault,
  isMutating: boolean,
): DriveDecision {
  const eff = effectiveDriveAccess(lineage, settings, driveDefault);
  const deciding = eff.decidedBy ? (settings.get(eff.decidedBy.nodeId) ?? []) : [];
  const newestRuleAt = deciding.reduce<Date | null>(
    (acc, s) => (s.createdAt && (!acc || s.createdAt > acc) ? s.createdAt : acc), null,
  );
  if (eff.access === 'block') {
    // An explicit-only default with no setting reads as "not exposed" so the
    // existing expose/write approval links apply; a real block mints none.
    return { ...eff, allowed: false, denial: eff.level === 'default' ? 'not_exposed' : 'blocked', newestRuleAt };
  }
  if (isMutating && eff.access === 'read') {
    return { ...eff, allowed: false, denial: 'read_only', newestRuleAt };
  }
  return { ...eff, allowed: true, newestRuleAt };
}

/** Sentence fragment naming where a decision came from, for denial text and UI. */
export function describeDecision(eff: DriveEffective, driveDefault: DriveDefault): string {
  if (eff.level === 'default') return `the profile's default (${driveDefaultLabel(driveDefault)})`;
  if (eff.hops === 0) return 'a setting on the file itself';
  const noun = eff.level === 'shared_drive' ? 'shared drive' : eff.level === 'shared_with_me' ? 'section' : eff.level === 'shared_drives' ? 'section' : 'folder';
  return `the ${noun} '${eff.decidedBy?.name ?? eff.decidedBy?.nodeId}'${eff.hops > 1 ? ` (${eff.hops} levels up)` : ''}`;
}

export const DASHBOARD_PROFILE_HINT = 'The user can change this on the agent profile\'s Google Drive access card.';

/** Denial text for the three outcomes, naming the deciding node. */
export function driveDenialText(
  decision: DriveDecision,
  fileLabel: string,
  driveDefault: DriveDefault,
  dashboardUrl: string,
): string {
  const where = describeDecision(decision, driveDefault);
  if (decision.denial === 'blocked') {
    return `🚫 Access Denied: '${fileLabel}' is Blocked for this agent profile by ${where} — blocked files are invisible to the agent, reads included. ${DASHBOARD_PROFILE_HINT} ${dashboardUrl}`;
  }
  if (decision.denial === 'read_only') {
    return `🚫 Write denied: '${fileLabel}' is Read-only for this agent profile by ${where}. Reads still work; a write needs Read & write on the file or one of its folders. ${DASHBOARD_PROFILE_HINT} ${dashboardUrl}`;
  }
  return `🚫 Access Denied: '${fileLabel}' is not allowed for this agent profile — its default is "${driveDefaultLabel(driveDefault)}" and no folder or file setting reaches it. ${DASHBOARD_PROFILE_HINT} ${dashboardUrl}`;
}

// ─── Drive listing (files.list) filtering ───────────────────────────────────

/** Fields every listed file must carry so its lineage can be resolved. */
export const LIST_FILTER_FIELDS = 'id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails';

/**
 * Widen a `files.list` `fields` mask so each file carries what the filter
 * needs. Absent → Google's default (`kind,id,name,mimeType`) widened; `*` →
 * untouched; `files(…)` → the list fields injected; `files/…` → appended;
 * a mask that returns no `files` at all → untouched (nothing to filter).
 */
export function widenListFields(fields: string | null | undefined): string | undefined {
  if (fields === null || fields === undefined || fields.trim() === '') {
    return `kind,nextPageToken,incompleteSearch,files(kind,${LIST_FILTER_FIELDS})`;
  }
  const f = fields.trim();
  if (f === '*' || /(^|,)\s*files\s*(,|$)/.test(f)) return f;
  if (f.includes('files(')) return f.replace('files(', `files(${LIST_FILTER_FIELDS},`);
  if (f.includes('files/')) return `${f},${LIST_FILTER_FIELDS.split(',').map(x => `files/${x}`).join(',')}`;
  return f;
}

export interface ListedFile {
  id?: string;
  name?: string;
  mimeType?: string;
  parents?: string[];
  driveId?: string;
  ownedByMe?: boolean;
}

/** Drop blocked files from a files.list page; say how many were withheld. */
export function partitionListing<T extends ListedFile>(
  files: T[],
  accessOf: (file: T) => DriveAccess,
): { files: T[]; withheld: number } {
  const kept: T[] = [];
  let withheld = 0;
  for (const f of files) {
    if (accessOf(f) === 'block') withheld++;
    else kept.push(f);
  }
  return { files: kept, withheld };
}

/** Node kind from Drive metadata: folders, shared-drive roots, or files. */
export function nodeKindFor(meta: { id: string; mimeType?: string; driveId?: string }): DriveNodeKind {
  if (meta.driveId && meta.driveId === meta.id) return 'shared_drive';
  return meta.mimeType === FOLDER_MIME ? 'folder' : 'file';
}

export const SHARED_WITH_ME_NODE: LineageNode = { id: SHARED_WITH_ME_ID, name: 'Shared with me', kind: 'shared_with_me' };
export const SHARED_DRIVES_NODE: LineageNode = { id: SHARED_DRIVES_ID, name: 'Shared drives', kind: 'shared_drives' };

// ─── Drive discovery under the tree engine ───────────────────────────────────

/**
 * What the tree engine does with a Drive call that is not addressed to one
 * file by id. With the full `drive` scope every listing-shaped response can
 * name files the profile Blocks (names, thumbnailLink, exportLinks), so
 * discovery is fail-closed: `files.list` and `drives.list` are filtered, a
 * shared drive fetched by id is gated on its own setting, a short allowlist of
 * endpoints that name no file passes, and every other read is refused with
 * guidance to use `drive/v3/files`. Before 2026-10-03 only the exact path
 * `drive/v3/files` was filtered: `drive/v2/files`, `drive/v3/files/`, changes
 * (v2/v3), v2 folder children and shared-drive listings passed through.
 *
 * `null` = not a Drive discovery call (another family, a write, or an
 * id-addressed file call, which the per-file guards gate). Both API surfaces
 * (MCP google_api_get, REST proxy) call this, so they cannot drift.
 */
export type DriveDiscovery =
  | { kind: 'filter_files' }
  | { kind: 'filter_drives' }
  | { kind: 'shared_drive'; driveId: string }
  | { kind: 'allow' }
  | { kind: 'refuse'; endpoint: string };

/** Drive endpoints that never name a file (account info, change cursors, id minting). */
const DISCOVERY_ALLOW = [
  /^v[23]\/about$/,
  /^v[23]\/changes\/startpagetoken$/,
  /^v[23]\/apps(\/[^/]+)?$/,
  /^v[23]\/files\/generateids$/,
];

export function classifyDriveDiscovery(rawPath: string, method: string): DriveDiscovery | null {
  const path = rawPath.split(/[?#]/)[0].replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
  // Bare `v3/files` is how agents often spell Drive; canonicalisation adds the
  // prefix before forwarding, so classify it the same way.
  const withPrefix = /^v[23]\//i.test(path) ? `drive/${path}` : path;
  if (!/^drive\//i.test(withPrefix)) return null;
  const rest = withPrefix.slice('drive/'.length);
  const lower = rest.toLowerCase();
  const endpoint = `drive/${rest}`;
  const m = method.toUpperCase();

  // A push channel over the changes feed delivers the same unfiltered stream.
  if (/^v[23]\/changes\/watch$/.test(lower)) return { kind: 'refuse', endpoint };
  if (m !== 'GET' && m !== 'HEAD') return null;

  if (lower === 'v3/files') return { kind: 'filter_files' };
  if (lower === 'v3/drives') return { kind: 'filter_drives' };
  const drive = rest.match(/^v3\/drives\/([^/]+)$/);
  if (drive) return { kind: 'shared_drive', driveId: decodeURIComponent(drive[1]) };
  if (DISCOVERY_ALLOW.some(re => re.test(lower))) return { kind: 'allow' };
  // v2 lists a folder's children by id (childReference) — a listing, not a
  // read of the folder.
  if (/^v2\/files\/[^/]+\/children(\/|$)/.test(lower)) return { kind: 'refuse', endpoint };
  // Any other id-addressed file call is the per-file guards' job.
  if (/^v[23]\/files\/[^/]+/.test(lower)) return null;
  return { kind: 'refuse', endpoint };
}

/** Denial text for a refused discovery read: what is refused, why, and the filtered alternative. */
export function driveDiscoveryRefusal(endpoint: string): string {
  const children = /\/children(\/|$)/.test(endpoint);
  const changes = /\/changes/.test(endpoint);
  const alt = children
    ? 'To list a folder\'s contents, call GET drive/v3/files?q=\'<folderId>\' in parents instead.'
    : changes
      ? 'To find recently changed files, call GET drive/v3/files?orderBy=modifiedTime desc (optionally q=modifiedTime > \'<RFC 3339 time>\') instead.'
      : 'List or search files with GET drive/v3/files (q, orderBy, corpora, driveId and includeItemsFromAllDrives all work there) instead.';
  return `Access Denied: ${endpoint} is not available while this agent profile uses folder-based Google Drive access — its results are not filtered by the profile's Blocked folders and files. ${alt} Blocked files are withheld from that listing.`;
}

/** Effective access of a shared drive itself (its own setting, then "Shared drives", then the default). */
export function sharedDriveAccess(
  driveId: string,
  name: string,
  settings: Map<string, DriveSetting[]>,
  driveDefault: DriveDefault,
): DriveAccess {
  return effectiveDriveAccess([{ id: driveId, name, kind: 'shared_drive' }, SHARED_DRIVES_NODE], settings, driveDefault).access;
}

/** Denial text for a shared drive fetched by id that the profile Blocks. */
export function sharedDriveBlockedText(driveId: string): string {
  return `Access Denied: shared drive '${driveId}' is Blocked for this agent profile, so its details and files are withheld. ${DASHBOARD_PROFILE_HINT}`;
}

/** Withhold Blocked shared drives (and entries with no id) from a drives.list page. */
export function filterSharedDrives<T extends { drives?: unknown[] }>(
  data: T,
  settings: Map<string, DriveSetting[]>,
  driveDefault: DriveDefault,
): T & { drives: Array<{ id?: string; name?: string }>; withheld: number } {
  const all = (Array.isArray(data.drives) ? data.drives : []) as Array<{ id?: string; name?: string }>;
  const { files: drives, withheld } = partitionListing(all, d =>
    typeof d?.id === 'string' && d.id ? sharedDriveAccess(d.id, d.name ?? '', settings, driveDefault) : 'block');
  return { ...data, drives, withheld };
}
