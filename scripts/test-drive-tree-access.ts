/**
 * Unit tests for the folder-inherited Drive access model:
 *   src/lib/driveTreeAccess.ts (pure resolver, listing helpers) and
 *   src/lib/driveLineage.ts (lineage walk over a fake Drive, caching), and
 *   the Drive discovery classifier both API surfaces share.
 * Run: npx tsx scripts/test-drive-tree-access.ts  (part of `npm run mcp:lint`)
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveDriveTreeAccess, effectiveDriveAccess, settingsFromRules, widenListFields, partitionListing,
  normalizeDriveDefault, driveDenialText, accessFromActionType, type LineageNode,
  classifyDriveDiscovery, driveDiscoveryRefusal, sharedDriveAccess, filterSharedDrives,
  SHARED_WITH_ME_ID, SHARED_DRIVES_ID, FOLDER_MIME,
  countDriveSettings, classifyDriveSettings, settingsAfterClear, isClearableDriveOverride,
} from '../src/lib/driveTreeAccess';
import {
  resolveDriveLineage, resolveLineageFrom, parseDriveFileMeta, _resetLineageCache, LineageError, type MetaFetcher, type DriveFileMeta,
} from '../src/lib/driveLineage';
import {
  agentCreatedGrant, agentCreatedRuleName, createdDriveFileFromBody, isDriveCreatePath, isResumableInitiation, injectCreateId,
  classifyProxyDriveCall, legacyUnruledDriveDecision, createMetadataMimeType,
} from '../src/lib/agentCreatedFiles';

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

console.log('override count and Clear overrides agree; the agent\'s own files are neither:');
// 2026-10-05 (PR #185 preview): the header read "0 overrides" while two
// agent-created files showed Write set on themselves. Overrides = the user's
// card settings, exactly what Clear removes; agent-created and per-file
// rules are counted apart and kept.
{
  const auto = (id: string, mime: string, name: string) => {
    const g = agentCreatedGrant(mime, true)!;
    return { id: `auto-${id}`, ruleName: agentCreatedRuleName(name, id), service: g.service, actionType: g.actionType, targetResourceId: id, targetKind: g.targetKind };
  };
  const mixed = [
    auto('txt', 'text/plain', 'qa-a22-source'),
    auto('gdoc', doc, 'qa-a22-copy renamed'),
    { id: 'u1', ruleName: 'Read & write: Clients', service: 'drive', actionType: 'drive_read_write', targetResourceId: 'clients', targetKind: 'folder' },
    { id: 'u2', ruleName: 'Blocked: Drafts', service: 'drive', actionType: 'drive_block', targetResourceId: 'drafts', targetKind: 'folder' },
    { id: 'p1', ruleName: 'Picker: Budget', service: 'sheets', actionType: 'sheet_read', targetResourceId: 'budget' },
    // The user also set the agent's text file on the card: that node is an override now.
    auto('both', 'text/plain', 'agent then user'),
    { id: 'u3', ruleName: 'Blocked: agent then user', service: 'drive', actionType: 'drive_block', targetResourceId: 'both', targetKind: 'file' },
  ];
  const s = settingsFromRules(mixed);
  const c = countDriveSettings(s);
  check('agent-created rule names carry the shared prefix', agentCreatedRuleName('a.txt', 'id1') === 'Agent-created: a.txt' && agentCreatedRuleName(null, 'id1') === 'Agent-created: id1');
  check('agent-created files of both kinds are classed as the agent\'s, not overrides', classifyDriveSettings(s.get('txt')!) === 'agent_created' && classifyDriveSettings(s.get('gdoc')!) === 'agent_created');
  check('a Picker rule is a per-file rule', classifyDriveSettings(s.get('budget')!) === 'per_file');
  check('a user setting on an agent file makes the node an override', classifyDriveSettings(s.get('both')!) === 'override');
  check('counts: 3 overrides, 2 agent-created, 1 per-file', c.overrides === 3 && c.agentCreated === 2 && c.perFile === 1);
  const onFile = (id: string, set: typeof s) => effectiveDriveAccess([{ id, name: id, kind: 'file' }, node('root', 'My Drive')], set, 'read').access;
  check('a user Block on the agent\'s own file outranks its Write auto-grant', onFile('both', s) === 'block');
  const userRead = settingsFromRules([auto('t2', 'text/plain', 'n'), { id: 'u9', ruleName: 'Read: n', service: 'drive', actionType: 'drive_read', targetResourceId: 't2', targetKind: 'file' }]);
  check('a user Read narrows it too (not combined up to Write)', onFile('t2', userRead) === 'read');
  check('a native agent file\'s per-kind grant is outranked by a user tree setting', onFile('gdoc', settingsFromRules([auto('gdoc', doc, 'd'), { id: 'u8', ruleName: 'Blocked: d', service: 'drive', actionType: 'drive_block', targetResourceId: 'gdoc', targetKind: 'file' }])) === 'block');
  const after = settingsAfterClear(s);
  const ca = countDriveSettings(after);
  check('after Clear: 0 overrides, agent and per-file settings intact', ca.overrides === 0 && ca.agentCreated === 3 && ca.perFile === 1);
  check('after Clear the user\'s Block is gone and the agent\'s grant decides again', onFile('both', after) === 'write');
  check('after Clear the agent\'s files stay writable under default Read',
    ['txt', 'gdoc', 'both'].every(id => resolveDriveTreeAccess([{ id, name: id, kind: 'file' }, node('root', 'My Drive')], after, 'read', true).allowed));
  check('server Clear removes exactly the counted rules (user drive rules only)',
    mixed.filter(isClearableDriveOverride).map(r => r.id).sort().join(',') === 'u1,u2,u3');
}

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

console.log('per-file (flag off) model — REST/MCP parity:');
// The legacy create auto-grant: Sheets/Docs/Slides get their per-kind Read &
// Write rule (what MCP's grantDriveCreatedFile writes); other kinds get none.
check('legacy: a created Sheet gets a sheets read_write rule', agentCreatedGrant('application/vnd.google-apps.spreadsheet', false)?.service === 'sheets' && agentCreatedGrant('application/vnd.google-apps.spreadsheet', false)?.actionType === 'sheet_read_write');
check('legacy: a created Doc gets a docs rule', agentCreatedGrant(doc, false)?.service === 'docs');
check('legacy: a created Slides deck gets a slides rule', agentCreatedGrant('application/vnd.google-apps.presentation', false)?.service === 'slides');
check('legacy: a create with an unknown mimeType writes nothing', agentCreatedGrant(null, false) === null);
// Classification mirrors the MCP drive_copy / drive_create / drive_file kinds.
const cc = (m: string, p: string) => JSON.stringify(classifyProxyDriveCall(m, p));
check('copy is its own kind (gated as a READ of the source)', cc('POST', 'drive/v3/files/src1/copy') === JSON.stringify({ kind: 'copy', fileId: 'src1' }));
check('copy query string is ignored', cc('POST', 'drive/v3/files/src1/copy?fields=id,name') === JSON.stringify({ kind: 'copy', fileId: 'src1' }));
check('metadata create', cc('POST', 'drive/v3/files') === JSON.stringify({ kind: 'create' }));
check('upload create', cc('POST', 'upload/drive/v3/files?uploadType=multipart') === JSON.stringify({ kind: 'create' }));
check('GET listing is discovery, never gated', classifyProxyDriveCall('GET', 'drive/v3/files') === null);
check('generateIds is never gated', classifyProxyDriveCall('GET', 'drive/v3/files/generateIds') === null);
check('a rename is a mutating file call', cc('PATCH', 'drive/v3/files/f1') === JSON.stringify({ kind: 'file', fileId: 'f1', isMutating: true }));
check('a metadata read is a non-mutating file call', cc('GET', 'drive/v3/files/f1?fields=name') === JSON.stringify({ kind: 'file', fileId: 'f1', isMutating: false }));
check('the upload/ media update of an existing file is gated (was skipped)', cc('PATCH', 'upload/drive/v3/files/f1?uploadType=media') === JSON.stringify({ kind: 'file', fileId: 'f1', isMutating: true }));
check('v2 id-addressed calls stay gated', cc('DELETE', 'drive/v2/files/f1') === JSON.stringify({ kind: 'file', fileId: 'f1', isMutating: true }));
check('comments on a file are their own kind', cc('POST', 'drive/v3/files/f1/comments') === JSON.stringify({ kind: 'comments', fileId: 'f1', isMutating: true }) && cc('GET', 'drive/v3/files/f1/comments/c1/replies') === JSON.stringify({ kind: 'comments', fileId: 'f1', isMutating: false }));
check('an encoded id is decoded', cc('GET', 'drive/v3/files/a%2Db') === JSON.stringify({ kind: 'file', fileId: 'a-b', isMutating: false }));
// No rule names the file: what it is decides (MCP checkDriveFileAccess).
const fileCall = classifyProxyDriveCall('PATCH', 'drive/v3/files/f1')!;
const copyCall = classifyProxyDriveCall('POST', 'drive/v3/files/f1/copy')!;
check('unruled Sheet → not exposed', legacyUnruledDriveDecision(fileCall, 'application/vnd.google-apps.spreadsheet') === 'not_exposed');
check('unruled Doc → not exposed', legacyUnruledDriveDecision(fileCall, doc) === 'not_exposed');
check("unruled text file (the agent's own create) → drive.file passthrough", legacyUnruledDriveDecision(fileCall, 'text/plain') === 'passthrough');
check('unruled PDF → drive.file passthrough', legacyUnruledDriveDecision(fileCall, 'application/pdf') === 'passthrough');
check('comments on an unruled file are not exposed, whatever it is (MCP file_comments parity)', legacyUnruledDriveDecision(classifyProxyDriveCall('GET', 'drive/v3/files/f1/comments')!, 'application/pdf') === 'not_exposed');
check('a copy of an unruled source is not exposed, whatever it is', legacyUnruledDriveDecision(copyCall, 'text/plain') === 'not_exposed' && legacyUnruledDriveDecision(copyCall, 'application/vnd.google-apps.spreadsheet') === 'not_exposed');
check('create metadata mimeType is read', createMetadataMimeType('{"name":"x","mimeType":"application/vnd.google-apps.spreadsheet"}') === 'application/vnd.google-apps.spreadsheet' && createMetadataMimeType('') === null && createMetadataMimeType('nope') === null && createMetadataMimeType('{"name":"x"}') === null);

console.log('listing fields:');
check('absent → widened default', widenListFields(undefined) === 'kind,nextPageToken,incompleteSearch,files(kind,id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails)');
check('files(…) gets the filter fields injected', widenListFields('nextPageToken,files(id,name)') === 'nextPageToken,files(id,name,mimeType,parents,driveId,ownedByMe,shortcutDetails,id,name)');
check('* untouched', widenListFields('*') === '*');
check('bare files untouched', widenListFields('nextPageToken,files') === 'nextPageToken,files');
check('files/ syntax appended', widenListFields('files/id')!.startsWith('files/id,files/id,files/name'));
check('a mask with no files is untouched', widenListFields('nextPageToken') === 'nextPageToken');
const part = partitionListing([{ id: 'a' }, { id: 'b' }, { id: 'c' }], f => (f.id === 'b' ? 'block' : 'read'));
check('partition withholds blocked files and counts them', part.files.length === 2 && part.withheld === 1);

// ── Drive discovery under the tree engine (2026-10-03 adversarial review):
// only `drive/v3/files` was filtered; every other listing-shaped read —
// `drive/v2/files`, the `drive/v3/files/` trailing-slash spelling, changes
// (v2 and v3), v2 folder children, shared-drive listings — returned names,
// thumbnailLink and exportLinks of Blocked files with the full `drive` scope.
console.log('Drive discovery classification (tree engine on):');
const disc = (p: string, m = 'GET') => classifyDriveDiscovery(p, m);
check('drive/v3/files → filtered listing', disc('drive/v3/files')?.kind === 'filter_files');
check('drive/v3/files with a query → filtered listing', disc('drive/v3/files?q=name%20contains%20%27x%27&fields=files(name,thumbnailLink)')?.kind === 'filter_files');
check('trailing-slash drive/v3/files/ → filtered listing, never unfiltered passthrough', disc('drive/v3/files/')?.kind === 'filter_files');
check('trailing-slash with a query → filtered listing', disc('drive/v3/files/?q=trashed%3Dfalse')?.kind === 'filter_files');
check('doubled slashes drive//v3//files → filtered listing', disc('drive//v3//files')?.kind === 'filter_files');
check('HEAD on the listing is treated as a read', disc('drive/v3/files', 'HEAD')?.kind === 'filter_files');
check('drive/v2/files (v2 list: title, exportLinks) → refused', disc('drive/v2/files')?.kind === 'refuse');
check('drive/v2/files/ trailing slash → refused', disc('drive/v2/files/?maxResults=100')?.kind === 'refuse');
check('drive/v3/changes → refused', disc('drive/v3/changes?pageToken=1')?.kind === 'refuse');
check('drive/v2/changes → refused', disc('drive/v2/changes')?.kind === 'refuse');
check('drive/v3/changes/ trailing slash → refused', disc('drive/v3/changes/?pageToken=1')?.kind === 'refuse');
check('POST drive/v3/changes/watch (push channel over changes) → refused', disc('drive/v3/changes/watch?pageToken=1', 'POST')?.kind === 'refuse');
check('v2 folder children listing → refused', disc('drive/v2/files/folder123/children')?.kind === 'refuse');
check('v2 folder children with a child id → refused', disc('drive/v2/files/folder123/children/child9')?.kind === 'refuse');
check('teamdrives (deprecated shared-drive list) → refused', disc('drive/v3/teamdrives')?.kind === 'refuse' && disc('drive/v2/teamdrives')?.kind === 'refuse');
check('v2 drives list → refused (v2 shape is not filtered)', disc('drive/v2/drives')?.kind === 'refuse');
check('an unknown Drive GET endpoint fails closed → refused', disc('drive/v3/somethingNew')?.kind === 'refuse');
check('drive/v3/drives → filtered shared-drive listing', disc('drive/v3/drives?pageSize=10')?.kind === 'filter_drives');
check('drive/v3/drives/{id} → gated on that shared drive', (() => { const d = disc('drive/v3/drives/drv1'); return d?.kind === 'shared_drive' && d.driveId === 'drv1'; })());
check('about / startPageToken / apps / generateIds → allowed as is',
  ['drive/v3/about?fields=user', 'drive/v2/about', 'drive/v3/changes/startPageToken', 'drive/v2/changes/startPageToken', 'drive/v3/apps', 'drive/v3/files/generateIds?count=3', 'drive/v2/files/generateIds']
    .every(p => disc(p)?.kind === 'allow'));
check('id-addressed file calls are not discovery (gated per file elsewhere)',
  ['drive/v3/files/abc', 'drive/v3/files/abc/export?mimeType=text/plain', 'drive/v2/files/abc', 'drive/v2/files/abc?alt=media', 'drive/v2/files/abc/parents', 'drive/v3/files//abc']
    .every(p => disc(p) === null));
check('writes other than changes/watch are not discovery', disc('drive/v3/files', 'POST') === null && disc('drive/v3/drives', 'POST') === null && disc('drive/v3/files/abc', 'PATCH') === null);
check('non-Drive paths are not discovery', disc('gmail/v1/users/me/messages') === null && disc('v4/spreadsheets/abc') === null);
check('bare v3/files spelling is classified like drive/v3/files', disc('v3/files/')?.kind === 'filter_files' && disc('v3/changes')?.kind === 'refuse');
check('upload/drive paths are not discovery reads', disc('upload/drive/v3/files?uploadType=media', 'POST') === null);
const refusal = disc('drive/v3/changes');
check('the refusal names the endpoint and points at drive/v3/files', refusal?.kind === 'refuse' && /drive\/v3\/changes/.test(driveDiscoveryRefusal(refusal.endpoint)) && /drive\/v3\/files/.test(driveDiscoveryRefusal(refusal.endpoint)));
const childRefusal = disc('drive/v2/files/folder123/children');
check('the children refusal suggests the in-parents query', childRefusal?.kind === 'refuse' && /in parents/.test(driveDiscoveryRefusal(childRefusal.endpoint)));

console.log('shared-drive filtering:');
const blockDrv = settingsFromRules([{ id: 'x', service: 'drive', actionType: 'drive_block', targetResourceId: 'drvB', targetKind: 'shared_drive' }]);
check('a Blocked shared drive resolves to block', sharedDriveAccess('drvB', 'Legal', blockDrv, 'read') === 'block');
check('an unset shared drive follows the default', sharedDriveAccess('drvA', 'Eng', blockDrv, 'read') === 'read' && sharedDriveAccess('drvA', 'Eng', blockDrv, 'explicit') === 'block');
const blockAllDrives = settingsFromRules([{ id: 'y', service: 'drive', actionType: 'drive_block', targetResourceId: SHARED_DRIVES_ID, targetKind: 'shared_drives' }]);
check('Blocked "Shared drives" pseudo-root blocks every shared drive', sharedDriveAccess('drvA', 'Eng', blockAllDrives, 'write') === 'block');
const drivesPage = filterSharedDrives({ kind: 'drive#driveList', drives: [{ id: 'drvA', name: 'Eng' }, { id: 'drvB', name: 'Legal' }, { name: 'no id' }] }, blockDrv, 'read');
check('drives.list withholds Blocked (and unidentifiable) drives and counts them',
  drivesPage.drives.length === 1 && drivesPage.drives[0].id === 'drvA' && drivesPage.withheld === 2 && drivesPage.kind === 'drive#driveList');

console.log('route wiring (both surfaces use the shared discovery classifier):');
{
  const mcp = readFileSync(join(__dirname, '..', 'src', 'app', 'api', 'mcp', 'route.ts'), 'utf8');
  const proxy = readFileSync(join(__dirname, '..', 'src', 'app', 'api', 'proxy', '[...path]', 'route.ts'), 'utf8');
  check('MCP route calls classifyDriveDiscovery', /classifyDriveDiscovery\(/.test(mcp));
  check('MCP route no longer matches the listing with an exact-path regex', !/\/\^drive\\\/v3\\\/files\(\\\?\|\$\)\//.test(mcp));
  check('REST proxy calls classifyDriveDiscovery', /classifyDriveDiscovery\(/.test(proxy));
  check('REST proxy no longer has the exact-path isDriveListPath', !/isDriveListPath/.test(proxy));
  check('REST proxy builds the engine for every drive/ path, not only drive/v[23]/files',
    !/const drivePath = \/\^drive\\\/v\[23\]\\\/files\//.test(proxy));
}

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
