/**
 * Agent-facing copy for Google 400 INVALID_ARGUMENT responses — what to do
 * AFTER Google has said the arguments are wrong. Pure strings and parsing, so
 * `scripts/test-google-bad-request-copy.ts` can pin them; the MCP route
 * (`src/app/api/mcp/route.ts`, describeGoogleError / sheetsErrorResult)
 * assembles them into tool results.
 *
 * Why this module exists (production, external users, 7 d to 2026-09-18):
 * 400 INVALID_ARGUMENT was the largest tool-error class — 29 sheets_update_range,
 * 27 sheets_read_range, 9 sheets_edit, 7 sheets_append_rows, 7
 * docs_read_document, 6 docs_edit. Every one landed on a file the same person
 * was otherwise using successfully (the approval had worked), and nearly
 * every one was followed within seconds by a success on the same file — often
 * after a sheets_get_spreadsheet round trip to learn the tab names. The route
 * returned `❌ Google API error (400): <Google's message>.` and nothing else:
 * no tab list, no A1 example, no stop hint, and for the Docs `fields`-mask
 * case not even the cause, because Google puts it in
 * `error.details[].fieldViolations[].description` under a generic "Request
 * contains an invalid argument." message. Reproduced texts (2026-09-18, dev
 * project, QA account) are the fixtures in the test script.
 */

export type GoogleBadRequestKind =
  /** `Unable to parse range: …` — a tab name that does not exist, or malformed A1 notation. */
  | 'range_parse'
  /** `Range (…) exceeds grid limits. Max rows: N, max columns: M` */
  | 'grid_limits'
  /** `Requested writing within range [A1:B1], but tried writing to column [C]` (or `row [2]`) */
  | 'values_overflow'
  /** `Invalid value at 'data.values[0]' (…ListValue)` / `Invalid values[3][0]: list_value …` — not a 2-D array of scalars */
  | 'values_shape'
  /** `Invalid requests[N].<type>: …` / `Unknown name "x" at 'requests[N]'` / `Invalid value at 'requests[N]'` / `Must specify at least one request.` */
  | 'request_index'
  /** `Error expanding 'fields' parameter. Cannot find matching fields for path '…'` (only in fieldViolations) */
  | 'fields_mask'
  | 'unknown';

export type GoogleBadRequest = {
  kind: GoogleBadRequestKind;
  /** 0-based index into the batchUpdate `requests` array Google rejected, when it named one. */
  requestIndex?: number;
  /** `error.details[].fieldViolations[].description` — where gRPC-transcoded APIs put the real cause. */
  violations: string[];
  /** Google's message merged with the violations it did not already state (badRequestDetail). */
  detail: string;
};

/** Which Google API answered — decides which remedy applies. */
export type GoogleApiFamily = 'sheets' | 'docs' | 'slides' | 'other';

export function googleApiFamilyForUrl(url: string): GoogleApiFamily {
  if (url.startsWith('https://sheets.googleapis.com/')) return 'sheets';
  if (url.startsWith('https://docs.googleapis.com/')) return 'docs';
  if (url.startsWith('https://slides.googleapis.com/')) return 'slides';
  return 'other';
}

/**
 * `google.rpc.BadRequest` field violations. Google's top-level `message` for
 * these is often the generic "Request contains an invalid argument." — the
 * seven docs_read_document 400s in the window were all that text (63 chars
 * on the event, exactly the generic message plus the route's prefix), while
 * the cause ("Cannot find matching fields for path 'content'") sat in the
 * violation the route discarded.
 */
export function extractFieldViolations(data: unknown): string[] {
  const details = (data as { error?: { details?: unknown } })?.error?.details;
  if (!Array.isArray(details)) return [];
  const out: string[] = [];
  for (const d of details) {
    const fv = (d as { fieldViolations?: unknown })?.fieldViolations;
    if (!Array.isArray(fv)) continue;
    for (const v of fv) {
      const desc = (v as { description?: unknown })?.description;
      const field = (v as { field?: unknown })?.field;
      if (typeof desc === 'string' && desc.trim()) {
        out.push(typeof field === 'string' && field && !desc.includes(field) ? `${field}: ${desc}` : desc);
      }
    }
  }
  return out;
}

/** Google's message plus any violation it does not already state, period-stripped. */
export function badRequestDetail(message: string, violations: string[]): string {
  const strip = (s: string) => s.trim().replace(/\s*\.\s*$/, '');
  const base = strip(message);
  const extra = violations.map(strip).filter(v => v && !base.includes(v) && !v.includes(base));
  return [base, ...extra].filter(Boolean).join(' — ');
}

const REQUEST_INDEX = /requests\[(\d+)\]/;

export function classifyGoogleBadRequest(message: string, violations: string[] = []): GoogleBadRequest {
  const text = [message, ...violations].join('\n');
  const detail = badRequestDetail(message, violations);
  const idx = text.match(REQUEST_INDEX);
  if (idx) return { kind: 'request_index', requestIndex: Number(idx[1]), violations, detail };
  if (/Must specify at least one request/i.test(text)) return { kind: 'request_index', violations, detail };
  if (/Unable to parse range/i.test(text)) return { kind: 'range_parse', violations, detail };
  if (/exceeds grid limits/i.test(text)) return { kind: 'grid_limits', violations, detail };
  if (/Requested writing within range/i.test(text)) return { kind: 'values_overflow', violations, detail };
  if (/Invalid value at 'data\.values|Invalid values\[\d+\]\[\d+\]|does not match value's range/i.test(text)) return { kind: 'values_shape', violations, detail };
  if (/Error expanding 'fields' parameter/i.test(text)) return { kind: 'fields_mask', violations, detail };
  return { kind: 'unknown', violations, detail };
}

/**
 * The whole agent-facing 400 text. ❌ first (classifyToolOutcome sniffs it),
 * Google's own words next (the part the agent quotes to the user), then the
 * per-kind remedy, then the stop line — appended, never substituted, like
 * every builder in denialCopy.ts.
 */
export function renderBadRequest(br: GoogleBadRequest, family: GoogleApiFamily, tabs?: SheetTab[]): string {
  const guidance = badRequestGuidance(br, family, tabs);
  return `❌ Google API error (400)${br.detail ? `: ${br.detail}` : ''}. ${guidance ? `${guidance} ` : ''}${BAD_REQUEST_STOP}`;
}

/**
 * The one line every 400 gets. A 400 is deterministic — Google validated the
 * arguments and refused — so "retry" is never the fix, and saying so is what
 * separates a one-call correction from the burst pattern (one person sent
 * the same sheets_update_range payload three times at 1-s cadence).
 */
export const BAD_REQUEST_STOP =
  'STOP — do not retry this call unchanged: Google rejected the arguments, not the permissions, so the same call fails the same way. Fix the arguments first.';

export type SheetTab = { title: string; rowCount?: number; columnCount?: number };

/** `'Tab name'!A1:C10` — the quoting rule agents get wrong most often. */
export function a1Example(tabs: SheetTab[]): string {
  const title = tabs[0]?.title ?? 'Tab name';
  return `'${title.replace(/'/g, "''")}'!A1:C10`;
}

/**
 * The tab list that turns a wrong-tab 400 into a one-step fix. The sheets
 * metadata call is already permitted when this runs (the per-file rule
 * exists — the 400 came from Google after FGAC's check passed), so listing
 * the tabs costs one GET and saves the agent's own sheets_get_spreadsheet
 * round trip — the exact recovery the org sign-up user's agent performed in
 * six separate conversations on the same two spreadsheets.
 */
export function sheetTabsHint(tabs: SheetTab[]): string {
  if (tabs.length === 0) return 'Call sheets_get_spreadsheet to list the tabs before choosing a range.';
  const list = tabs.map(t => {
    const size = t.rowCount && t.columnCount ? ` (${t.rowCount} rows × ${t.columnCount} cols)` : '';
    return `'${t.title}'${size}`;
  }).join(', ');
  return `Tabs in this spreadsheet: ${list}.`;
}

export function badRequestGuidance(
  br: GoogleBadRequest,
  family: GoogleApiFamily,
  tabs?: SheetTab[],
): string {
  const tabLine = tabs !== undefined ? ` ${sheetTabsHint(tabs)}` : '';
  switch (br.kind) {
    case 'range_parse':
      return `The range could not be parsed — usually the tab name is wrong (it must match an existing tab exactly; never assume a tab called 'Sheet1' exists) or the A1 notation is malformed.${tabLine} ` +
        `Write ranges as ${a1Example(tabs ?? [])} (single quotes around a tab name with spaces or punctuation), or the tab name alone for the whole tab.`;
    case 'grid_limits':
      return `The range points past the tab's last row or column (Google's message gives the limits).${tabLine} ` +
        `Target cells inside the grid, use sheets_append_rows to add rows below the data, or grow the tab first with a sheets_edit appendDimension request.`;
    case 'values_overflow':
      return `\`values\` has more columns or rows than the range covers, and Google writes nothing when they disagree. ` +
        `Widen the range to the size of \`values\` (3 columns → A1:C1) or trim \`values\`.`;
    case 'values_shape':
      return `\`values\` must be a 2-D array — an array of rows, each row an array of scalar cells (string, number, or boolean). No nested arrays, objects, or bare scalars.`;
    case 'request_index': {
      const which = br.requestIndex !== undefined ? `requests[${br.requestIndex}] (0-based)` : 'the \`requests\` array';
      const atomic = `Google rejected ${which}; batchUpdate is atomic, so NONE of the requests were applied. `;
      if (family === 'docs') {
        return atomic +
          `Fix that request and resend the whole array. If the message names an index, the document's content has moved since the index was computed — re-read it with docs_read_document and recompute every index from that fresh response first. ` +
          `Mutating requests need a \`fields\` mask; request names must match the Docs batchUpdate reference.`;
      }
      if (family === 'sheets') {
        return atomic +
          `Fix that request and resend the whole array: request names must match the Sheets batchUpdate reference, mutating requests need a \`fields\` mask, and \`sheetId\` values come from sheets_get_spreadsheet (a numeric id, not the tab name).`;
      }
      return atomic + `Fix that request (check its name against the API's batchUpdate reference and add the \`fields\` mask mutating requests require) and resend the whole array.`;
    }
    case 'fields_mask':
      return `The \`fields\` mask names a path this resource does not have (Google's message says which). ` +
        `Use the resource's own field names with no spaces — for a Doc, \`title,body.content\` — or omit \`fields\` to get the full resource.`;
    default:
      return '';
  }
}
