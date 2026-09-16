/**
 * Drive-file kind descriptor — the one place that knows what makes a
 * spreadsheet a spreadsheet and a document a document.
 *
 * Everything FGAC does per-file (per-file rules, Google Picker exposure,
 * drive.file grant verification, grant-recovery pages, approval links)
 * is file-type-agnostic EXCEPT for the values in this table. Adding a new
 * Google file type (Slides is expected next) means adding a descriptor
 * entry plus its MCP tool definitions/registrations and QA docs — shared
 * code must key off this descriptor, never off `if (kind === 'doc')`
 * branches.
 *
 * Pure module (no db/env imports) so policy unit tests can import it.
 */

export type DriveFileKind = 'sheet' | 'doc' | 'slide'; // 'slide' stubbed until Slides ships

export interface DriveFileKindDescriptor {
  /** access_rules.service value for this kind's rules. */
  service: 'sheets' | 'docs' | 'slides';
  /** Rule actionType values: [read, readWrite, block]. */
  actionTypes: { read: string; readWrite: string; block: string };
  /** Approval-link action names: exposing (read) and write-upgrading. */
  approvalActions: { expose: string; write: string };
  /** google.picker.ViewId key for exposing this kind. */
  pickerViewId: 'SPREADSHEETS' | 'DOCUMENTS' | 'PRESENTATIONS';
  /** Drive `mimeType` Google reports for files of this kind (files.copy /
   * files.create responses, files.get metadata). */
  mimeType: string;
  /** API host+path prefix for this kind's endpoint family. */
  apiBase: string;
  /** Cheap authenticated probe that verifies a drive.file grant exists. */
  verifyUrl: (id: string) => string;
  /** Dashboard grant-recovery page (Picker walkthrough) for this kind. */
  setupPath: string;
  /** Query param carrying the file id on the setup page (sheets shipped as `sid`). */
  setupIdParam: string;
  /** Human noun for copy: "spreadsheet" / "document" / "presentation". */
  noun: string;
  /** Analytics names for agent-created files of this kind: the server event
   * (`agent_sheet_created`), its id property, and the $mcp_tool_call flag. */
  createdAnalytics: { event: string; idProp: string; toolCallProp: string };
  /** Title shown on the Google Picker dialog when exposing this kind. */
  pickerTitle: string;
}

export const DRIVE_FILE_KINDS: Record<DriveFileKind, DriveFileKindDescriptor> = {
  sheet: {
    service: 'sheets',
    actionTypes: { read: 'sheet_read', readWrite: 'sheet_read_write', block: 'sheet_block' },
    approvalActions: { expose: 'sheets_expose', write: 'sheets_write' },
    pickerViewId: 'SPREADSHEETS',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    apiBase: 'https://sheets.googleapis.com/v4/spreadsheets',
    verifyUrl: (id: string) =>
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}?fields=properties.title`,
    setupPath: '/dashboard/sheets-setup',
    setupIdParam: 'sid',
    noun: 'spreadsheet',
    createdAnalytics: { event: 'agent_sheet_created', idProp: 'spreadsheet_id', toolCallProp: 'sheet_created' },
    pickerTitle: 'Select Google Sheets to Expose in FGAC',
  },
  doc: {
    service: 'docs',
    actionTypes: { read: 'doc_read', readWrite: 'doc_read_write', block: 'doc_block' },
    approvalActions: { expose: 'docs_expose', write: 'docs_write' },
    pickerViewId: 'DOCUMENTS',
    mimeType: 'application/vnd.google-apps.document',
    apiBase: 'https://docs.googleapis.com/v1/documents',
    verifyUrl: (id: string) =>
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(id)}?fields=title`,
    setupPath: '/dashboard/docs-setup',
    setupIdParam: 'did',
    noun: 'document',
    createdAnalytics: { event: 'agent_doc_created', idProp: 'document_id', toolCallProp: 'doc_created' },
    pickerTitle: 'Select Google Docs to Expose in FGAC',
  },
  // Stub: not reachable anywhere yet (no tools, no rules, no picker entry).
  // Present so the type system and shared plumbing are three-kind-shaped
  // from day one; wiring it up is the Slides feature, not this table.
  slide: {
    service: 'slides',
    actionTypes: { read: 'slide_read', readWrite: 'slide_read_write', block: 'slide_block' },
    approvalActions: { expose: 'slides_expose', write: 'slides_write' },
    pickerViewId: 'PRESENTATIONS',
    mimeType: 'application/vnd.google-apps.presentation',
    apiBase: 'https://slides.googleapis.com/v1/presentations',
    verifyUrl: (id: string) =>
      `https://slides.googleapis.com/v1/presentations/${encodeURIComponent(id)}?fields=title`,
    setupPath: '/dashboard/slides-setup',
    setupIdParam: 'pid',
    noun: 'presentation',
    createdAnalytics: { event: 'agent_slide_created', idProp: 'presentation_id', toolCallProp: 'slide_created' },
    pickerTitle: 'Select Google Slides to Expose in FGAC',
  },
};

/** Kinds a user can actually expose today (excludes stubs). */
export const ACTIVE_DRIVE_FILE_KINDS: DriveFileKind[] = ['sheet', 'doc'];

/** Look up the kind that owns an access_rules.service value. */
export function kindForService(service: string): DriveFileKind | null {
  for (const kind of ACTIVE_DRIVE_FILE_KINDS) {
    if (DRIVE_FILE_KINDS[kind].service === service) return kind;
  }
  return null;
}

/**
 * Look up the active kind a Drive `mimeType` belongs to, or null when the
 * file is something FGAC has no per-file rule model for (folders, PDFs,
 * presentations while Slides is stubbed). Used to auto-grant files the agent
 * creates through Drive (files.copy / files.create), whose response names
 * the product only by mimeType.
 */
export function kindForMimeType(mimeType: string | null | undefined): DriveFileKind | null {
  if (!mimeType) return null;
  for (const kind of ACTIVE_DRIVE_FILE_KINDS) {
    if (DRIVE_FILE_KINDS[kind].mimeType === mimeType) return kind;
  }
  return null;
}
