/**
 * Unit tests for the folder-inherited Drive access model:
 *   src/lib/driveTreeAccess.ts (pure resolver, listing helpers) and
 *   src/lib/driveLineage.ts (lineage walk over a fake Drive, caching).
 * Run: npx tsx scripts/test-drive-tree-access.ts  (part of `npm run mcp:lint`)
 */
import {
  resolveDriveTreeAccess, effectiveDriveAccess, settingsFromRules, widenListFields, partitionListing,
  normalizeDriveDefault, driveDenialText, accessFromActionType, type LineageNode,
  SHARED_WITH_ME_ID, SHARED_DRIVES_ID, FOLDER_MIME,
} from '../src/lib/driveTreeAccess';
import {
  resolveDriveLineage, resolveLineageFrom, parseDriveFileMeta, _resetLineageCache, LineageError, type MetaFetcher, type DriveFileMeta,
} from '../src/lib/driveLineage';
import { agentCreatedGrant, createdDriveFileFromBody, isDriveCreatePath, isResumableInitiation, injectCreateId } from '../src/lib/agentCreatedFiles';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

const doc = 'application/vnd.google-apps.document';
const node = (id: string, name: string, kind: LineageNode['kind'] = 'folder'): LineageNode => ({ id, name, kind });
// Drafts (file) ← Phase 2 ← Deliverables ← Clients ← My Drive
const deep: LineageNode[] = [
  { id: 'v3', name: 'Phase 2 draft v3', kind: 'file', mimeType: doc },
  node('drafts', 'Drafts'), node('phase2', 'Phase 2'), node('deliv', 'Deliverables'), node('clients', 'Clients'), node('root', 'My Drive'),
];
const rules = (list: Array<[string, string, string, string?]>) => settingsFromRules(
  list.map(([id, service, actionType, target], i) => ({ id, service, actionType, targetResourceId: target ?? null, targetKind: service === 'drive' ? 'folder' : null, createdAt: new Date(2026, 0, i + 1) })),
);

console.log('normalizeDriveDefault / accessFromActionType:');
check('null → read', normalizeDriveDefault(null) === 'read');
check('write / explicit pass through, junk → read', normalizeDriveDefault('write') === 'write' && normalizeDriveDefault('explicit') === 'explicit' && normalizeDriveDefault('x') === 'read');
check('drive_* and legacy kinds map to access', accessFromActionType('drive_block') === 'block' && accessFromActionType('sheet_read_write') === 'write' && accessFromActionType('slide_read') === 'read' && accessFromActionType('send_whitelist') === null);

console.log('effective access, nearest setting wins:');
const none = rules([]);
check('no settings, default read → read from default', (() => { const e = effectiveDriveAccess(deep, none, 'read'); return e.access === 'read' && e.level === 'default' && e.hops === -1; })());
check('no settings, default write → write', effectiveDriveAccess(deep, none, 'write').access === 'write');
check('no settings, default explicit → block', effectiveDriveAccess(deep, none, 'explicit').access === 'block');

const clientsWrite = rules([['r1', 'drive', 'drive_read_write', 'clients']]);
const e1 = effectiveDriveAccess(deep, clientsWrite, 'read');
check('Write on Clients reaches a file four levels down (no depth cap)', e1.access === 'write' && e1.level === 'folder' && e1.hops === 4 && e1.decidedBy?.name === 'Clients');

const clientsWriteDelivRead = rules([['r1', 'drive', 'drive_read_write', 'clients'], ['r2', 'drive', 'drive_read', 'deliv']]);
const e2 = effectiveDriveAccess(deep, clientsWriteDelivRead, 'read');
check('nearer Read on Deliverables beats farther Write on Clients', e2.access === 'read' && e2.hops === 3 && e2.decidedBy?.name === 'Deliverables');

const blockedFolderFileWrite = rules([['r1', 'drive', 'drive_block', 'clients'], ['r2', 'drive', 'drive_read_write', 'v3']]);
check('Write on the file inside a Blocked folder allows (nearest wins, not block-anywhere)',
  effectiveDriveAccess(deep, blockedFolderFileWrite, 'read').access === 'write');

const writeFolderFileBlock = rules([['r1', 'drive', 'drive_read_write', 'clients'], ['r2', 'drive', 'drive_block', 'v3']]);
check('Block on the file inside a Write folder blocks', effectiveDriveAccess(deep, writeFolderFileBlock, 'read').access === 'block');

const legacy = rules([['r1', 'drive', 'drive_read_write', 'clients'], ['r2', 'docs', 'doc_read', 'v3']]);
const e3 = effectiveDriveAccess(deep, legacy, 'read');
check('legacy per-file doc rule is a file-level setting that beats the folder', e3.access === 'read' && e3.hops === 0 && e3.level === 'file');

const legacyOnFolderId = settingsFromRules([{ id: 'x', service: 'docs', actionType: 'doc_block', targetResourceId: 'clients' }]);
check('a legacy rule is ignored above file level', effectiveDriveAccess(deep, legacyOnFolderId, 'read').level === 'default');

const mixedOnOneNode = rules([['r1', 'drive', 'drive_read_write', 'v3'], ['r2', 'docs', 'doc_block', 'v3']]);
check('a tree setting on a node outranks a legacy rule on the same node', effectiveDriveAccess(deep, mixedOnOneNode, 'read').access === 'write');
const twoTreeRules = rules([['r1', 'drive', 'drive_read_write', 'v3'], ['r2', 'drive', 'drive_block', 'v3']]);
check('between two tree rules on one node (global + assigned) a block wins', effectiveDriveAccess(deep, twoTreeRules, 'read').access === 'block');

const legacyRegex = settingsFromRules([{ id: 'x', service: 'sheets', actionType: 'sheet_read_write', targetResourceId: null, regexPattern: 'v3' }]);
check('legacy regexPattern id fallback is honoured', effectiveDriveAccess(deep, legacyRegex, 'read').access === 'write');

console.log('decisions:');
const d1 = resolveDriveTreeAccess(deep, none, 'read', false);
check('read under default read → allowed', d1.allowed && d1.level === 'default');
const d2 = resolveDriveTreeAccess(deep, none, 'read', true);
check('write under default read → read_only', !d2.allowed && d2.denial === 'read_only');
const d3 = resolveDriveTreeAccess(deep, none, 'explicit', false);
check('read under explicit default → not_exposed (so the expose link applies)', !d3.allowed && d3.denial === 'not_exposed');
const d4 = resolveDriveTreeAccess(deep, writeFolderFileBlock, 'write', false);
check('explicit block → blocked (no link)', !d4.allowed && d4.denial === 'blocked');
const d5 = resolveDriveTreeAccess(deep, clientsWrite, 'read', true);
check('write with inherited Write → allowed, newest deciding rule recorded', d5.allowed && d5.newestRuleAt instanceof Date);
check('denial text names the deciding folder and its distance',
  driveDenialText(resolveDriveTreeAccess(deep, clientsWriteDelivRead, 'read', true), 'Phase 2 draft v3', 'read', 'https://fgac.ai/dashboard')
    .includes("the folder 'Deliverables' (3 levels up)"));
check('denial text for the explicit default names the default',
  driveDenialText(d3, 'Phase 2 draft v3', 'explicit', 'https://fgac.ai/dashboard').includes('"Only files I allow"'));

console.log('shared roots:');
const sharedFile: LineageNode[] = [{ id: 'f', name: 'Board deck', kind: 'file' }, { id: SHARED_WITH_ME_ID, name: 'Shared with me', kind: 'shared_with_me' }];
const blockShared = settingsFromRules([{ id: 'x', service: 'drive', actionType: 'drive_block', targetResourceId: SHARED_WITH_ME_ID, targetKind: 'shared_with_me' }]);
check('a Block on the Shared-with-me root hides a directly shared file', effectiveDriveAccess(sharedFile, blockShared, 'read').access === 'block');
const driveFile: LineageNode[] = [{ id: 'f', name: 'Runbook', kind: 'file' }, node('rb', 'Runbooks'), { id: 'drv', name: 'Engineering', kind: 'shared_drive' }, { id: SHARED_DRIVES_ID, name: 'Shared drives', kind: 'shared_drives' }];
const writeDrive = settingsFromRules([{ id: 'x', service: 'drive', actionType: 'drive_read_write', targetResourceId: 'drv', targetKind: 'shared_drive' }]);
const e4 = effectiveDriveAccess(driveFile, writeDrive, 'read');
check('a Write on a shared drive reaches its files', e4.access === 'write' && e4.level === 'shared_drive');
check('the default applies everywhere, shared roots included', effectiveDriveAccess(driveFile, none, 'write').access === 'write');

console.log('agent-created files stay writable for the creating profile:');
// Write after create, default Read: the created file's grant must be a
// setting the resolver reads, whatever kind of file the agent made.
const createdLineage = (mimeType: string): LineageNode[] => [{ id: 'new1', name: 'notes.txt', kind: 'file', mimeType }, node('root', 'My Drive')];
const afterCreate = (mimeType: string, def: 'read' | 'explicit' = 'read') => {
  const g = agentCreatedGrant(mimeType, true);
  const s = settingsFromRules(g ? [{ id: 'auto', service: g.service, actionType: g.actionType, targetResourceId: 'new1', targetKind: g.targetKind }] : []);
  return resolveDriveTreeAccess(createdLineage(mimeType), s, def, true);
};
for (const mime of ['text/plain', 'application/octet-stream', 'application/pdf', 'image/png', 'application/vnd.google-apps.spreadsheet', doc, 'application/vnd.google-apps.presentation']) {
  check(`created ${mime} is writable under default Read`, afterCreate(mime).allowed);
}
check('created text file is writable under "Only files I allow"', afterCreate('text/plain', 'explicit').allowed);
check('the grant is a file-level setting (decided by the file, not the default)', afterCreate('text/plain').level === 'file');
check('typed kinds keep the per-file rule (still honoured with the flag off)', agentCreatedGrant(doc, true)?.service === 'docs' && agentCreatedGrant(doc, false)?.service === 'docs');
check('other kinds get a tree rule only in tree mode', agentCreatedGrant('text/plain', false) === null && agentCreatedGrant('text/plain', true)?.service === 'drive');
check('an agent-created folder is granted as a folder node', agentCreatedGrant(FOLDER_MIME, true)?.targetKind === 'folder');

console.log('created-file responses and resumable creates:');
check('a Drive File resource yields the created file', JSON.stringify(createdDriveFileFromBody({ kind: 'drive#file', id: 'f1', name: 'a.txt', mimeType: 'text/plain' })) === JSON.stringify({ id: 'f1', name: 'a.txt', mimeType: 'text/plain' }));
check('a body without an id yields nothing', createdDriveFileFromBody({}) === null && createdDriveFileFromBody(null) === null && createdDriveFileFromBody('x') === null);
check('a non-file resource (e.g. an error) yields nothing', createdDriveFileFromBody({ kind: 'drive#permission', id: 'p' }) === null);
check('isDriveCreatePath: metadata and upload creates', isDriveCreatePath('drive/v3/files') && isDriveCreatePath('upload/drive/v3/files') && !isDriveCreatePath('drive/v3/files/abc') && !isDriveCreatePath('drive/v3/files/abc/copy'));
check('resumable initiation is recognised', isResumableInitiation('POST', 'upload/drive/v3/files', new URLSearchParams('uploadType=resumable')) && !isResumableInitiation('POST', 'upload/drive/v3/files', new URLSearchParams('uploadType=media')) && !isResumableInitiation('PUT', 'upload/drive/v3/files', new URLSearchParams('uploadType=resumable&upload_id=x')));
const inj = injectCreateId('{"name":"big.bin"}', 'gen1');
check('a resumable initiation body gets the pre-generated id', inj !== null && JSON.parse(inj).id === 'gen1' && JSON.parse(inj).name === 'big.bin');
check('an empty initiation body gets one too', JSON.parse(injectCreateId('', 'gen1')!).id === 'gen1');
check('a caller-chosen id is never adopted (could name an existing file)', injectCreateId('{"id":"theirs"}', 'gen1') === null);
check('a non-JSON body is left alone', injectCreateId('not json', 'gen1') === null);

console.log('listing fields:');
check('absent → widened default', widenListFields(undefined) === 'kind,nextPageToken,incompleteSearch,files(kind,id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails)');
check('files(…) gets the filter fields injected', widenListFields('nextPageToken,files(id,name)') === 'nextPageToken,files(id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails,id,name)');
check('* untouched', widenListFields('*') === '*');
check('bare files untouched', widenListFields('nextPageToken,files') === 'nextPageToken,files');
check('files/ syntax appended', widenListFields('files/id')!.startsWith('files/id,files/id,files/name'));
check('a mask with no files is untouched', widenListFields('nextPageToken') === 'nextPageToken');
const part = partitionListing([{ id: 'a' }, { id: 'b' }, { id: 'c' }], f => (f.id === 'b' ? 'block' : 'read'));
check('partition withholds blocked files and counts them', part.files.length === 2 && part.withheld === 1);

console.log('lineage walk over a fake Drive:');
const fake: Record<string, DriveFileMeta> = {
  root: { id: 'root', name: 'My Drive', mimeType: FOLDER_MIME, parents: [], ownedByMe: true },
  clients: { id: 'clients', name: 'Clients', mimeType: FOLDER_MIME, parents: ['root'], ownedByMe: true },
  v3: { id: 'v3', name: 'Phase 2 draft v3', mimeType: doc, parents: ['clients'], ownedByMe: true },
  sharedDirect: { id: 'sharedDirect', name: 'Board deck', mimeType: doc, parents: [], ownedByMe: false },
  theirFolder: { id: 'theirFolder', name: 'Vendor stuff', mimeType: FOLDER_MIME, parents: ['theirRoot'], ownedByMe: false },
  sharedNested: { id: 'sharedNested', name: 'Vendor list', mimeType: doc, parents: ['theirFolder'], ownedByMe: false },
  drv: { id: 'drv', name: 'Engineering', mimeType: FOLDER_MIME, parents: [], driveId: 'drv', ownedByMe: false },
  rb: { id: 'rb', name: 'Runbooks', mimeType: FOLDER_MIME, parents: ['drv'], driveId: 'drv', ownedByMe: false },
  oncall: { id: 'oncall', name: 'On-call', mimeType: doc, parents: ['rb'], driveId: 'drv', ownedByMe: false },
};
let fetches = 0;
const fetcher: MetaFetcher = async id => {
  fetches++;
  if (id === 'boom') return { ok: false, status: 500, error: 'Google 500' };
  const m = fake[id];
  return m ? { ok: true, meta: m } : { ok: false, status: 404, error: 'not found' };
};
// a 30-deep chain for the hop cap
let prev = 'root';
for (let i = 0; i < 30; i++) { const id = `d${i}`; fake[id] = { id, name: id, mimeType: FOLDER_MIME, parents: [prev], ownedByMe: true }; prev = id; }
fake.deepFile = { id: 'deepFile', name: 'deep', mimeType: doc, parents: [prev], ownedByMe: true };

(async () => {
  _resetLineageCache();
  const l1 = await resolveDriveLineage('u1', 'v3', fetcher);
  check('My Drive file: file → Clients → My Drive, 2 hops, ends at the owned root',
    l1.nodes.map(n => n.id).join('>') === 'v3>clients>root' && l1.hops === 2 && l1.nodes[2].kind === 'folder');
  const before = fetches;
  const l1b = await resolveDriveLineage('u1', 'v3', fetcher);
  check('second resolution is served from the cache', fetches === before && l1b.cacheHits === 3);
  const l1c = await resolveDriveLineage('u2', 'v3', fetcher);
  check('the cache is partitioned per user', l1c.cacheHits === 0);

  const l2 = await resolveDriveLineage('u1', 'sharedDirect', fetcher);
  check('directly shared file ends at the shared-with-me pseudo-root', l2.nodes.map(n => n.id).join('>') === `sharedDirect>${SHARED_WITH_ME_ID}`);
  const l3 = await resolveDriveLineage('u1', 'sharedNested', fetcher);
  check('shared file in a sharer\'s folder: the invisible ancestor (404) ends the chain at shared-with-me',
    l3.nodes.map(n => n.id).join('>') === `sharedNested>theirFolder>${SHARED_WITH_ME_ID}`);
  const l4 = await resolveDriveLineage('u1', 'oncall', fetcher);
  check('shared drive file: … → drive root (shared_drive) → shared-drives pseudo-root',
    l4.nodes.map(n => `${n.id}:${n.kind}`).join('>') === `oncall:file>rb:folder>drv:shared_drive>${SHARED_DRIVES_ID}:shared_drives`);

  let notFound: LineageError | null = null;
  try { await resolveDriveLineage('u1', 'nope', fetcher); } catch (e) { notFound = e as LineageError; }
  check('an invisible file itself → file_not_found (404)', notFound?.code === 'file_not_found' && notFound?.status === 404);
  let unavailable: LineageError | null = null;
  try { await resolveDriveLineage('u1', 'boom', fetcher); } catch (e) { unavailable = e as LineageError; }
  check('a Google failure → lineage_unavailable (fail closed)', unavailable?.code === 'lineage_unavailable');
  let tooDeep: LineageError | null = null;
  try { await resolveDriveLineage('u1', 'deepFile', fetcher); } catch (e) { tooDeep = e as LineageError; }
  check('past the hop cap → lineage_too_deep', tooDeep?.code === 'lineage_too_deep');

  const listed = parseDriveFileMeta({ id: 'v3', name: 'Phase 2 draft v3', mimeType: doc, parents: ['clients'], ownedByMe: true })!;
  const l5 = await resolveLineageFrom('u3', listed, fetcher);
  check('a listed file seeds the cache and resolves through its parents', l5.nodes.map(n => n.id).join('>') === 'v3>clients>root');
  check('parseDriveFileMeta reads shortcut targets and tolerates missing fields',
    parseDriveFileMeta({ id: 's', shortcutDetails: { targetId: 't' } })?.shortcutTargetId === 't' && parseDriveFileMeta({ name: 'no id' }) === null);

  if (failures > 0) {
    console.error(`\n${failures} Drive tree access check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll Drive tree access checks passed');
})();
