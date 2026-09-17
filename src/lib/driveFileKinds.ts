/**
 * Drive-file kind descriptor — the one place that knows what makes a
 * spreadsheet a spreadsheet, a document a document, and a presentation a
 * presentation.
 *
 * Everything FGAC does per-file (per-file rules, Google Picker exposure,
 * drive.file grant verification, grant-recovery pages, approval links,
 * the typed MCP tools' copy, analytics names) is file-type-agnostic EXCEPT
 * for the values in this table. Adding a new Google file type means adding
 * a descriptor entry plus its MCP tool definitions/registrations and QA
 * docs — shared code must key off this descriptor, never off
 * `if (kind === 'doc')` branches. Slides (2026-09-17) was the acceptance
 * test of that rule: the ternaries that had crept back in (`kind === 'sheet'
 * ? … : …`, which would have silently treated a slide as a doc) were folded
 * into the fields below rather than grown into three-way branches.
 *
 * Pure module (no db/env imports) so policy unit tests can import it.
 */

export type DriveFileKind = 'sheet' | 'doc' | 'slide';

export interface DriveFileKindDescriptor {
  /** access_rules.service value for this kind's rules. */
  service: 'sheets' | 'docs' | 'slides';
  /** Rule actionType values: [read, readWrite, block]. */
  actionTypes: { read: string; readWrite: string; block: string };
  /** Approval-link action names: exposing (read) and write-upgrading. */
  approvalActions: { expose: string; write: string };
  /** `request_access` type names for this kind (read / write). */
  requestTypes: { read: string; write: string };
  /** google.picker.ViewId key for exposing this kind. */
  pickerViewId: 'SPREADSHEETS' | 'DOCUMENTS' | 'PRESENTATIONS';
  /** Drive `mimeType` Google reports for files of this kind (files.copy /
   * files.create responses, files.get metadata). */
  mimeType: string;
  /** API host+path prefix for this kind's endpoint family. */
  apiBase: string;
  /** Host serving this kind's API (raw-path routing). */
  apiHost: string;
  /** Path segment naming the resource collection in API paths
   * (`spreadsheets` / `documents` / `presentations`) — the segment the raw
   * classifier keys on and the `raw_api_family` value stamped on events. */
  apiCollection: string;
  /** Optional leading path segment agents prepend (`sheets/v4/…`,
   * `docs/v1/…`, `slides/v1/…`) that is stripped before routing to apiHost. */
  apiPathPrefix: string;
  /** docs.google.com URL path segment identifying this kind in a pasted
   * link (`/spreadsheets/d/…`, `/document/d/…`, `/presentation/d/…`). */
  urlPathSegment: string;
  /** Cheap authenticated probe that verifies a drive.file grant exists. */
  verifyUrl: (id: string) => string;
  /** Dashboard grant-recovery page (Picker walkthrough) for this kind. */
  setupPath: string;
  /** Query param carrying the file id on the setup page (sheets shipped as `sid`). */
  setupIdParam: string;
  /** Whether the setup/approval pages embed the demo video (sheets only —
   * error copy must not promise a video that isn't there). */
  hasSetupVideo: boolean;
  /** Dashboard REST seams used by the Picker manager, recovery page, and
   * approve flow (sheets shipped as grant-sheets-access / verify-sheets-access). */
  grantPath: string;
  verifyPath: string;
  /** JSON key of the rules list `grantPath` GET returns (`sheetsRules`). */
  rulesKey: string;
  /** camelCase id key used in tool params, API responses, and approval
   * payloads (`spreadsheetId` / `documentId` / `presentationId`). */
  idKey: 'spreadsheetId' | 'documentId' | 'presentationId';
  /** Human noun for copy: "spreadsheet" / "document" / "presentation". */
  noun: string;
  /** Shorter noun the shipped sheets copy uses ("sheet"); docs/slides keep
   * the full noun. */
  shortNoun: string;
  /** Product name for UI copy: "Google Sheets". */
  productName: string;
  /** Typed MCP tool names, for copy that points agents at the shortcut. */
  tools: { read: string; edit: string };
  /** Analytics names for agent-created files of this kind: the server event
   * (`agent_sheet_created`), its id property, and the $mcp_tool_call flag. */
  createdAnalytics: { event: string; idProp: string; toolCallProp: string };
  /** Grant-funnel analytics events (`sheets_grant_verification` /
   * `sheets_grant_recovered`); the id prop is `createdAnalytics.idProp`. */
  grantAnalytics: { verificationEvent: string; recoveredEvent: string };
  /** Title shown on the Google Picker dialog when exposing this kind. */
  pickerTitle: string;
  /** Design-system tone for this kind's cards/chips. */
  tone: 'sheets' | 'docs' | 'slides';
  /** Read the new file's id and title out of a native create response
   * (`POST v4/spreadsheets` nests the title under `properties`). */
  createdFile: (data: unknown) => { id: string | null; title: string | null };
}

const topLevelCreated = (idKey: string) => (data: unknown) => {
  const d = data as Record<string, unknown> | null;
  const id = typeof d?.[idKey] === 'string' && d[idKey] ? (d[idKey] as string) : null;
  const title = typeof d?.title === 'string' ? (d.title as string) : null;
  return { id, title };
};

export const DRIVE_FILE_KINDS: Record<DriveFileKind, DriveFileKindDescriptor> = {
  sheet: {
    service: 'sheets',
    actionTypes: { read: 'sheet_read', readWrite: 'sheet_read_write', block: 'sheet_block' },
    approvalActions: { expose: 'sheets_expose', write: 'sheets_write' },
    requestTypes: { read: 'sheets_read', write: 'sheets_write' },
    pickerViewId: 'SPREADSHEETS',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    apiBase: 'https://sheets.googleapis.com/v4/spreadsheets',
    apiHost: 'sheets.googleapis.com',
    apiCollection: 'spreadsheets',
    apiPathPrefix: 'sheets',
    urlPathSegment: 'spreadsheets',
    verifyUrl: (id: string) =>
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=properties.title`,
    setupPath: '/dashboard/sheets-setup',
    setupIdParam: 'sid',
    hasSetupVideo: true,
    grantPath: '/api/rules/grant-sheets-access',
    verifyPath: '/api/rules/verify-sheets-access',
    rulesKey: 'sheetsRules',
    idKey: 'spreadsheetId',
    noun: 'spreadsheet',
    shortNoun: 'sheet',
    productName: 'Google Sheets',
    tools: { read: 'sheets_get_spreadsheet', edit: 'sheets_edit' },
    createdAnalytics: { event: 'agent_sheet_created', idProp: 'spreadsheet_id', toolCallProp: 'sheet_created' },
    grantAnalytics: { verificationEvent: 'sheets_grant_verification', recoveredEvent: 'sheets_grant_recovered' },
    pickerTitle: 'Select Google Sheets to Expose in FGAC',
    tone: 'sheets',
    createdFile: (data: unknown) => {
      const d = data as { spreadsheetId?: unknown; properties?: { title?: unknown } } | null;
      return {
        id: typeof d?.spreadsheetId === 'string' && d.spreadsheetId ? d.spreadsheetId : null,
        title: typeof d?.properties?.title === 'string' ? d.properties.title : null,
      };
    },
  },
  doc: {
    service: 'docs',
    actionTypes: { read: 'doc_read', readWrite: 'doc_read_write', block: 'doc_block' },
    approvalActions: { expose: 'docs_expose', write: 'docs_write' },
    requestTypes: { read: 'docs_read', write: 'docs_write' },
    pickerViewId: 'DOCUMENTS',
    mimeType: 'application/vnd.google-apps.document',
    apiBase: 'https://docs.googleapis.com/v1/documents',
    apiHost: 'docs.googleapis.com',
    apiCollection: 'documents',
    apiPathPrefix: 'docs',
    urlPathSegment: 'document',
    verifyUrl: (id: string) =>
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}?fields=title`,
    setupPath: '/dashboard/docs-setup',
    setupIdParam: 'did',
    hasSetupVideo: false,
    grantPath: '/api/rules/grant-docs-access',
    verifyPath: '/api/rules/verify-docs-access',
    rulesKey: 'docsRules',
    idKey: 'documentId',
    noun: 'document',
    shortNoun: 'document',
    productName: 'Google Docs',
    tools: { read: 'docs_read_document', edit: 'docs_edit' },
    createdAnalytics: { event: 'agent_doc_created', idProp: 'document_id', toolCallProp: 'doc_created' },
    grantAnalytics: { verificationEvent: 'docs_grant_verification', recoveredEvent: 'docs_grant_recovered' },
    pickerTitle: 'Select Google Docs to Expose in FGAC',
    tone: 'docs',
    createdFile: topLevelCreated('documentId'),
  },
  slide: {
    service: 'slides',
    actionTypes: { read: 'slide_read', readWrite: 'slide_read_write', block: 'slide_block' },
    approvalActions: { expose: 'slides_expose', write: 'slides_write' },
    requestTypes: { read: 'slides_read', write: 'slides_write' },
    pickerViewId: 'PRESENTATIONS',
    mimeType: 'application/vnd.google-apps.presentation',
    apiBase: 'https://slides.googleapis.com/v1/presentations',
    apiHost: 'slides.googleapis.com',
    apiCollection: 'presentations',
    apiPathPrefix: 'slides',
    urlPathSegment: 'presentation',
    verifyUrl: (id: string) =>
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(id)}?fields=title`,
    setupPath: '/dashboard/slides-setup',
    setupIdParam: 'pid',
    hasSetupVideo: false,
    grantPath: '/api/rules/grant-slides-access',
    verifyPath: '/api/rules/verify-slides-access',
    rulesKey: 'slidesRules',
    idKey: 'presentationId',
    noun: 'presentation',
    shortNoun: 'presentation',
    productName: 'Google Slides',
    tools: { read: 'slides_get_presentation', edit: 'slides_edit' },
    createdAnalytics: { event: 'agent_slide_created', idProp: 'presentation_id', toolCallProp: 'slide_created' },
    grantAnalytics: { verificationEvent: 'slides_grant_verification', recoveredEvent: 'slides_grant_recovered' },
    pickerTitle: 'Select Google Slides to Expose in FGAC',
    tone: 'slides',
    createdFile: topLevelCreated('presentationId'),
  },
};

/** Kinds a user can actually expose today. */
export const ACTIVE_DRIVE_FILE_KINDS: DriveFileKind[] = ['sheet', 'doc', 'slide'];

/** Look up the kind that owns an access_rules.service value. */
export function kindForService(service: string): DriveFileKind | null {
  for (const kind of ACTIVE_DRIVE_FILE_KINDS) {
    if (DRIVE_FILE_KINDS[kind].service === service) return kind;
  }
  return null;
}

/** Look up the kind whose rule actionType family a value belongs to. */
export function kindForActionType(actionType: string): DriveFileKind | null {
  for (const kind of ACTIVE_DRIVE_FILE_KINDS) {
    const t = DRIVE_FILE_KINDS[kind].actionTypes;
    if (actionType === t.read || actionType === t.readWrite || actionType === t.block) return kind;
  }
  return null;
}

/** Look up the kind an approval-link action name belongs to (`sheets_expose` → sheet). */
export function kindForApprovalAction(action: string): DriveFileKind | null {
  for (const kind of ACTIVE_DRIVE_FILE_KINDS) {
    const a = DRIVE_FILE_KINDS[kind].approvalActions;
    if (action === a.expose || action === a.write) return kind;
  }
  return null;
}

/** Look up the kind a `request_access` type belongs to (`docs_read` → doc). */
export function kindForRequestType(type: string): DriveFileKind | null {
  for (const kind of ACTIVE_DRIVE_FILE_KINDS) {
    const r = DRIVE_FILE_KINDS[kind].requestTypes;
    if (type === r.read || type === r.write) return kind;
  }
  return null;
}

/**
 * Look up the active kind a Drive `mimeType` belongs to, or null when the
 * file is something FGAC has no per-file rule model for (folders, PDFs,
 * plain uploads). Used to auto-grant files the agent creates through Drive
 * (files.copy / files.create), whose response names the product only by
 * mimeType.
 */
export function kindForMimeType(mimeType: string | null | undefined): DriveFileKind | null {
  if (!mimeType) return null;
  for (const kind of ACTIVE_DRIVE_FILE_KINDS) {
    if (DRIVE_FILE_KINDS[kind].mimeType === mimeType) return kind;
  }
  return null;
}
