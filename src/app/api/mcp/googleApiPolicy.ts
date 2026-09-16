/**
 * Pure classification + parsing helpers for the raw Google API tools
 * (google_api_get / google_api_modify).
 *
 * Enforced families (Gmail, Sheets, Docs) are mapped onto FGAC rule
 * enforcement; HTTP batch endpoints are refused before any network call.
 * Everything else — Gmail mailbox writes included (2026-08-30 posture change:
 * empower users, don't block them) — is allowed and classified: unknown
 * Google API families pass through with the account's token (2026-08-19
 * posture change: classify usage, don't block it — Google's OAuth scopes are
 * the backstop) and are stamped for analytics. The only Gmail writes still
 * refused are the two that can never be right: permanent deletion
 * (batchDelete — a product guarantee, and legacy mail.google.com grants mean
 * Google would NOT backstop it) and settings writes (they need
 * gmail.settings.* scopes FGAC never requests, so they fail at Google
 * deterministically — the denial names the real cause and stops retry loops).
 *
 * No db/env imports: unit-testable via `npx tsx scripts/test-google-api-policy.ts`.
 */

export type RawCallClass =
  | { kind: 'sheets'; spreadsheetId: string; isMutating: boolean }
  | { kind: 'sheets_create' }
  | { kind: 'docs'; documentId: string; isMutating: boolean }
  | { kind: 'docs_create' }
  | { kind: 'gmail_read' }
  | { kind: 'gmail_send' }
  | { kind: 'gmail_draft_send' }
  | { kind: 'gmail_write' }
  | { kind: 'file_comments'; fileId: string; isMutating: boolean }
  | { kind: 'drive_copy'; fileId: string }
  | { kind: 'drive_create' }
  | { kind: 'drive_file'; fileId: string; isMutating: boolean }
  | { kind: 'passthrough'; family: string; isMutating: boolean }
  | { kind: 'denied'; reason: string; code: DenialCode; family?: string };

/** Machine-readable denial reasons, stamped onto $mcp_tool_call as `denial_code`. */
export type DenialCode =
  | 'raw_api_method_unsupported'
  | 'raw_api_batch_unsupported'
  | 'raw_api_family_unsupported'
  | 'gmail_write_unsupported'
  | 'gmail_settings_unsupported'
  | 'file_id_malformed'
  | 'file_id_wrong_kind';

/**
 * The HTTP methods the raw tools forward, and nothing else. "Deletion is
 * NEVER available through any tool" (get_my_permissions.defaults.deletion) is
 * a product guarantee, and until 2026-09-16 it rested on the `method` zod
 * enum of google_api_modify alone. Google would not backstop a slip: the
 * drive.file grant accepts `files.delete` (permanent, no trash) on every file
 * the app created or the user picked, and `files/trash` (emptyTrash) is
 * DELETE-only. So the method set is defined once here, the tool schema and
 * the tool catalog (`freeformMethods`) derive from it, the classifier refuses
 * anything outside it before any account is resolved, and the executor checks
 * again — a future enum edit cannot silently open deletion
 * (`scripts/test-raw-method-guard.ts` pins all four layers).
 */
export const RAW_READ_METHODS = ['GET'] as const;
export const RAW_MODIFY_METHODS = ['POST', 'PUT', 'PATCH'] as const;
export type RawGoogleMethod = (typeof RAW_READ_METHODS)[number] | (typeof RAW_MODIFY_METHODS)[number];
const FORWARDABLE_GOOGLE_METHODS: ReadonlySet<string> = new Set<string>([...RAW_READ_METHODS, ...RAW_MODIFY_METHODS]);

/** Exact-case check: the zod enum is case-sensitive, and so is this. */
export function isForwardableGoogleMethod(method: string): method is RawGoogleMethod {
  return FORWARDABLE_GOOGLE_METHODS.has(method);
}

/** The refusal every layer returns for a non-forwardable method. */
export function methodDenial(method: string): RawCallClass & { kind: 'denied' } {
  const isDelete = method.toUpperCase() === 'DELETE';
  return {
    kind: 'denied',
    code: 'raw_api_method_unsupported',
    reason: isDelete
      ? '🚫 Access Denied: DELETE is never available through FGAC — permanent deletion is a product guarantee (get_my_permissions: deletion NEVER available). Reversible alternatives are allowed: move Gmail messages to trash (POST …/messages/{id}/trash) and trash Drive files (PATCH drive/v3/files/{id} {"trashed":true}); the user can empty trash in Google directly.'
      : `🚫 Access Denied: HTTP method '${method}' is not forwarded by FGAC. google_api_get forwards GET; google_api_modify forwards ${RAW_MODIFY_METHODS.join(', ')}.`,
  };
}

/**
 * Google API families FGAC's OAuth grant can never authorize. The grant is
 * exactly gmail.modify + drive.file, so these fail at Google no matter how the
 * path is spelled — and because most of them aren't even served from
 * www.googleapis.com, the agent sees a bare routing 404, retries a different
 * path spelling, and fails again (observed: People and Slides probes retried
 * as `v1/…` variants, doubling the public error count). Answering with a 🚫
 * denial names the real cause once and stops the loop. Keyed by the path
 * segment that identifies the family; values are the human API name used in
 * the denial text.
 */
const UNSUPPORTED_GOOGLE_APIS: Record<string, string> = {
  people: 'People (Contacts)',
  contacts: 'Contacts',
  calendar: 'Calendar',
  tasks: 'Tasks',
  youtube: 'YouTube',
  chat: 'Google Chat',
  admin: 'Admin SDK',
  classroom: 'Classroom',
  photoslibrary: 'Photos Library',
  meet: 'Google Meet',
  groups: 'Google Groups',
};

/**
 * Drive is the one enforced-adjacent family whose bare spelling agents use
 * (`v3/files/…`, mirroring Sheets' accepted `v4/spreadsheets` and Docs'
 * `v1/documents`) that Google does NOT serve: Drive lives only under
 * `drive/v3/…` on www.googleapis.com, so the bare spelling routes to a
 * nonexistent path and every call 404s regardless of grants. Observed
 * 2026-08-31: a `v3/files/{id}/comments` probe 404ed, was answered with the
 * per-file-grant explanation (the wrong diagnosis — the URL was bad, not the
 * grant), and succeeded only after the agent guessed the `drive/` prefix —
 * which also skipped the failed attempts' per-file comments classification.
 * Canonicalizing up front makes classification, per-file enforcement, host
 * routing, and the analytics endpoint template all agree on one spelling.
 */
const DRIVE_BARE_PATH = /^v[23]\/(files|drives|about|changes)([/?#:]|$)/i;

export function canonicalizeGoogleApiPath(rawPath: string): string {
  const path = rawPath.replace(/^\/+/, '');
  return DRIVE_BARE_PATH.test(path) ? `drive/${path}` : path;
}

export function extractSheetsSpreadsheetId(path: string): string | null {
  const match = path.match(/(?:v4\/spreadsheets|sheets\/v4\/spreadsheets|spreadsheets)\/([^/?:#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function extractDocsDocumentId(path: string): string | null {
  const match = path.match(/(?:v1\/documents|docs\/v1\/documents|documents)\/([^/?:#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Classify a raw Google API call. `rawPath` is the caller-supplied path
 * (query string allowed); `method` is the HTTP method the tool forwards.
 */
export function classifyGoogleApiCall(rawPath: string, method: string): RawCallClass {
  // Method gate first: the tool schema already rejects DELETE, but the
  // classifier must not depend on it (see RAW_MODIFY_METHODS).
  if (!isForwardableGoogleMethod(method)) return methodDenial(method);

  const path = canonicalizeGoogleApiPath(rawPath).split(/[?#]/)[0];
  let segments = path.split('/').filter(Boolean).map(s => s.toLowerCase());

  // Media-upload variants (`upload/gmail/v1/…`, `upload/drive/v3/…`) are the
  // same endpoints as their non-upload twins and must classify identically —
  // before this, `upload/gmail/v1/users/me/messages/send` fell through to
  // unknown-family passthrough and skipped the send whitelist entirely.
  if (segments[0] === 'upload') segments = segments.slice(1);

  // Google HTTP batch endpoints (`batch/gmail/v1`, `batch/drive/v3`, …)
  // multiplex many sub-requests (each with its own method and path) inside
  // one POST body, which would smuggle sends past the whitelist and reads
  // past read-restriction checks. Exact-segment match only: Gmail's
  // `messages/batchModify` / `batchDelete` are ordinary endpoints, not batch
  // multiplexers, and classify in the gmail branch below.
  if (segments.includes('batch')) {
    return { kind: 'denied', code: 'raw_api_batch_unsupported', reason: '🚫 Access Denied: Google batch endpoints are not supported through FGAC. Call individual endpoints instead.' };
  }

  // Never-can-work families are refused before any network call. The family
  // segment may come first (`people/v1/…`) or after a bare version segment
  // (`v1/people:createContact`), and may carry a `:verb` suffix — check the
  // verb-stripped base of the first two segments.
  for (const seg of segments.slice(0, 2)) {
    const base = seg.split(':')[0];
    const apiName = UNSUPPORTED_GOOGLE_APIS[base];
    if (apiName) {
      return {
        kind: 'denied',
        code: 'raw_api_family_unsupported',
        family: base,
        reason: `🚫 Not available: the Google ${apiName} API is outside FGAC's Google grant. ` +
          `FGAC's OAuth grant covers Gmail plus per-file Drive access (Sheets, Docs, Slides, and Drive files the user picked or this agent created) — ` +
          `it holds no ${apiName} scope, so no retry, alternate path spelling, or different method can make this call succeed. ` +
          `STOP calling ${base} endpoints. If the user needs ${apiName} access, tell them FGAC does not currently support it.`,
      };
    }
  }

  const isMutating = method !== 'GET';

  if (segments.includes('spreadsheets')) {
    const spreadsheetId = extractSheetsSpreadsheetId(path);
    if (!spreadsheetId) {
      // POST v4/spreadsheets = create. Creation is allowed (2026-08-19 posture
      // change): the Sheets policy exists to keep agents out of the user's
      // EXISTING sheets, not to stop them making new ones. The route handler
      // auto-grants the created id to the calling key so the agent can keep
      // working on what it made. Anything else id-less is nonsense Google
      // will reject itself — forward it rather than inventing a denial.
      if (isMutating) return { kind: 'sheets_create' };
      return { kind: 'passthrough', family: 'spreadsheets', isMutating };
    }
    return { kind: 'sheets', spreadsheetId, isMutating };
  }

  if (segments.includes('documents')) {
    const documentId = extractDocsDocumentId(path);
    if (!documentId) {
      // POST v1/documents = create. Same posture as sheets_create: the Docs
      // policy keeps agents out of the user's EXISTING documents, not out of
      // making new ones — the route handler auto-grants the created id to
      // the calling key. Anything else id-less is nonsense Google rejects.
      if (isMutating) return { kind: 'docs_create' };
      return { kind: 'passthrough', family: 'documents', isMutating };
    }
    return { kind: 'docs', documentId, isMutating };
  }

  if (segments[0] === 'gmail') {
    if (!isMutating) return { kind: 'gmail_read' };
    const last = segments[segments.length - 1];
    const parent = segments[segments.length - 2];
    // The two endpoints that deliver mail keep the recipient whitelist:
    // messages/send carries its recipients in the request body; drafts/send
    // carries them in the stored draft, which the route resolves before
    // forwarding.
    if (last === 'send' && parent === 'messages') return { kind: 'gmail_send' };
    if (last === 'send' && parent === 'drafts') return { kind: 'gmail_draft_send' };
    // Permanent deletion stays refused as a product guarantee
    // (get_my_permissions: "deletion: NEVER available through any tool").
    // Google would not reliably backstop it: batchDelete needs the full
    // mail.google.com scope, which legacy grants in GMAIL_SCOPES can carry.
    if (last === 'batchdelete' && parent === 'messages') {
      return { kind: 'denied', code: 'gmail_write_unsupported', family: 'gmail', reason: '🚫 Access Denied: permanent deletion is the one Gmail write FGAC refuses — messages/batchDelete destroys mail with no trash recovery. Move messages to trash instead (POST …/messages/{id}/trash, reversible), which is allowed.' };
    }
    // Settings writes (sendAs/aliases, filters, forwarding, vacation,
    // delegates) need gmail.settings.* scopes FGAC never requests, so they
    // fail at Google under every grant we accept. Refusing pre-flight names
    // the real cause once and stops the retry loop (same rationale as the
    // family-unsupported denials). Settings READS work under gmail.modify
    // and stay gmail_read above.
    if (segments.includes('settings')) {
      return { kind: 'denied', code: 'gmail_settings_unsupported', family: 'gmail', reason: '🚫 Not available: changing Gmail settings (aliases/sendAs, filters, forwarding, vacation responder, delegates) requires Google gmail.settings.* OAuth scopes that FGAC\'s Google grant (gmail.modify) does not include. This is a Google scope limit, not an FGAC rule — no retry or path spelling can succeed. Reading settings still works. If the user needs a Gmail setting changed, tell them to do it in Gmail directly.' };
    }
    // Everything else the token can do is allowed (2026-08-30 posture change:
    // empower users, don't block them — the send whitelist above and Google's
    // own scopes are the gates): labels, drafts create/update, messages
    // modify/trash/untrash/batchModify/insert/import, thread writes, watch.
    // raw_api_endpoint carries the id-stripped path so which writes agents
    // actually use keeps feeding rule-engine prioritization.
    return { kind: 'gmail_write' };
  }

  // Slides rides drive.file exactly like Sheets/Docs (creates and app-created
  // or user-picked presentations), but per-file Slides policy is the stubbed
  // `slide` kind in driveFileKinds.ts — a separate feature. Until it ships,
  // Slides is scope-backstop passthrough; classifying it here (both
  // `slides/v1/…` and the bare `v1/presentations` spelling agents fall back
  // to) is what lets the route send it to slides.googleapis.com instead of
  // www.googleapis.com, which does not serve Slides and 404s every call.
  if (segments.some(s => s.split(':')[0] === 'presentations')) {
    return { kind: 'passthrough', family: 'slides', isMutating };
  }

  // Comments on a Drive file (which is how Docs/Sheets comments are
  // addressed) are content reads/writes on that file, so they inherit the
  // file's per-file rule instead of falling through to scope-only
  // passthrough — a read-only or blocked doc must not accept comment writes.
  const commentsMatch = path.match(/^drive\/v3\/files\/([^/?#]+)\/comments(\/|$)/i);
  if (commentsMatch) {
    return { kind: 'file_comments', fileId: decodeURIComponent(commentsMatch[1]), isMutating };
  }

  // Drive-side file creation. Google's drive.file grant treats a file the
  // app copies or creates through the Drive API exactly like one created via
  // POST v4/spreadsheets — the app owns it, and every Drive write on it
  // (rename, share, trash, even permanent delete) is authorized. Until
  // 2026-09-16 FGAC registered no rule for these files, so the agent could
  // manage them through Drive while every Sheets/Docs content call denied as
  // not-exposed (observed: two files/{id}/copy calls, then sheets_not_exposed
  // on the copy, then the copies renamed, shared and trashed — all
  // passthrough). Classifying them lets the route gate the copy on the
  // SOURCE file's rule and auto-grant the result like sheets_create does.
  const copyMatch = path.match(/^drive\/v3\/files\/([^/?#]+)\/copy$/i);
  if (copyMatch && isMutating) {
    return { kind: 'drive_copy', fileId: decodeURIComponent(copyMatch[1]) };
  }
  if (/^drive\/v3\/files$/i.test(path.replace(/^upload\//i, '')) && isMutating) {
    return { kind: 'drive_create' };
  }

  // Every other call addressed to ONE Drive file by id — metadata get/update
  // (rename, trash/untrash, move), permissions (share), revisions, export,
  // watch, labels — is an access to that file and follows its per-file rule,
  // exactly as the REST proxy's Drive guard has always required. Until
  // 2026-09-16 these were scope-only passthrough: a spreadsheet whose rule was
  // Blocked could still be trashed via PATCH {trashed:true} through this
  // route, and in production an agent renamed, shared and trashed files as
  // passthrough. Files no rule names are resolved by mimeType in the route
  // (Sheets/Docs → not-exposed denial with an approval link; other kinds
  // ride the drive.file grant, since FGAC has no rule type for them).
  // `generateIds` is an id-less discovery verb in the id slot and stays
  // passthrough, as does listing (`GET drive/v3/files`, no id) — discovery is
  // never gated. `files/trash` (emptyTrash) is DELETE-only and never gets here.
  // `upload/drive/v3/files/{id}` (media content update) is the same file.
  const fileMatch = path.replace(/^upload\//i, '').match(/^drive\/v3\/files\/([^/?#]+)(\/|$)/i);
  if (fileMatch && fileMatch[1].toLowerCase() !== 'generateids') {
    return { kind: 'drive_file', fileId: decodeURIComponent(fileMatch[1]), isMutating };
  }

  // Unknown API families pass through (2026-08-19 posture change: classify
  // usage instead of blocking it — enforcement gets built when demand shows
  // up). Google's own OAuth scopes are the backstop: the token can only reach
  // what the user's grant covers. The family lands on the tool-call event as
  // `raw_api_family` so we can see what people actually reach for.
  return { kind: 'passthrough', family: segments.slice(0, 2).join('/') || 'unknown', isMutating };
}

// Resource collections whose next path segment is a caller-supplied
// identifier (message id, spreadsheet id, file id, …).
const ID_PARENT_SEGMENTS = new Set([
  'spreadsheets', 'documents', 'messages', 'threads', 'drafts', 'labels',
  'attachments', 'files', 'calendars', 'events', 'tasklists', 'tasks', 'contacts',
]);

// Literal API subresources that follow an id-parent segment without being
// ids themselves. Without this, `messages/send` templated as `messages/{id}`
// and send-body 400s were indistinguishable from message-modify probes in
// the endpoint breakdown. batchModify/batchDelete/insert/import sit directly
// under `messages/` the same way.
const LITERAL_SUBRESOURCES = new Set(['send', 'batchmodify', 'batchdelete', 'insert', 'import']);

/**
 * Id-strip a raw Google API path into a low-cardinality endpoint template for
 * analytics (`raw_api_endpoint`), e.g.
 * `gmail/v1/users/me/messages/18c8f2ab91` → `gmail/v1/users/me/messages/{id}`,
 * `v4/spreadsheets/1BxiM…/values/Sheet1!A1:B2:append` →
 * `v4/spreadsheets/{id}/values/{range}:append`.
 * Identifiers can be customer data (and explode GROUP BY cardinality), so they
 * must never land on events; API-surface verbs (`:append`, `:batchUpdate`)
 * are kept because they carry the action semantics.
 */
export function templateGoogleApiPath(rawPath: string): string {
  const path = canonicalizeGoogleApiPath(rawPath).split(/[?#]/)[0];
  const segments = path.split('/').filter(Boolean);
  return segments.map((seg, i) => {
    // A trailing `:verb` (letters only, ≥4 chars) is API surface, not data —
    // the length floor keeps range colons like `A:B` from parsing as verbs.
    const verbMatch = seg.match(/^(.*?):([A-Za-z]{4,})$/);
    const base = verbMatch ? verbMatch[1] : seg;
    const verb = verbMatch ? `:${verbMatch[2]}` : '';
    const prev = i > 0 ? segments[i - 1].toLowerCase().replace(/:.*$/, '') : '';
    let decoded = base;
    try { decoded = decodeURIComponent(base); } catch { /* keep raw */ }

    if (prev === 'values') return `{range}${verb}`;
    if (ID_PARENT_SEGMENTS.has(prev) && !LITERAL_SUBRESOURCES.has(decoded.toLowerCase())) {
      return `{id}${verb}`;
    }
    // Fallback for families without a known parent: long or digit-bearing
    // segments and anything email-shaped are identifiers.
    if (decoded.length >= 25 || (decoded.length >= 10 && /\d/.test(decoded)) || decoded.includes('@')) {
      return `{id}${verb}`;
    }
    return seg;
  }).join('/');
}

/**
 * The Google product family a classified raw call belongs to, stamped as
 * `raw_api_family`. Known kinds map to their product; passthrough keeps the
 * family the classifier derived from the path; denials return null (their
 * `denial_code` already identifies them).
 */
export function rawApiFamily(cls: RawCallClass): string | null {
  switch (cls.kind) {
    case 'sheets':
    case 'sheets_create':
      return 'spreadsheets';
    case 'docs':
    case 'docs_create':
      return 'documents';
    case 'gmail_read':
    case 'gmail_send':
    case 'gmail_draft_send':
    case 'gmail_write':
      return 'gmail';
    case 'file_comments':
      return 'drive_comments';
    case 'drive_copy':
    case 'drive_create':
    case 'drive_file':
      return 'drive/v3';
    case 'passthrough':
      return cls.family;
    case 'denied':
      // Family-unsupported denials keep their family visible so per-family
      // demand for un-granted APIs still shows up in analytics; other denial
      // kinds are identified by denial_code alone.
      return cls.family ?? null;
  }
}

/**
 * Extract all recipient addresses (To/Cc/Bcc) from a Gmail messages/send
 * request body ({ raw: <base64url RFC 2822 message> }).
 * Returns null when recipients cannot be determined — callers must deny.
 */
export function extractSendRecipients(body: unknown): string[] | null {
  let raw: string | undefined;
  try {
    const obj = typeof body === 'string' ? JSON.parse(body) : body;
    if (obj && typeof obj === 'object' && typeof (obj as { raw?: unknown }).raw === 'string') {
      raw = (obj as { raw: string }).raw;
    }
  } catch {
    return null;
  }
  if (!raw) return null;

  let message: string;
  try {
    message = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  // Header section ends at the first blank line. Unfold continuation lines.
  const headerSection = message.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ');
  const recipients: string[] = [];
  for (const line of headerSection.split(/\r?\n/)) {
    if (/^(to|cc|bcc):/i.test(line)) {
      const found = line.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
      if (found) recipients.push(...found);
    }
  }
  return recipients.length > 0 ? recipients : null;
}

/**
 * Parse a Gmail drafts/send request body (a Draft resource: `{ id, message? }`).
 * `draftId` is the stored draft to send; `bodyRecipients` are To/Cc/Bcc parsed
 * out of an inline `message.raw`, when the caller updates the draft while
 * sending. The route unions bodyRecipients with the recipients of the FETCHED
 * draft — every address from either source must pass the send whitelist, so
 * neither a stale draft nor an inline rewrite can smuggle a recipient past it.
 */
export function extractDraftSendInfo(body: unknown): { draftId: string | null; bodyRecipients: string[] | null } {
  let obj: unknown = body;
  try {
    if (typeof body === 'string') obj = JSON.parse(body);
  } catch {
    return { draftId: null, bodyRecipients: null };
  }
  if (!obj || typeof obj !== 'object') return { draftId: null, bodyRecipients: null };
  const draft = obj as { id?: unknown; message?: { raw?: unknown } };
  const draftId = typeof draft.id === 'string' && draft.id.length > 0 ? draft.id : null;
  const raw = draft.message && typeof draft.message === 'object' ? draft.message.raw : undefined;
  const bodyRecipients = typeof raw === 'string' ? extractSendRecipients({ raw }) : null;
  return { draftId, bodyRecipients };
}

/**
 * Collect every `labelIds` array reachable in a Gmail API response.
 * Thread and list responses nest messages, so label-based read rules must
 * consider the union — not just the top-level object.
 */
export function collectLabelIds(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return [];
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...collectLabelIds(item, depth + 1));
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.labelIds)) {
    out.push(...obj.labelIds.filter((l): l is string => typeof l === 'string'));
  }
  for (const key of Object.keys(obj)) {
    if (key === 'labelIds') continue;
    out.push(...collectLabelIds(obj[key], depth + 1));
  }
  return out;
}

// ─── Google error-body parsing ──────────────────────────────────────────────

/**
 * Google's error body carries the only field that distinguishes the several
 * unrelated conditions it multiplexes onto one HTTP status — most importantly
 * 403, which covers both "your OAuth grant is missing a scope" and "you are
 * being rate limited". Only the numeric status used to survive, so the 403
 * remediation asserted the scope cause unconditionally and told rate-limited
 * callers to tear down a working Google connection.
 *
 * `reason`/`domain` are Google-defined enum strings (`rateLimitExceeded`,
 * `usageLimits`, …) and `status` is its canonical code (`PERMISSION_DENIED`)
 * — none of them are customer data, so they are safe to put on events.
 */
export type GoogleErrorReason = { reason?: string; domain?: string; status?: string };

export function extractGoogleErrorReason(data: unknown): GoogleErrorReason {
  const err = (data as {
    error?: {
      errors?: Array<{ reason?: string; domain?: string }>;
      status?: string;
      details?: Array<{ reason?: unknown; domain?: unknown }>;
    };
  })?.error;
  if (!err || typeof err !== 'object') return {};
  const first = Array.isArray(err.errors) ? err.errors[0] : undefined;
  // gRPC-transcoded APIs (Sheets v4, Docs v1, Slides v1, People v1) don't
  // send the legacy `errors[]` array at all — their reason/domain live in
  // `error.details[]` ErrorInfo entries. Before this fallback, every error
  // from those APIs landed with a null `error_reason` and the 403 remediation
  // could not tell a missing drive.file scope from throttling.
  const info = Array.isArray(err.details)
    ? err.details.find(d => d && typeof d === 'object' && typeof d.reason === 'string')
    : undefined;
  return {
    reason: typeof first?.reason === 'string' ? first.reason
      : typeof info?.reason === 'string' ? info.reason : undefined,
    domain: typeof first?.domain === 'string' ? first.domain
      : typeof info?.domain === 'string' ? info.domain : undefined,
    status: typeof err.status === 'string' ? err.status : undefined,
  };
}

// ─── Per-file denial → approval action (magic links) ────────────────────────

export type FileDenialKind = 'not_exposed' | 'blocked' | 'read_only';
export type SheetsDenialKind = FileDenialKind;

/**
 * Which grant a denied per-file operation should request. The action must
 * match the access level the DENIED OPERATION requires — a write denied on an
 * unexposed file must request write access; minting a read-only exposure
 * there sends the user through an approval that cannot satisfy the retry
 * (tester finding, 2026-08-15). Explicit blocks never mint an action:
 * weakening a deliberate block stays a dashboard act.
 */
function fileApprovalLevel(denial: FileDenialKind, isMutating: boolean): 'expose' | 'write' | null {
  if (denial === 'blocked') return null;
  if (denial === 'read_only') return 'write';
  return isMutating ? 'write' : 'expose';
}

export function sheetsApprovalAction(
  denial: SheetsDenialKind,
  spreadsheetId: string,
  isMutating: boolean,
): { action: 'sheets_expose' | 'sheets_write'; spreadsheetId: string } | null {
  const level = fileApprovalLevel(denial, isMutating);
  if (!level) return null;
  return { action: level === 'write' ? 'sheets_write' : 'sheets_expose', spreadsheetId };
}

export function docsApprovalAction(
  denial: FileDenialKind,
  documentId: string,
  isMutating: boolean,
): { action: 'docs_expose' | 'docs_write'; documentId: string } | null {
  const level = fileApprovalLevel(denial, isMutating);
  if (!level) return null;
  return { action: level === 'write' ? 'docs_write' : 'docs_expose', documentId };
}

// ── Drive file id shape ───────────────────────────────────────────────

/**
 * What a Google Drive file id looks like, in words the denial text can quote.
 * Real ids seen in production are 33–44 characters; the range is deliberately
 * loose because a false rejection strands a legitimate call, while a
 * well-formed-but-unknown id merely takes the ordinary not-exposed path.
 */
export const DRIVE_FILE_ID_SHAPE = '20-80 characters from A-Z, a-z, 0-9, "-" and "_" (the segment after /d/ in the file\'s URL)';
const DRIVE_FILE_ID_RE = /^[A-Za-z0-9_-]{20,80}$/;

export function isWellFormedDriveFileId(id: string): boolean {
  return DRIVE_FILE_ID_RE.test(id);
}

/** Which product a Docs/Sheets URL path names, when it names one. */
export type DriveUrlKind = 'sheet' | 'doc' | 'other';

export type DriveFileIdParse =
  /** `input` records how the id arrived: `bare` needs no normalization;
   * `url` and `suffixed` were extracted (stamped on $mcp_tool_call as
   * `file_id_input` so URL-pasting agents stay countable). */
  | { ok: true; id: string; input: 'bare' | 'url' | 'suffixed'; urlKind?: DriveUrlKind }
  | { ok: false; code: 'file_id_malformed' | 'file_id_wrong_kind'; reason: string };

const KIND_NOUN: Record<'sheet' | 'doc' | 'file', string> = { sheet: 'spreadsheet', doc: 'document', file: 'file' };

function urlKindFromPath(pathname: string): DriveUrlKind {
  if (/\/spreadsheets\//.test(pathname)) return 'sheet';
  if (/\/document\//.test(pathname)) return 'doc';
  return 'other';
}

function clip(raw: string): string {
  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

/**
 * Validate — and where the intent is unambiguous, normalize — a
 * caller-supplied Google file id BEFORE any rule lookup or approval-link mint.
 *
 * Why this exists (verified locally 2026-09-08): `docs_read_document` with
 * `<realId>/edit` (what an agent pastes from a Docs URL) or with a junk
 * 44-character string was denied as "not exposed" AND minted a live approval
 * link for the literal value. Such a link can never verify with Google — the
 * Picker shows a substitution at best — so the user got a dead end dressed as
 * a one-click approval. Production ids in the week to 2026-09-08 were all
 * well-formed 44-character ids, so this is hardening, not the cause of the
 * docs_expose conversion gap.
 *
 * Accepted forms, in order:
 *   - a bare id (`[A-Za-z0-9_-]{20,80}`) → returned as-is;
 *   - a full URL (`https://docs.google.com/document/d/<id>/edit?usp=…`,
 *     `…/spreadsheets/d/<id>/edit#gid=0`, `drive.google.com/open?id=<id>`)
 *     → the id is extracted. A URL whose path names the OTHER product
 *     (a spreadsheets URL passed as a documentId) is refused as
 *     `file_id_wrong_kind`: minting a docs link for a sheet id is the same
 *     dead end, since the Documents Picker view never lists the sheet;
 *   - an id with a trailing URL fragment (`<id>/edit`, `<id>?usp=sharing`,
 *     `<id>#gid=0`, `/d/<id>/edit`) → the id is extracted.
 * Anything else is `file_id_malformed` and the reason names the shape. Neither
 * refusal mints an approval link.
 */
export function parseDriveFileId(raw: string, expected: 'sheet' | 'doc' | 'file'): DriveFileIdParse {
  const s = raw.trim();
  if (DRIVE_FILE_ID_RE.test(s)) return { ok: true, id: s, input: 'bare' };

  const noun = KIND_NOUN[expected];
  const malformed = (): DriveFileIdParse => ({
    ok: false,
    code: 'file_id_malformed',
    reason: `🚫 Access Denied: '${clip(s)}' is not a Google Drive file id, so FGAC cannot look up rules for it or ask the user to approve it (no approval link was created — one for this value could never be approved). A ${noun} id is ${DRIVE_FILE_ID_SHAPE}; pass the bare id, or the full Google Docs/Sheets URL and FGAC will extract it.`,
  });

  if (/^https?:\/\//i.test(s)) {
    let url: URL;
    try { url = new URL(s); } catch { return malformed(); }
    const fromPath = url.pathname.match(/\/d\/([A-Za-z0-9_-]+)/);
    const id = fromPath?.[1] ?? url.searchParams.get('id') ?? '';
    if (!DRIVE_FILE_ID_RE.test(id)) return malformed();
    const urlKind = urlKindFromPath(url.pathname);
    if ((expected === 'sheet' && urlKind === 'doc') || (expected === 'doc' && urlKind === 'sheet')) {
      const isSheetUrl = urlKind === 'sheet';
      return {
        ok: false,
        code: 'file_id_wrong_kind',
        reason: `🚫 Access Denied: '${clip(s)}' is a Google ${isSheetUrl ? 'Sheets' : 'Docs'} URL, but this call addresses a ${noun}. ` +
          (isSheetUrl
            ? `Use the sheets_* tools (or request_access with type sheets_read / sheets_write) with spreadsheetId '${id}'.`
            : `Use docs_read_document / docs_edit (or request_access with type docs_read / docs_write) with documentId '${id}'.`) +
          ' No approval link was created.',
      };
    }
    return { ok: true, id, input: 'url', urlKind };
  }

  // `<id>/edit`, `<id>?usp=sharing`, `<id>#gid=0`, `/d/<id>/edit` — the id is
  // the leading (or post-`/d/`) run, and what follows is URL residue.
  const suffixed = s.match(/^(?:\/d\/)?([A-Za-z0-9_-]+)(?=[/?#])/);
  if (suffixed && DRIVE_FILE_ID_RE.test(suffixed[1])) return { ok: true, id: suffixed[1], input: 'suffixed' };

  return malformed();
}
