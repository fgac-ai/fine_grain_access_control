/**
 * Unit tests for Google 400 INVALID_ARGUMENT copy (src/lib/googleBadRequestCopy.ts).
 * Run: npx tsx scripts/test-google-bad-request-copy.ts  (part of `npm run mcp:lint`)
 *
 * The fixtures are Google's real response texts, reproduced 2026-09-18 against
 * the dev GCP project with a QA account (see the module header for the
 * production signal they explain). The invariants:
 *   - every reproduced message classifies to the kind whose remedy fits it;
 *   - the Docs fields-mask cause, which Google hides in fieldViolations under
 *     a generic message, is extracted and appended without duplicating text
 *     the message already carries;
 *   - a batchUpdate rejection names the 0-based request index;
 *   - the tab list is rendered with the quoting rule, and the range guidance
 *     never tells an agent to assume 'Sheet1';
 *   - every guidance string is retry-safe: the STOP line is a constant the
 *     route appends, and no kind's guidance says "retry".
 */
import {
  classifyGoogleBadRequest, extractFieldViolations, badRequestDetail, badRequestGuidance,
  sheetTabsHint, a1Example, googleApiFamilyForUrl, renderBadRequest, BAD_REQUEST_STOP,
} from '../src/lib/googleBadRequestCopy';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

console.log('classifyGoogleBadRequest (reproduced Google texts):');
const cases: Array<[string, string, ReturnType<typeof classifyGoogleBadRequest>['kind']]> = [
  ['missing tab', "Unable to parse range: 'Data Tab'!A1:C10", 'range_parse'],
  ['garbage range', 'Unable to parse range: A1:B2:C3', 'range_parse'],
  ['beyond grid', 'Range (Sheet1!A100000) exceeds grid limits. Max rows: 1000, max columns: 26', 'grid_limits'],
  ['values wider than range', 'Requested writing within range [Sheet1!A1:B1], but tried writing to column [C]', 'values_overflow'],
  ['values taller than range', 'Requested writing within range [Sheet1!A1:B1], but tried writing to row [2]', 'values_overflow'],
  ['1-D values', 'Invalid value at \'data.values[0]\' (type.googleapis.com/google.protobuf.ListValue), "x"', 'values_shape'],
  ['nested value on append', 'Invalid values[3][0]: list_value \t {\n  values {\n    number_value: 1.0\n  }\n}\n', 'values_shape'],
  ['body/range mismatch', "Request range[Sheet1!ZZ999] does not match value's range[Sheet1!ZZ998]", 'values_shape'],
  ['unknown request name', 'Invalid JSON payload received. Unknown name "frobnicate" at \'requests[0]\': Cannot find field.', 'request_index'],
  ['missing fields mask', "Invalid requests[0].repeatCell: At least one field must be listed in 'fields'. (Use '*' to indicate all fields.)", 'request_index'],
  ['duplicate tab', 'Invalid requests[0].addSheet: A sheet with the name "Sheet1" already exists. Please enter another name.', 'request_index'],
  ['empty requests', 'Must specify at least one request.', 'request_index'],
  ['request is a string', 'Invalid value at \'requests[0]\' (type.googleapis.com/google.apps.sheets.v4.BatchUpdateSpreadsheetRequest.Request), "repeatCell"', 'request_index'],
  ['docs index past end', 'Invalid requests[0].insertText: Index 9999999 must be less than the end index of the referenced segment, 26.', 'request_index'],
  ['docs index 0', 'Invalid requests[0].insertText: The insertion index must be inside the bounds of an existing paragraph. You can still create new paragraphs by inserting newlines.', 'request_index'],
  ['docs inverted delete (2nd request)', 'Invalid requests[1].deleteContentRange: Invalid range: end index cannot be less than start index', 'request_index'],
  ['generic with no violations', 'Request contains an invalid argument.', 'unknown'],
];
for (const [name, msg, kind] of cases) {
  check(`${name} → ${kind}`, classifyGoogleBadRequest(msg).kind === kind);
}
check('request index is parsed 0-based', classifyGoogleBadRequest('Invalid requests[1].deleteContentRange: x').requestIndex === 1);
check('no index when Google named none', classifyGoogleBadRequest('Must specify at least one request.').requestIndex === undefined);

console.log('extractFieldViolations (Docs fields-mask body):');
const docsBody = {
  error: {
    code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT',
    details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'content', description: "Error expanding 'fields' parameter. Cannot find matching fields for path 'content'." }] }],
  },
};
const viol = extractFieldViolations(docsBody);
check('violation extracted', viol.length === 1 && /Cannot find matching fields for path 'content'/.test(viol[0]));
check('generic message + violation classifies as fields_mask', classifyGoogleBadRequest(docsBody.error.message, viol).kind === 'fields_mask');
const detail = badRequestDetail(docsBody.error.message, viol);
check('detail carries the cause', /path 'content'/.test(detail));
check('detail keeps Google\'s message first', detail.startsWith('Request contains an invalid argument'));
check('detail strips the trailing period', !detail.endsWith('.'));
check('no violations → []', extractFieldViolations({ error: { message: 'x' } }).length === 0 && extractFieldViolations('text').length === 0);

const dupBody = { error: { message: 'Invalid JSON payload received. Unknown name "frobnicate" at \'requests[0]\': Cannot find field.', details: [{ fieldViolations: [{ field: 'requests[0]', description: 'Invalid JSON payload received. Unknown name "frobnicate" at \'requests[0]\': Cannot find field.' }] }] } };
check('violation identical to the message is not repeated', !badRequestDetail(dupBody.error.message, extractFieldViolations(dupBody)).includes(' — '));

console.log('sheet tab hints:');
const tabs = [{ title: 'Q3 Budget', rowCount: 1000, columnCount: 26 }, { title: 'Notes' }];
const hint = sheetTabsHint(tabs);
check('lists every tab, quoted', hint.includes("'Q3 Budget'") && hint.includes("'Notes'"));
check('shows grid size when known', /1000 rows × 26 cols/.test(hint));
check('empty tab list points at sheets_get_spreadsheet', /sheets_get_spreadsheet/.test(sheetTabsHint([])));
check('A1 example uses the first real tab', a1Example(tabs) === "'Q3 Budget'!A1:C10");
check("A1 example doubles embedded quotes", a1Example([{ title: "Bob's" }]) === "'Bob''s'!A1:C10");

console.log('badRequestGuidance:');
const rangeG = badRequestGuidance({ kind: 'range_parse', violations: [], detail: '' }, 'sheets', tabs);
check('range guidance carries the tab list', rangeG.includes("'Q3 Budget'"));
check('range guidance warns off assuming Sheet1', /never assume a tab called 'Sheet1'/.test(rangeG));
check('range guidance shows the quoting rule', /single quotes/.test(rangeG));
const gridG = badRequestGuidance({ kind: 'grid_limits', violations: [], detail: '' }, 'sheets', tabs);
check('grid guidance names append and appendDimension', /sheets_append_rows/.test(gridG) && /appendDimension/.test(gridG));
check('overflow guidance says widen or trim', /Widen the range/.test(badRequestGuidance({ kind: 'values_overflow', violations: [], detail: '' }, 'sheets')));
check('shape guidance says 2-D array of scalars', /2-D array/.test(badRequestGuidance({ kind: 'values_shape', violations: [], detail: '' }, 'sheets')));
const docsIdx = badRequestGuidance({ kind: 'request_index', requestIndex: 1, violations: [], detail: '' }, 'docs');
check('docs index guidance names requests[1] and atomicity', /requests\[1\]/.test(docsIdx) && /NONE of the requests were applied/.test(docsIdx));
check('docs index guidance says re-read with docs_read_document', /docs_read_document/.test(docsIdx));
const sheetsIdx = badRequestGuidance({ kind: 'request_index', requestIndex: 0, violations: [], detail: '' }, 'sheets');
check('sheets index guidance explains sheetId', /sheetId/.test(sheetsIdx) && /sheets_get_spreadsheet/.test(sheetsIdx));
check('fields guidance gives the Docs example', /title,body\.content/.test(badRequestGuidance({ kind: 'fields_mask', violations: [], detail: '' }, 'docs')));
check('unknown kind adds nothing', badRequestGuidance({ kind: 'unknown', violations: [], detail: '' }, 'other') === '');
for (const kind of ['range_parse', 'grid_limits', 'values_overflow', 'values_shape', 'request_index', 'fields_mask'] as const) {
  check(`${kind} guidance never says retry`, !/\bretry\b/i.test(badRequestGuidance({ kind, violations: [], detail: '' }, 'sheets', tabs)));
}
check('STOP line says do not retry unchanged and names the cause', /do not retry this call unchanged/.test(BAD_REQUEST_STOP) && /not the permissions/.test(BAD_REQUEST_STOP));

console.log('renderBadRequest:');
const rendered = renderBadRequest(classifyGoogleBadRequest("Unable to parse range: 'Data Tab'!A1:C10"), 'sheets', tabs);
check('starts with ❌ (outcome class sniffs the prefix)', rendered.startsWith('❌ Google API error (400): '));
check("Google's message comes first, period-terminated", rendered.startsWith("❌ Google API error (400): Unable to parse range: 'Data Tab'!A1:C10. "));
check('tab list follows', rendered.includes("Tabs in this spreadsheet: 'Q3 Budget' (1000 rows × 26 cols), 'Notes'."));
check('ends with the STOP line', rendered.endsWith(BAD_REQUEST_STOP));
const gridRendered = renderBadRequest(classifyGoogleBadRequest('Range (Sheet1!A100000) exceeds grid limits. Max rows: 1000, max columns: 26'), 'sheets', tabs);
check("a detail containing '. ' survives intact", gridRendered.includes('exceeds grid limits. Max rows: 1000, max columns: 26. The range points past'));
const docsRendered = renderBadRequest(classifyGoogleBadRequest(docsBody.error.message, viol), 'docs');
check('docs fields-mask render carries the hidden cause and the Docs example', /path 'content'/.test(docsRendered) && /title,body\.content/.test(docsRendered));
const unknownRendered = renderBadRequest(classifyGoogleBadRequest('Something new.'), 'other');
check('unknown kind renders message + STOP only', unknownRendered === `❌ Google API error (400): Something new. ${BAD_REQUEST_STOP}`);

const protoRendered = renderBadRequest(classifyGoogleBadRequest('Invalid values[0][0]: list_value \t {\n  values {\n    string_value: "x"\n  }\n}\n'), 'sheets');
check('protobuf dump is collapsed onto one line', !/[\t\n]/.test(protoRendered) && protoRendered.includes('list_value { values { string_value: "x" } }. `values` must be'));

console.log('googleApiFamilyForUrl:');
check('sheets', googleApiFamilyForUrl('https://sheets.googleapis.com/v4/spreadsheets/x/values/A1') === 'sheets');
check('docs', googleApiFamilyForUrl('https://docs.googleapis.com/v1/documents/x:batchUpdate') === 'docs');
check('slides', googleApiFamilyForUrl('https://slides.googleapis.com/v1/presentations/x') === 'slides');
check('gmail → other', googleApiFamilyForUrl('https://www.googleapis.com/gmail/v1/users/me/messages') === 'other');

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall google-bad-request-copy checks passed');
