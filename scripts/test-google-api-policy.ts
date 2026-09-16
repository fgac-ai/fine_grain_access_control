/**
 * Unit tests for the raw Google API classification policy
 * (src/app/api/mcp/googleApiPolicy.ts). Run: npx tsx scripts/test-google-api-policy.ts
 */
import {
  classifyGoogleApiCall, canonicalizeGoogleApiPath, extractSendRecipients, extractDraftSendInfo,
  collectLabelIds, sheetsApprovalAction, docsApprovalAction, extractDocsDocumentId,
  templateGoogleApiPath, rawApiFamily, extractGoogleErrorReason,
} from '../src/app/api/mcp/googleApiPolicy';

let failures = 0;
function expect(name: string, actual: unknown, predicate: (v: never) => boolean) {
  if (!predicate(actual as never)) {
    failures++;
    console.error(`  ✗ ${name} — got: ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

console.log('classifyGoogleApiCall:');
expect('gmail GET list → gmail_read',
  classifyGoogleApiCall('gmail/v1/users/me/messages?maxResults=5', 'GET'),
  (c: { kind: string }) => c.kind === 'gmail_read');
expect('gmail GET message → gmail_read',
  classifyGoogleApiCall('/gmail/v1/users/me/messages/abc123', 'GET'),
  (c: { kind: string }) => c.kind === 'gmail_read');
expect('gmail send POST → gmail_send',
  classifyGoogleApiCall('gmail/v1/users/me/messages/send', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_send');
expect('gmail send with query → gmail_send',
  classifyGoogleApiCall('gmail/v1/users/me/messages/send?alt=json', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_send');
// ── Gmail writes: allow-by-default (2026-08-30 posture change) ──
expect('gmail message modify POST → gmail_write (archive/mark-read allowed)',
  classifyGoogleApiCall('gmail/v1/users/me/messages/abc/modify', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail trash POST → gmail_write (reversible, allowed)',
  classifyGoogleApiCall('gmail/v1/users/me/messages/abc/trash', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail untrash POST → gmail_write',
  classifyGoogleApiCall('gmail/v1/users/me/messages/abc/untrash', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail draft create POST → gmail_write',
  classifyGoogleApiCall('gmail/v1/users/me/drafts', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail draft update PUT → gmail_write',
  classifyGoogleApiCall('gmail/v1/users/me/drafts/r123abc', 'PUT'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail label create POST → gmail_write',
  classifyGoogleApiCall('gmail/v1/users/me/labels', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail label update PATCH → gmail_write',
  classifyGoogleApiCall('gmail/v1/users/me/labels/Label_7', 'PATCH'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail thread modify POST → gmail_write',
  classifyGoogleApiCall('gmail/v1/users/me/threads/abc/modify', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail batchModify POST → gmail_write (bulk labels are NOT an HTTP batch endpoint)',
  classifyGoogleApiCall('gmail/v1/users/me/messages/batchModify', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail messages insert POST → gmail_write (writes to own mailbox, delivers nothing)',
  classifyGoogleApiCall('gmail/v1/users/me/messages/insert', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail messages import POST → gmail_write',
  classifyGoogleApiCall('gmail/v1/users/me/messages/import', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('gmail drafts/send POST → gmail_draft_send (whitelist via server-side draft fetch)',
  classifyGoogleApiCall('gmail/v1/users/me/drafts/send', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_draft_send');
expect('gmail batchDelete POST → denied (permanent deletion, honest reason)',
  classifyGoogleApiCall('gmail/v1/users/me/messages/batchDelete', 'POST'),
  (c: { kind: string; code?: string; family?: string; reason?: string }) =>
    c.kind === 'denied' && c.code === 'gmail_write_unsupported' && c.family === 'gmail' &&
    !!c.reason && /permanent/i.test(c.reason) && c.reason.includes('trash'));
expect('gmail settings sendAs PATCH → denied with honest scope reason (not a policy denial)',
  classifyGoogleApiCall('gmail/v1/users/me/settings/sendAs/alias@example.com', 'PATCH'),
  (c: { kind: string; code?: string; family?: string; reason?: string }) =>
    c.kind === 'denied' && c.code === 'gmail_settings_unsupported' && c.family === 'gmail' &&
    !!c.reason && c.reason.includes('gmail.settings') && /scope/i.test(c.reason));
expect('gmail settings forwarding POST → denied (scope, same code)',
  classifyGoogleApiCall('gmail/v1/users/me/settings/forwardingAddresses', 'POST'),
  (c: { kind: string; code?: string }) => c.kind === 'denied' && c.code === 'gmail_settings_unsupported');
expect('gmail settings READ stays gmail_read (gmail.modify covers settings reads)',
  classifyGoogleApiCall('gmail/v1/users/me/settings/sendAs', 'GET'),
  (c: { kind: string }) => c.kind === 'gmail_read');
expect('upload-variant messages/send → gmail_send (whitelist, not passthrough bypass)',
  classifyGoogleApiCall('upload/gmail/v1/users/me/messages/send', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_send');
expect('upload-variant drafts create → gmail_write',
  classifyGoogleApiCall('upload/gmail/v1/users/me/drafts', 'POST'),
  (c: { kind: string }) => c.kind === 'gmail_write');
expect('sheets GET values → sheets read',
  classifyGoogleApiCall('v4/spreadsheets/1BxiM/values/Sheet1', 'GET'),
  (c: { kind: string; spreadsheetId?: string; isMutating?: boolean }) =>
    c.kind === 'sheets' && c.spreadsheetId === '1BxiM' && c.isMutating === false);
expect('sheets append POST → sheets write',
  classifyGoogleApiCall('sheets/v4/spreadsheets/1BxiM/values/Sheet1:append', 'POST'),
  (c: { kind: string; isMutating?: boolean }) => c.kind === 'sheets' && c.isMutating === true);
expect('sheets create (no id) POST → sheets_create (2026-08-19: creation allowed, auto-granted)',
  classifyGoogleApiCall('v4/spreadsheets', 'POST'),
  (c: { kind: string }) => c.kind === 'sheets_create');
expect('sheets no-id GET → passthrough (Google rejects it, not us)',
  classifyGoogleApiCall('v4/spreadsheets', 'GET'),
  (c: { kind: string; family?: string }) => c.kind === 'passthrough' && c.family === 'spreadsheets');
expect('batch endpoint → denied',
  classifyGoogleApiCall('batch/gmail/v1', 'POST'),
  (c: { kind: string }) => c.kind === 'denied');
expect('docs GET document → docs read',
  classifyGoogleApiCall('v1/documents/1AbCdoc', 'GET'),
  (c: { kind: string; documentId?: string; isMutating?: boolean }) =>
    c.kind === 'docs' && c.documentId === '1AbCdoc' && c.isMutating === false);
expect('docs GET with docs/ prefix → docs read',
  classifyGoogleApiCall('docs/v1/documents/1AbCdoc?fields=title', 'GET'),
  (c: { kind: string; documentId?: string }) => c.kind === 'docs' && c.documentId === '1AbCdoc');
expect('docs batchUpdate POST → docs write (verb suffix not part of id)',
  classifyGoogleApiCall('v1/documents/1AbCdoc:batchUpdate', 'POST'),
  (c: { kind: string; documentId?: string; isMutating?: boolean }) =>
    c.kind === 'docs' && c.documentId === '1AbCdoc' && c.isMutating === true);
expect('docs create (no id) POST → docs_create (auto-granted, mirrors sheets_create)',
  classifyGoogleApiCall('v1/documents', 'POST'),
  (c: { kind: string }) => c.kind === 'docs_create');
expect('docs no-id GET → passthrough (Google rejects it, not us)',
  classifyGoogleApiCall('v1/documents', 'GET'),
  (c: { kind: string; family?: string }) => c.kind === 'passthrough' && c.family === 'documents');

console.log('extractDocsDocumentId:');
expect('plain path', extractDocsDocumentId('v1/documents/1AbC_x-9'), (id: string | null) => id === '1AbC_x-9');
expect('batchUpdate verb excluded', extractDocsDocumentId('v1/documents/1AbC:batchUpdate'), (id: string | null) => id === '1AbC');
expect('no id → null', extractDocsDocumentId('v1/documents'), (id: string | null) => id === null);

expect('unknown API (drive) → passthrough with family (classify, not block)',
  classifyGoogleApiCall('drive/v3/files', 'GET'),
  (c: { kind: string; family?: string }) => c.kind === 'passthrough' && c.family === 'drive/v3');
expect('drive media upload POST → drive_create (upload/ prefix normalized; app-owned file, auto-granted)',
  classifyGoogleApiCall('upload/drive/v3/files?uploadType=media', 'POST'),
  (c: { kind: string }) => c.kind === 'drive_create');
// ── Drive-side creates (2026-09-16): copies and Drive creates are app-owned
// under drive.file exactly like POST v4/spreadsheets, so they classify as
// their own kinds for source gating + auto-grant instead of passthrough ──
expect('drive files/{id}/copy POST → drive_copy with source id',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/copy', 'POST'),
  (c: { kind: string; fileId?: string }) => c.kind === 'drive_copy' && c.fileId === '1BxiM2doc-ID_x');
expect('bare-spelling copy (v3/files/{id}/copy) → drive_copy',
  classifyGoogleApiCall('v3/files/1BxiM2doc-ID_x/copy?fields=id,name,mimeType', 'POST'),
  (c: { kind: string; fileId?: string }) => c.kind === 'drive_copy' && c.fileId === '1BxiM2doc-ID_x');
expect('drive files POST (metadata create) → drive_create',
  classifyGoogleApiCall('drive/v3/files', 'POST'),
  (c: { kind: string }) => c.kind === 'drive_create');
expect('drive files POST with query → drive_create',
  classifyGoogleApiCall('drive/v3/files?supportsAllDrives=true', 'POST'),
  (c: { kind: string }) => c.kind === 'drive_create');
expect('drive files GET (list) stays passthrough — discovery is never gated',
  classifyGoogleApiCall('drive/v3/files?q=name+contains+%27x%27', 'GET'),
  (c: { kind: string; family?: string }) => c.kind === 'passthrough' && c.family === 'drive/v3');
// ── Id-addressed Drive file calls (mcp-drive-perfile-guard, 2026-09-16): a
// Blocked spreadsheet could be trashed via PATCH {trashed:true} while these
// were passthrough. Every call naming ONE file by id is drive_file so the
// route can run the per-file guard the REST proxy has always had. ──
expect('drive file PATCH (rename/trash) → drive_file mutating with id',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x', 'PATCH'),
  (c: { kind: string; fileId?: string; isMutating?: boolean }) => c.kind === 'drive_file' && c.fileId === '1BxiM2doc-ID_x' && c.isMutating === true);
expect('drive permissions POST (share) → drive_file mutating',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/permissions', 'POST'),
  (c: { kind: string; fileId?: string; isMutating?: boolean }) => c.kind === 'drive_file' && c.fileId === '1BxiM2doc-ID_x' && c.isMutating === true);
expect('drive permissions/{permId} GET → drive_file read',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/permissions/anyoneWithLink', 'GET'),
  (c: { kind: string; isMutating?: boolean }) => c.kind === 'drive_file' && c.isMutating === false);
expect('drive revisions GET → drive_file read',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/revisions', 'GET'),
  (c: { kind: string; fileId?: string }) => c.kind === 'drive_file' && c.fileId === '1BxiM2doc-ID_x');
expect('drive export GET with query → drive_file read',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/export?mimeType=text/csv', 'GET'),
  (c: { kind: string; isMutating?: boolean }) => c.kind === 'drive_file' && c.isMutating === false);
expect('drive watch POST → drive_file mutating',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/watch', 'POST'),
  (c: { kind: string; isMutating?: boolean }) => c.kind === 'drive_file' && c.isMutating === true);
expect('drive media content update (upload/…/files/{id} PATCH) → drive_file',
  classifyGoogleApiCall('upload/drive/v3/files/1BxiM2doc-ID_x?uploadType=media', 'PATCH'),
  (c: { kind: string; fileId?: string }) => c.kind === 'drive_file' && c.fileId === '1BxiM2doc-ID_x');
expect('url-encoded file id is decoded',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc%2DID_x', 'GET'),
  (c: { kind: string; fileId?: string }) => c.kind === 'drive_file' && c.fileId === '1BxiM2doc-ID_x');
expect('drive files/generateIds GET stays passthrough — discovery is never gated',
  classifyGoogleApiCall('drive/v3/files/generateIds?count=5', 'GET'),
  (c: { kind: string; family?: string }) => c.kind === 'passthrough' && c.family === 'drive/v3');
expect('drive files list with query stays passthrough',
  classifyGoogleApiCall('drive/v3/files?q=name%20contains%20%27x%27&pageSize=10', 'GET'),
  (c: { kind: string; family?: string }) => c.kind === 'passthrough' && c.family === 'drive/v3');
expect('drive about/changes/drives stay passthrough (not file-addressed)',
  [classifyGoogleApiCall('drive/v3/about?fields=user', 'GET'), classifyGoogleApiCall('drive/v3/changes/startPageToken', 'GET'), classifyGoogleApiCall('drive/v3/drives', 'GET')],
  (cs: Array<{ kind: string }>) => cs.every(c => c.kind === 'passthrough'));
expect('copy still wins over drive_file (more specific)',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/copy', 'POST'),
  (c: { kind: string }) => c.kind === 'drive_copy');
expect('comments still win over drive_file',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/comments', 'GET'),
  (c: { kind: string }) => c.kind === 'file_comments');
expect('drive copy template keeps the verb: {id}/copy',
  templateGoogleApiPath('drive/v3/files/1BxiM2doc-ID_x/copy'),
  (t: string) => t === 'drive/v3/files/{id}/copy');
expect('drive comments GET → file_comments (per-file rule, not passthrough)',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/comments?fields=comments', 'GET'),
  (c: { kind: string; fileId?: string; isMutating?: boolean }) =>
    c.kind === 'file_comments' && c.fileId === '1BxiM2doc-ID_x' && c.isMutating === false);
expect('drive comments POST → file_comments mutating',
  classifyGoogleApiCall('/drive/v3/files/1BxiM2doc-ID_x/comments', 'POST'),
  (c: { kind: string; isMutating?: boolean }) => c.kind === 'file_comments' && c.isMutating === true);
expect('drive comment replies POST → file_comments mutating',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/comments/AAAAc1/replies', 'POST'),
  (c: { kind: string; fileId?: string; isMutating?: boolean }) =>
    c.kind === 'file_comments' && c.fileId === '1BxiM2doc-ID_x' && c.isMutating === true);
expect('drive file metadata GET → drive_file read (no comments segment)',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x?fields=name', 'GET'),
  (c: { kind: string; fileId?: string; isMutating?: boolean }) => c.kind === 'drive_file' && c.fileId === '1BxiM2doc-ID_x' && c.isMutating === false);
// ── Bare Drive spelling (`v3/files/…`, observed 2026-08-31): canonicalized so
// classification, comments enforcement, and routing all see `drive/v3/…` ──
expect('bare-spelling comments POST (v3/files/…/comments) → file_comments, not passthrough',
  classifyGoogleApiCall('v3/files/1BxiM2doc-ID_x/comments', 'POST'),
  (c: { kind: string; fileId?: string; isMutating?: boolean }) =>
    c.kind === 'file_comments' && c.fileId === '1BxiM2doc-ID_x' && c.isMutating === true);
expect('bare-spelling file PATCH (v3/files/{id}) → drive_file (canonicalized)',
  classifyGoogleApiCall('v3/files/1BxiM2doc-ID_x', 'PATCH'),
  (c: { kind: string; fileId?: string }) => c.kind === 'drive_file' && c.fileId === '1BxiM2doc-ID_x');

// ── Method gate: deletion is a product guarantee, enforced here independently
// of the tool schema (scripts/test-raw-method-guard.ts pins every layer). ──
expect('DELETE on a Drive file → denied raw_api_method_unsupported (permanent deletion)',
  classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x', 'DELETE'),
  (c: { kind: string; code?: string; reason?: string }) => c.kind === 'denied' && c.code === 'raw_api_method_unsupported' && /DELETE is never available/.test(c.reason ?? ''));
expect('DELETE files/trash (emptyTrash) → denied before any path logic',
  classifyGoogleApiCall('drive/v3/files/trash', 'DELETE'),
  (c: { kind: string; code?: string }) => c.kind === 'denied' && c.code === 'raw_api_method_unsupported');
expect('lowercase delete → denied (exact-case set, like the zod enum)',
  classifyGoogleApiCall('gmail/v1/users/me/messages/abc', 'delete'),
  (c: { kind: string; code?: string }) => c.kind === 'denied' && c.code === 'raw_api_method_unsupported');
expect('HEAD/OPTIONS → denied (not forwarded)',
  [classifyGoogleApiCall('drive/v3/files', 'HEAD'), classifyGoogleApiCall('drive/v3/files', 'OPTIONS')],
  (cs: Array<{ kind: string; code?: string }>) => cs.every(c => c.kind === 'denied' && c.code === 'raw_api_method_unsupported'));
expect('method-denied has null family (denial_code identifies it)',
  rawApiFamily(classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x', 'DELETE')),
  (f: string | null) => f === null);
expect('un-granted API (calendar) → denied unsupported (no calendar scope in the grant)',
  classifyGoogleApiCall('calendar/v3/calendars/primary/events', 'GET'),
  (c: { kind: string; code?: string; family?: string }) =>
    c.kind === 'denied' && c.code === 'raw_api_family_unsupported' && c.family === 'calendar');
expect('un-granted API (people) → denied unsupported',
  classifyGoogleApiCall('people/v1/people:createContact', 'POST'),
  (c: { kind: string; code?: string; family?: string }) =>
    c.kind === 'denied' && c.code === 'raw_api_family_unsupported' && c.family === 'people');
expect('people path-variant retry spelling (v1/people:createContact) → same denial',
  classifyGoogleApiCall('v1/people:createContact', 'POST'),
  (c: { kind: string; code?: string; family?: string }) =>
    c.kind === 'denied' && c.code === 'raw_api_family_unsupported' && c.family === 'people');
expect('un-granted API (tasks) → denied unsupported',
  classifyGoogleApiCall('tasks/v1/lists', 'GET'),
  (c: { kind: string; code?: string }) => c.kind === 'denied' && c.code === 'raw_api_family_unsupported');
expect('unsupported denial reason names the grant surface and says stop',
  classifyGoogleApiCall('people/v1/people:createContact', 'POST'),
  (c: { kind: string; reason?: string }) =>
    c.kind === 'denied' && !!c.reason && c.reason.startsWith('🚫') &&
    c.reason.includes('Gmail') && c.reason.includes('Drive') && c.reason.includes('STOP'));
expect('slides create → passthrough family slides (routed to slides.googleapis.com)',
  classifyGoogleApiCall('slides/v1/presentations', 'POST'),
  (c: { kind: string; family?: string; isMutating?: boolean }) =>
    c.kind === 'passthrough' && c.family === 'slides' && c.isMutating === true);
expect('slides bare-version retry spelling (v1/presentations) → same classification',
  classifyGoogleApiCall('v1/presentations', 'POST'),
  (c: { kind: string; family?: string }) => c.kind === 'passthrough' && c.family === 'slides');
expect('slides read with id → passthrough family slides',
  classifyGoogleApiCall('slides/v1/presentations/1AbCpres?fields=title', 'GET'),
  (c: { kind: string; family?: string; isMutating?: boolean }) =>
    c.kind === 'passthrough' && c.family === 'slides' && c.isMutating === false);
expect('slides batchUpdate verb suffix → passthrough family slides',
  classifyGoogleApiCall('v1/presentations/1AbCpres:batchUpdate', 'POST'),
  (c: { kind: string; family?: string }) => c.kind === 'passthrough' && c.family === 'slides');

console.log('extractSendRecipients:');
const raw = Buffer.from(
  'To: alice@example.com\r\nCc: Bob <bob@example.org>\r\nSubject: hi\r\n\r\nBody mentions carol@nowhere.test',
).toString('base64url');
expect('parses To and Cc, ignores body',
  extractSendRecipients({ raw }),
  (r: string[] | null) => !!r && r.length === 2 && r.includes('alice@example.com') && r.includes('bob@example.org'));
expect('JSON string body works',
  extractSendRecipients(JSON.stringify({ raw })),
  (r: string[] | null) => !!r && r.includes('alice@example.com'));
expect('missing raw → null', extractSendRecipients({ foo: 1 }), (r: unknown) => r === null);
expect('garbage → null', extractSendRecipients('not json'), (r: unknown) => r === null);
const foldedRaw = Buffer.from(
  'To: alice@example.com,\r\n bob@example.org\r\nSubject: folded\r\n\r\nx',
).toString('base64url');
expect('unfolds continuation lines',
  extractSendRecipients({ raw: foldedRaw }),
  (r: string[] | null) => !!r && r.includes('bob@example.org'));

console.log('extractDraftSendInfo:');
expect('draft id alone',
  extractDraftSendInfo({ id: 'r-draft123' }),
  (d: { draftId: string | null; bodyRecipients: string[] | null }) =>
    d.draftId === 'r-draft123' && d.bodyRecipients === null);
expect('JSON string body works',
  extractDraftSendInfo(JSON.stringify({ id: 'r-draft123' })),
  (d: { draftId: string | null }) => d.draftId === 'r-draft123');
expect('inline message.raw recipients parsed (update-while-sending)',
  extractDraftSendInfo({ id: 'r1', message: { raw } }),
  (d: { draftId: string | null; bodyRecipients: string[] | null }) =>
    d.draftId === 'r1' && !!d.bodyRecipients && d.bodyRecipients.includes('alice@example.com'));
expect('missing id → null draftId (route denies, never forwards blind)',
  extractDraftSendInfo({ message: { raw } }),
  (d: { draftId: string | null }) => d.draftId === null);
expect('garbage body → nulls',
  extractDraftSendInfo('not json'),
  (d: { draftId: string | null; bodyRecipients: string[] | null }) =>
    d.draftId === null && d.bodyRecipients === null);

console.log('collectLabelIds:');
expect('top-level labels',
  collectLabelIds({ labelIds: ['INBOX', 'SECRET'] }),
  (l: string[]) => l.includes('SECRET'));
expect('nested thread messages',
  collectLabelIds({ messages: [{ labelIds: ['INBOX'] }, { labelIds: ['SECRET'] }] }),
  (l: string[]) => l.includes('SECRET') && l.includes('INBOX'));
expect('no labels → empty', collectLabelIds({ messages: [{ id: 'a' }] }), (l: string[]) => l.length === 0);

console.log('sheetsApprovalAction (denial -> approval action matrix):');
// Regression (tester finding 2026-08-15): a WRITE denied on an unexposed
// sheet must mint a write-level token — a read-only exposure under-grants
// and traps the user in an approve/retry/fail loop.
expect('read on unexposed -> sheets_expose',
  sheetsApprovalAction('not_exposed', 'ss1', false),
  (a: { action: string } | null) => a?.action === 'sheets_expose');
expect('WRITE on unexposed -> sheets_write',
  sheetsApprovalAction('not_exposed', 'ss1', true),
  (a: { action: string } | null) => a?.action === 'sheets_write');
expect('write on read-only -> sheets_write',
  sheetsApprovalAction('read_only', 'ss1', true),
  (a: { action: string } | null) => a?.action === 'sheets_write');
expect('blocked mints nothing (read)',
  sheetsApprovalAction('blocked', 'ss1', false), (a: unknown) => a === null);
expect('blocked mints nothing (write)',
  sheetsApprovalAction('blocked', 'ss1', true), (a: unknown) => a === null);
expect('spreadsheetId carried through',
  sheetsApprovalAction('not_exposed', 'ss-42', true),
  (a: { spreadsheetId?: string } | null) => a?.spreadsheetId === 'ss-42');

console.log('docsApprovalAction (same matrix as sheets):');
expect('read on unexposed -> docs_expose',
  docsApprovalAction('not_exposed', 'doc1', false),
  (a: { action: string } | null) => a?.action === 'docs_expose');
expect('WRITE on unexposed -> docs_write',
  docsApprovalAction('not_exposed', 'doc1', true),
  (a: { action: string } | null) => a?.action === 'docs_write');
expect('write on read-only -> docs_write',
  docsApprovalAction('read_only', 'doc1', true),
  (a: { action: string } | null) => a?.action === 'docs_write');
expect('blocked mints nothing (read)',
  docsApprovalAction('blocked', 'doc1', false), (a: unknown) => a === null);
expect('blocked mints nothing (write)',
  docsApprovalAction('blocked', 'doc1', true), (a: unknown) => a === null);
expect('documentId carried through',
  docsApprovalAction('not_exposed', 'doc-42', true),
  (a: { documentId?: string } | null) => a?.documentId === 'doc-42');

console.log('templateGoogleApiPath:');
expect('gmail message id → {id}',
  templateGoogleApiPath('gmail/v1/users/me/messages/18c8f2ab91d004a7'),
  (t: string) => t === 'gmail/v1/users/me/messages/{id}');
expect('gmail list (no id) unchanged, query stripped',
  templateGoogleApiPath('gmail/v1/users/me/messages?maxResults=5&q=foo'),
  (t: string) => t === 'gmail/v1/users/me/messages');
expect('gmail attachment id → {id} (both parents)',
  templateGoogleApiPath('/gmail/v1/users/me/messages/18c8f2ab91/attachments/ANGjdJ8w9TfWQzvvMbwFxyz'),
  (t: string) => t === 'gmail/v1/users/me/messages/{id}/attachments/{id}');
expect('gmail user email → {id} (email heuristic)',
  templateGoogleApiPath('gmail/v1/users/someone@example.com/labels'),
  (t: string) => t === 'gmail/v1/users/{id}/labels');
expect('sheets values range with verb → {range}:append',
  templateGoogleApiPath('v4/spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/values/Sheet1!A1:B2:append'),
  (t: string) => t === 'v4/spreadsheets/{id}/values/{range}:append');
expect('sheets column-only range (A:B) fully replaced',
  templateGoogleApiPath('v4/spreadsheets/1BxiM/values/A:B'),
  (t: string) => t === 'v4/spreadsheets/{id}/values/{range}');
expect('sheets %-encoded range → {range}',
  templateGoogleApiPath('v4/spreadsheets/1BxiM/values/Sheet1%21A1%3AB5'),
  (t: string) => t === 'v4/spreadsheets/{id}/values/{range}');
expect('docs batchUpdate keeps verb',
  templateGoogleApiPath('v1/documents/1a2B3c4D5e6F:batchUpdate'),
  (t: string) => t === 'v1/documents/{id}:batchUpdate');
expect('drive file id → {id}',
  templateGoogleApiPath('drive/v3/files/1a2B3c4D5e6F7g8H'),
  (t: string) => t === 'drive/v3/files/{id}');
expect('calendar event under named calendar → {id}s',
  templateGoogleApiPath('calendar/v3/calendars/primary/events/abc123def456'),
  (t: string) => t === 'calendar/v3/calendars/{id}/events/{id}');
expect('short literal segments survive (me, v4, about)',
  templateGoogleApiPath('drive/v3/about'),
  (t: string) => t === 'drive/v3/about');
expect('messages/send is a literal subresource, not an id',
  templateGoogleApiPath('gmail/v1/users/me/messages/send'),
  (t: string) => t === 'gmail/v1/users/me/messages/send');
expect('messages/batchModify is a literal subresource, not an id',
  templateGoogleApiPath('gmail/v1/users/me/messages/batchModify'),
  (t: string) => t === 'gmail/v1/users/me/messages/batchModify');
expect('messages/import is a literal subresource, not an id',
  templateGoogleApiPath('gmail/v1/users/me/messages/import'),
  (t: string) => t === 'gmail/v1/users/me/messages/import');
expect('message trash keeps id-strip + literal verb tail',
  templateGoogleApiPath('gmail/v1/users/me/messages/18c8f2ab91d004a7/trash'),
  (t: string) => t === 'gmail/v1/users/me/messages/{id}/trash');
expect('bare drive spelling canonicalized in the endpoint template (one analytics spelling)',
  templateGoogleApiPath('v3/files/1BxiM2doc-ID_x/comments'),
  (t: string) => t === 'drive/v3/files/{id}/comments');

console.log('canonicalizeGoogleApiPath:');
expect('bare v3/files gains the drive/ prefix',
  canonicalizeGoogleApiPath('v3/files/1Abc/comments'),
  (p: string) => p === 'drive/v3/files/1Abc/comments');
expect('leading slash stripped, query preserved',
  canonicalizeGoogleApiPath('/v3/files?q=name'),
  (p: string) => p === 'drive/v3/files?q=name');
expect('idempotent on the canonical spelling',
  canonicalizeGoogleApiPath('drive/v3/files/1Abc'),
  (p: string) => p === 'drive/v3/files/1Abc');
expect('sheets bare spelling untouched (v4/spreadsheets is served as-is)',
  canonicalizeGoogleApiPath('v4/spreadsheets/1Abc/values/A1:B2'),
  (p: string) => p === 'v4/spreadsheets/1Abc/values/A1:B2');
expect('docs bare spelling untouched',
  canonicalizeGoogleApiPath('v1/documents'),
  (p: string) => p === 'v1/documents');
expect('segment boundary respected (v3/filesystems is not drive)',
  canonicalizeGoogleApiPath('v3/filesystems/abc'),
  (p: string) => p === 'v3/filesystems/abc');
expect('drive v2 bare spelling also canonicalized',
  canonicalizeGoogleApiPath('v2/files/1Abc'),
  (p: string) => p === 'drive/v2/files/1Abc');

console.log('extractGoogleErrorReason:');
expect('legacy errors[] shape (Gmail/Drive)',
  extractGoogleErrorReason({ error: { errors: [{ reason: 'rateLimitExceeded', domain: 'usageLimits' }], code: 403 } }),
  (r: { reason?: string; domain?: string }) => r.reason === 'rateLimitExceeded' && r.domain === 'usageLimits');
expect('gRPC details[] ErrorInfo shape (Sheets/Docs/Slides/People)',
  extractGoogleErrorReason({ error: {
    code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com' },
    ],
  } }),
  (r: { reason?: string; domain?: string; status?: string }) =>
    r.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' && r.domain === 'googleapis.com' && r.status === 'PERMISSION_DENIED');
expect('gRPC shape with non-ErrorInfo details first (skipped until reason found)',
  extractGoogleErrorReason({ error: {
    code: 404, status: 'NOT_FOUND',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
      { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'notFound' },
    ],
  } }),
  (r: { reason?: string; status?: string }) => r.reason === 'notFound' && r.status === 'NOT_FOUND');
expect('status-only body (no reason anywhere) keeps status',
  extractGoogleErrorReason({ error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } }),
  (r: { reason?: string; status?: string }) => r.reason === undefined && r.status === 'NOT_FOUND');
expect('legacy errors[] wins over details[] when both present',
  extractGoogleErrorReason({ error: {
    errors: [{ reason: 'legacyReason', domain: 'legacyDomain' }],
    details: [{ reason: 'detailsReason', domain: 'detailsDomain' }],
  } }),
  (r: { reason?: string; domain?: string }) => r.reason === 'legacyReason' && r.domain === 'legacyDomain');
expect('non-object body → empty',
  extractGoogleErrorReason('Not Found'),
  (r: object) => Object.keys(r).length === 0);

console.log('rawApiFamily:');
expect('sheets kind → spreadsheets',
  rawApiFamily(classifyGoogleApiCall('v4/spreadsheets/1BxiM/values/A1', 'GET')),
  (f: string | null) => f === 'spreadsheets');
expect('sheets_create → spreadsheets',
  rawApiFamily(classifyGoogleApiCall('v4/spreadsheets', 'POST')),
  (f: string | null) => f === 'spreadsheets');
expect('docs kind → documents',
  rawApiFamily(classifyGoogleApiCall('v1/documents/d1', 'GET')),
  (f: string | null) => f === 'documents');
expect('drive_copy → drive/v3',
  rawApiFamily(classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/copy', 'POST')),
  (f: string | null) => f === 'drive/v3');
expect('drive_create → drive/v3',
  rawApiFamily(classifyGoogleApiCall('drive/v3/files', 'POST')),
  (f: string | null) => f === 'drive/v3');
expect('drive_file → drive/v3',
  rawApiFamily(classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x', 'PATCH')),
  (f: string | null) => f === 'drive/v3');
expect('gmail read → gmail',
  rawApiFamily(classifyGoogleApiCall('gmail/v1/users/me/messages', 'GET')),
  (f: string | null) => f === 'gmail');
expect('gmail send → gmail',
  rawApiFamily(classifyGoogleApiCall('gmail/v1/users/me/messages/send', 'POST')),
  (f: string | null) => f === 'gmail');
expect('file_comments family → drive_comments',
  rawApiFamily(classifyGoogleApiCall('drive/v3/files/1BxiM2doc-ID_x/comments', 'POST')),
  (f: string | null) => f === 'drive_comments');
expect('passthrough carries classifier family',
  rawApiFamily(classifyGoogleApiCall('drive/v3/about', 'GET')),
  (f: string | null) => f === 'drive/v3');
expect('slides passthrough → slides',
  rawApiFamily(classifyGoogleApiCall('slides/v1/presentations', 'POST')),
  (f: string | null) => f === 'slides');
expect('batch denied → null (denial_code identifies it)',
  rawApiFamily(classifyGoogleApiCall('batch/gmail/v1', 'POST')),
  (f: string | null) => f === null);
expect('family-unsupported denied keeps family visible (per-family demand analytics)',
  rawApiFamily(classifyGoogleApiCall('people/v1/people:createContact', 'POST')),
  (f: string | null) => f === 'people');
expect('gmail_write → gmail (which writes agents use is rule-engine demand signal)',
  rawApiFamily(classifyGoogleApiCall('gmail/v1/users/me/drafts', 'POST')),
  (f: string | null) => f === 'gmail');
expect('gmail_draft_send → gmail',
  rawApiFamily(classifyGoogleApiCall('gmail/v1/users/me/drafts/send', 'POST')),
  (f: string | null) => f === 'gmail');
expect('settings-denied keeps gmail family (settings-scope demand stays visible)',
  rawApiFamily(classifyGoogleApiCall('gmail/v1/users/me/settings/sendAs/x', 'PATCH')),
  (f: string | null) => f === 'gmail');
expect('batchDelete-denied keeps gmail family',
  rawApiFamily(classifyGoogleApiCall('gmail/v1/users/me/messages/batchDelete', 'POST')),
  (f: string | null) => f === 'gmail');

if (failures > 0) {
  console.error(`\n${failures} test(s) FAILED`);
  process.exit(1);
}
console.log('\nAll google-api-policy tests passed.');
