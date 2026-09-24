/**
 * MCP tool definitions — names, titles, descriptions, and safety annotations.
 *
 * This module is intentionally pure (no db/env imports) so that
 * `scripts/mcp-tool-lint.ts` can import it and enforce the Anthropic
 * Connectors Directory invariants in CI:
 *   - every tool has a `title` and a readOnlyHint/destructiveHint
 *   - tool names are ≤ 64 characters
 *   - no tool forwards both safe and unsafe HTTP methods
 *   - freeform-path tools name/link the target API in their description
 *   - convenience tools reference their raw-API fallback in the description
 *     (google_api_get / google_api_modify are the full surface; typed tools
 *     are shortcuts — every dead end must point at the escape hatch)
 */
import { RAW_READ_METHODS, RAW_MODIFY_METHODS } from './googleApiPolicy';

export interface FgacToolDef {
  name: string;
  title: string;
  description: string;
  /** true → readOnlyHint: true; false → destructiveHint must be set */
  readOnly: boolean;
  /** Only meaningful when readOnly is false. */
  destructive?: boolean;
  /** Tool interacts with entities outside the user's accounts (e.g. sends email). */
  openWorld?: boolean;
  /** HTTP methods a freeform-path tool forwards. Lint forbids mixing GET with writes. */
  freeformMethods?: readonly string[];
}

export const TOOL_DEFS = {
  list_accounts: {
    name: 'list_accounts',
    title: 'List accessible email accounts',
    description: "Lists the email accounts this connection can access through FGAC. account_details reports each account's Google scope state: gmail and drive_file are 'granted', 'missing', or 'unknown' ('unknown' means the state could not be determined right now — treat the account as usable and let a real call settle it; never treat 'unknown' as missing). A 'missing' scope means every call needing it will fail until the account is reconnected — the entry's reconnect_url is a one-click fix link to give the user; it is bound to that specific account, so the user must open it while signed in to FGAC as that account. google_token: 'unavailable' with a reconnect_url means the Google grant itself is dead (revoked, expired, or missing) — every call on that account fails until the user opens the link; do not retry, and read next_steps.reconnect first.",
    readOnly: true,
  },
  gmail_list: {
    name: 'gmail_list',
    title: 'Search or list Gmail messages',
    description: 'Search or list Gmail messages: returns recent message IDs, optionally filtered by a Gmail search query (e.g. "is:unread", "from:alice newer_than:7d") — this is the Gmail search tool; read a result with gmail_read. Works across every connected or delegated Gmail inbox — pass the "account" parameter to target a specific mailbox (see list_accounts). Other Gmail read endpoints (threads, drafts, history, settings) are available via google_api_get.',
    readOnly: true,
  },
  gmail_read: {
    name: 'gmail_read',
    title: 'Read a Gmail message',
    description: 'Read a Gmail message by ID — arguments: messageId (required; the "id" from gmail_list), account, format, offset, limit. Returns parsed headers, body text, and attachment metadata. Reading is allowed by default; messages matching the user\'s read-block rules (labels or content patterns), if any, are withheld. Works across every connected or delegated Gmail inbox via the "account" parameter. For a full thread use google_api_get with gmail/v1/users/me/threads/{id}. Long messages: pass offset and a limit sized to your tool-result budget (chars, max 200000/call) to window the serialized message with the body UNtruncated — the envelope reports total_chars and next_offset; concatenate data strings in offset order.',
    readOnly: true,
  },
  gmail_get_attachment: {
    name: 'gmail_get_attachment',
    title: 'Download a Gmail attachment',
    description: 'Retrieve an email attachment by message ID plus either attachment ID or filename (allowed unless the parent message matches a read-block rule). Gmail attachment ids go stale when a message is re-indexed — stale ids are healed automatically when unambiguous, and filenames never go stale. Returns Gmail\'s base64url-encoded data (URL-safe alphabet, padded with "=") — decode with a base64url decoder, not standard base64. Files over ~150 KB must be read in windows: pass offset and a limit sized to YOUR tool-result budget (chars of base64url data, max 200000/call); each response reports total_chars and next_offset — concatenate the data strings in offset order, then decode once.',
    readOnly: true,
  },
  gmail_send: {
    name: 'gmail_send',
    title: 'Send an email',
    description: 'Send a plain-text email from any connected or delegated account (via the "account" parameter). Recipients must match the user\'s FGAC send whitelist; denied sends include a link the user can use to approve the recipient. Plain text only — for HTML, attachments, or threaded replies, use google_api_modify with Gmail messages/send and a raw RFC 2822 MIME body; the same whitelist applies.',
    readOnly: false,
    destructive: true,
    openWorld: true,
  },
  gmail_labels: {
    name: 'gmail_labels',
    title: 'List Gmail labels',
    description: 'List all Gmail labels for an accessible account.',
    readOnly: true,
  },
  sheets_get_spreadsheet: {
    name: 'sheets_get_spreadsheet',
    title: 'Get spreadsheet metadata',
    description: 'Get metadata and sheet tabs for a Google Spreadsheet exposed by the user\'s FGAC rules — arguments: spreadsheetId (required), account, offset, limit. Large responses: pass offset and a limit sized to your tool-result budget (chars, max 200000/call) — the windowed envelope reports total_chars and next_offset; concatenate data strings in offset order.',
    readOnly: true,
  },
  sheets_read_range: {
    name: 'sheets_read_range',
    title: 'Read spreadsheet cells',
    description: 'Read cell values from a sheet tab or range in a Google Spreadsheet exposed by the user\'s FGAC rules — arguments: spreadsheetId and range (both required), account, offset, limit. Prefer narrowing the range; for genuinely large ranges, pass offset and a limit sized to your tool-result budget (chars, max 200000/call) — the windowed envelope reports total_chars and next_offset; concatenate data strings in offset order.',
    readOnly: true,
  },
  sheets_update_range: {
    name: 'sheets_update_range',
    title: 'Update spreadsheet cells',
    description: 'Overwrite cell values in a range of a Google Spreadsheet — arguments: spreadsheetId, range, values (a JSON array of row arrays, all required), account. Requires a Read & Write FGAC rule for the spreadsheet. Values only — for formatting, charts, or structural changes use sheets_edit; the same rule authorizes both.',
    readOnly: false,
    destructive: true,
  },
  sheets_append_rows: {
    name: 'sheets_append_rows',
    title: 'Append spreadsheet rows',
    description: 'Append rows to a sheet in a Google Spreadsheet without modifying existing cells. Requires a Read & Write FGAC rule for the spreadsheet. Values only — for formatting or structural changes use sheets_edit; the same rule authorizes both.',
    readOnly: false,
    destructive: false,
  },
  sheets_edit: {
    name: 'sheets_edit',
    title: 'Edit a Google Spreadsheet (batchUpdate)',
    description: 'Apply Google Sheets batchUpdate requests to a spreadsheet — the full Sheets structural surface: cell and number formatting, conditional formats, charts, adding/renaming/deleting sheet tabs, merges, borders, filters, data validation, protected ranges (https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/batchUpdate). For plain cell values prefer sheets_update_range / sheets_append_rows (simpler A1 ranges). Requires a Read & Write FGAC rule for the spreadsheet. Spreadsheet comments live in the Drive API — use comments_read / comments_add. To create a new spreadsheet, use google_api_modify (POST v4/spreadsheets).',
    readOnly: false,
    destructive: true,
  },
  docs_read_document: {
    name: 'docs_read_document',
    title: 'Read a Google Doc',
    description: 'Read a Google Docs document exposed by the user\'s FGAC rules — arguments: documentId (required), fields, account, offset, limit. Returns the raw Docs API document resource (title, body content as structured JSON). Large documents: trim with the optional "fields" mask (e.g. "title,body.content"), or read in windows by passing offset and a limit sized to YOUR tool-result budget (chars of serialized JSON, max 200000/call) — each response reports total_chars and next_offset; concatenate data strings in offset order. To edit the document use docs_edit; comments live in the Drive API — use comments_read.',
    readOnly: true,
  },
  docs_edit: {
    name: 'docs_edit',
    title: 'Edit a Google Doc (batchUpdate)',
    description: 'Apply Google Docs batchUpdate requests to edit documents — insert or delete text, tables, text styles, headings, images, page breaks, and positional content (https://developers.google.com/docs/api/reference/rest/v1/documents/batchUpdate). Examples: append text {"insertText":{"endOfSegmentLocation":{},"text":"..."}}, insert 3x3 table {"insertTable":{"rows":3,"columns":3,"endOfSegmentLocation":{}}}, or replace every occurrence {"replaceAllText":{"containsText":{"text":"old","matchCase":true},"replaceText":"new"}}. Requires Read & Write FGAC access. Doc comments live in Drive API — use comments_read / comments_add. Create new documents with google_api_modify (POST v1/documents). Inserted text inherits the target paragraph\'s style; add updateParagraphStyle NORMAL_TEXT sweep when replacing body content. Deletes are auto-verified: response ends with "verified" or returns a warning plus the actual end index if a delete applied only partially (ranges crossing table boundaries may do this despite success).',
    readOnly: false,
    destructive: true,
  },
  slides_get_presentation: {
    name: 'slides_get_presentation',
    title: 'Read a Google Slides presentation',
    description: 'Read a Google Slides presentation exposed by the user\'s FGAC rules. Returns the raw Slides API presentation resource (title, slides, page elements with their text and shapes as structured JSON). Large decks: trim with the optional "fields" mask (e.g. "title,slides(objectId,pageElements(shape(text)))"), or read in windows by passing offset and a limit sized to YOUR tool-result budget (chars of serialized JSON, max 200000/call) — each response reports total_chars and next_offset; concatenate data strings in offset order. To edit the presentation use slides_edit; comments live in the Drive API — use comments_read.',
    readOnly: true,
  },
  slides_edit: {
    name: 'slides_edit',
    title: 'Edit a Google Slides presentation (batchUpdate)',
    description: 'Apply Google Slides batchUpdate requests to edit presentations — add or delete slides, create shapes, text boxes, images and tables, insert/replace/delete text, restyle text and shapes (https://developers.google.com/slides/api/reference/rest/v1/presentations/batchUpdate). Examples: add a blank slide {"createSlide":{"slideLayoutReference":{"predefinedLayout":"BLANK"}}}, replace text everywhere {"replaceAllText":{"containsText":{"text":"old","matchCase":true},"replaceText":"new"}}, or insert text into a shape {"insertText":{"objectId":"<shapeId>","text":"..."}} (object ids come from slides_get_presentation). Requires Read & Write FGAC access. Comments live in the Drive API — use comments_read / comments_add. Create new presentations with google_api_modify (POST v1/presentations).',
    readOnly: false,
    destructive: true,
  },
  comments_read: {
    name: 'comments_read',
    title: 'Read file comments',
    description: 'List the comments on a Google Docs document, Google Sheets spreadsheet, or Google Slides presentation — content, resolution state, author names, quoted anchor text, and replies — via the Drive API comments endpoint (https://developers.google.com/drive/api/reference/rest/v3/comments). Works for any file exposed by an FGAC rule.',
    readOnly: true,
  },
  comments_add: {
    name: 'comments_add',
    title: 'Add a comment or reply',
    description: 'Add a comment to a Google Docs document, Google Sheets spreadsheet, or Google Slides presentation, or reply to an existing comment (pass commentId; set resolve to also mark it resolved), via the Drive API (https://developers.google.com/drive/api/reference/rest/v3/replies). Requires a Read & Write FGAC rule for the file. New comments are file-level (unanchored); anchoring to a specific range is not supported.',
    readOnly: false,
    destructive: false,
  },
  google_api_get: {
    name: 'google_api_get',
    title: 'Raw Google API read',
    description: 'Perform a read-only GET request against any Google API endpoint by path — the full read surface behind the typed convenience tools. Gmail (https://developers.google.com/gmail/api/reference/rest): messages, threads, drafts, labels, history, settings — reads are allowed by default and filtered by the user\'s read-block rules if any. Google Sheets (https://developers.google.com/sheets/api/reference/rest), Google Docs (https://developers.google.com/docs/api/reference/rest), and Google Slides (https://developers.google.com/slides/api/reference/rest): require a per-file FGAC rule. Drive (https://developers.google.com/drive/api/reference/rest/v3): listing (drive/v3/files) is never gated; any call addressed to a file by id (metadata, export, revisions, permissions, comments) follows that file\'s FGAC rule — a Sheet, Doc, or Slides deck needs a rule, other kinds ride the per-file drive.file grant (files the user picked or this agent created; 404 = not granted). comments_read is the comments shortcut. APIs outside the grant — People/Contacts, Calendar, Tasks, YouTube, and other non-Workspace-file APIs — can NEVER work through FGAC and are refused; do not probe them. Batch endpoints are denied. Use this whenever no typed read tool covers the endpoint you need. Large responses: pass offset and a limit sized to your tool-result budget (chars, max 200000/call) — the windowed envelope reports total_chars and next_offset; concatenate data strings in offset order.',
    readOnly: true,
    freeformMethods: RAW_READ_METHODS,
  },
  google_api_modify: {
    name: 'google_api_modify',
    title: 'Raw Google API write',
    description: 'POST, PUT, or PATCH any Google API endpoint by path; the full write surface behind the typed tools. Docs v1/documents/{id}:batchUpdate, Slides v1/presentations/{id}:batchUpdate, and Sheets write endpoints incl. v4/spreadsheets/{id}:batchUpdate need a Read & Write rule for the file. Creating files is allowed and auto-granted Read & Write to this connection: POST v1/documents, v4/spreadsheets, v1/presentations, drive/v3/files, and drive/v3/files/{id}/copy (the source must be exposed to this connection by any non-blocked rule). Gmail (https://developers.google.com/gmail/api/reference/rest): mailbox writes are allowed by default — labels, drafts, messages/{id}/modify, trash/untrash, batchModify, insert/import. Sends are whitelisted: messages/send (base64url raw RFC 2822 body) and drafts/send (recipients read from the stored draft) check every recipient against the send whitelist. Gmail settings writes need scopes FGAC does not hold and are refused; permanent deletion (batchDelete) is never available. Drive writes addressed to a file by id (PATCH drive/v3/files/{id} rename/trash, permissions, comments) follow the file\'s FGAC rule: a Sheet, Doc, or Slides deck needs a Read & Write rule (comments_add is the comments shortcut); other file kinds ride the per-file drive.file grant. APIs outside the grant (People/Contacts, Calendar, Tasks, …) never work and are refused. Batch endpoints are denied; DELETE is never available. Denied calls return a one-click approval link.',
    readOnly: false,
    destructive: true,
    openWorld: true,
    freeformMethods: RAW_MODIFY_METHODS,
  },
  request_access: {
    name: 'request_access',
    title: 'Request a permission upgrade',
    description: 'Ask the user to grant this agent a specific permission: sending email to a recipient, or read/write access to a Google Spreadsheet, Google Docs document, or Google Slides presentation. Arguments: type (required — one of send, sheets_read, sheets_write, docs_read, docs_write, slides_read, slides_write) plus recipient for send, or spreadsheetId / documentId / presentationId for a file. Returns a permanent approval link for the user — calling this tool grants nothing by itself; the user must open the link and approve. For a spreadsheet, document, or presentation, pass resourceName (the file\'s title) whenever you know it: the approval page shows it, and without it the user only sees Google\'s file id while Google\'s picker lists files by name.',
    readOnly: true,
  },
  get_my_permissions: {
    name: 'get_my_permissions',
    title: 'Show my permissions',
    description: 'Shows the access rules, accessible accounts, proxy key, and default access posture (including implicit Gmail read access) that apply to this connection.',
    readOnly: true,
  },
} as const satisfies Record<string, FgacToolDef>;

export type ToolName = keyof typeof TOOL_DEFS;

/** MCP ToolAnnotations for a definition. */
export function toolAnnotations(def: FgacToolDef) {
  return {
    title: def.title,
    ...(def.readOnly
      ? { readOnlyHint: true as const }
      : { destructiveHint: def.destructive ?? true }),
    ...(def.openWorld !== undefined ? { openWorldHint: def.openWorld } : {}),
  };
}
