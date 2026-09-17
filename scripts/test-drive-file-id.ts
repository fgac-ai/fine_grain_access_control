/**
 * Unit tests for Drive file id validation/normalization
 * (parseDriveFileId in src/app/api/mcp/googleApiPolicy.ts).
 * Run: npx tsx scripts/test-drive-file-id.ts
 *
 * Background (verified locally 2026-09-08): `docs_read_document` with
 * `<realId>/edit` or a junk 44-char string was denied as not-exposed AND
 * minted a live approval link for the literal value — a dead end, since
 * Google can never verify it. The parser below runs before any rule lookup
 * or link mint; a refusal carries denial_code and mints nothing.
 */
import { parseDriveFileId, isWellFormedDriveFileId, DRIVE_FILE_ID_SHAPE } from '../src/app/api/mcp/googleApiPolicy';

let failures = 0;
function expect(name: string, actual: unknown, predicate: (v: never) => boolean) {
  if (!predicate(actual as never)) {
    failures++;
    console.error(`  ✗ ${name} — got: ${JSON.stringify(actual)}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

type P = ReturnType<typeof parseDriveFileId>;
const ok = (id: string, input: string) => (p: P) => p.ok && p.id === id && p.input === input;
const refused = (code: string) => (p: P) => !p.ok && p.code === code && p.reason.startsWith('🚫');

// Fixture ids: shapes match production (44-char Docs/Sheets ids, 33-char
// Drive ids); values are synthetic.
const DOC = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefgh'; // 44
const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';   // 44
const SHORT = '0B7abcdefghijklmnopqrstuvwxyzAB';                // 31

console.log('isWellFormedDriveFileId:');
expect('44-char id well-formed', isWellFormedDriveFileId(DOC), (v: boolean) => v === true);
expect('31-char legacy id well-formed', isWellFormedDriveFileId(SHORT), (v: boolean) => v === true);
expect('20-char lower bound accepted', isWellFormedDriveFileId('a'.repeat(20)), (v: boolean) => v === true);
expect('19 chars rejected', isWellFormedDriveFileId('a'.repeat(19)), (v: boolean) => v === false);
expect('81 chars rejected', isWellFormedDriveFileId('a'.repeat(81)), (v: boolean) => v === false);
expect('slash rejected', isWellFormedDriveFileId(`${DOC}/edit`), (v: boolean) => v === false);
expect('shape text names the /d/ segment', DRIVE_FILE_ID_SHAPE, (v: string) => v.includes('/d/') && v.includes('20-80'));

console.log('parseDriveFileId — bare ids pass through:');
expect('bare doc id → bare', parseDriveFileId(DOC, 'doc'), ok(DOC, 'bare'));
expect('bare sheet id → bare', parseDriveFileId(SHEET, 'sheet'), ok(SHEET, 'bare'));
expect('surrounding whitespace trimmed', parseDriveFileId(`  ${DOC}\n`, 'doc'), ok(DOC, 'bare'));
expect('kind "file" (comments) accepts any bare id', parseDriveFileId(SHEET, 'file'), ok(SHEET, 'bare'));

console.log('parseDriveFileId — URL residue is stripped (the 2026-09-08 repro):');
expect('<id>/edit → id', parseDriveFileId(`${DOC}/edit`, 'doc'), ok(DOC, 'suffixed'));
expect('<id>/edit?usp=sharing → id', parseDriveFileId(`${DOC}/edit?usp=sharing`, 'doc'), ok(DOC, 'suffixed'));
expect('<id>?usp=sharing → id', parseDriveFileId(`${SHEET}?usp=sharing`, 'sheet'), ok(SHEET, 'suffixed'));
expect('<id>#gid=0 → id', parseDriveFileId(`${SHEET}#gid=0`, 'sheet'), ok(SHEET, 'suffixed'));
expect('/d/<id>/edit (path only) → id', parseDriveFileId(`/d/${DOC}/edit`, 'doc'), ok(DOC, 'suffixed'));

console.log('parseDriveFileId — full URLs are extracted:');
expect('docs URL → doc id', parseDriveFileId(`https://docs.google.com/document/d/${DOC}/edit`, 'doc'), ok(DOC, 'url'));
expect('docs URL with query/fragment', parseDriveFileId(`https://docs.google.com/document/d/${DOC}/edit?usp=sharing#heading=h.1`, 'doc'), ok(DOC, 'url'));
expect('sheets URL → sheet id', parseDriveFileId(`https://docs.google.com/spreadsheets/d/${SHEET}/edit#gid=0`, 'sheet'), ok(SHEET, 'url'));
expect('sheets URL records urlKind', parseDriveFileId(`https://docs.google.com/spreadsheets/d/${SHEET}/edit`, 'sheet'), (p: P) => p.ok && p.urlKind === 'sheet');
expect('drive open?id= URL → id', parseDriveFileId(`https://drive.google.com/open?id=${DOC}`, 'doc'), ok(DOC, 'url'));
expect('drive file/d/<id>/view → id (kind other, accepted)', parseDriveFileId(`https://drive.google.com/file/d/${DOC}/view`, 'doc'), ok(DOC, 'url'));
expect('http scheme accepted', parseDriveFileId(`http://docs.google.com/document/d/${DOC}/edit`, 'doc'), ok(DOC, 'url'));
expect('comments kind accepts either product URL', parseDriveFileId(`https://docs.google.com/spreadsheets/d/${SHEET}/edit`, 'file'), ok(SHEET, 'url'));

console.log('parseDriveFileId — wrong product URL is refused without a link:');
expect('sheets URL as documentId → file_id_wrong_kind', parseDriveFileId(`https://docs.google.com/spreadsheets/d/${SHEET}/edit`, 'doc'), refused('file_id_wrong_kind'));
expect('wrong-kind reason names the sheets tools + the id', parseDriveFileId(`https://docs.google.com/spreadsheets/d/${SHEET}/edit`, 'doc'), (p: P) => !p.ok && p.reason.includes('sheets_') && p.reason.includes(SHEET));
expect('docs URL as spreadsheetId → file_id_wrong_kind', parseDriveFileId(`https://docs.google.com/document/d/${DOC}/edit`, 'sheet'), refused('file_id_wrong_kind'));
expect('wrong-kind reason names docs_read_document + the id', parseDriveFileId(`https://docs.google.com/document/d/${DOC}/edit`, 'sheet'), (p: P) => !p.ok && p.reason.includes('docs_read_document') && p.reason.includes(DOC));
expect('slides URL as documentId → file_id_wrong_kind', parseDriveFileId(`https://docs.google.com/presentation/d/${SHEET}/edit#slide=id.p`, 'doc'), refused('file_id_wrong_kind'));
expect('wrong-kind reason names slides_get_presentation + presentationId', parseDriveFileId(`https://docs.google.com/presentation/d/${SHEET}/edit`, 'doc'), (p: P) => !p.ok && p.reason.includes('slides_get_presentation') && p.reason.includes('presentationId') && p.reason.includes(SHEET));
expect('docs URL as presentationId → file_id_wrong_kind', parseDriveFileId(`https://docs.google.com/document/d/${DOC}/edit`, 'slide'), refused('file_id_wrong_kind'));
expect('slides URL as presentationId → slide id', parseDriveFileId(`https://docs.google.com/presentation/d/${DOC}/edit?usp=sharing`, 'slide'), ok(DOC, 'url'));
expect('bare id as presentationId → bare', parseDriveFileId(DOC, 'slide'), ok(DOC, 'bare'));

console.log('parseDriveFileId — malformed values are refused without a link:');
expect('empty → file_id_malformed', parseDriveFileId('', 'doc'), refused('file_id_malformed'));
expect('too short → file_id_malformed', parseDriveFileId('abc123', 'doc'), refused('file_id_malformed'));
expect('44 chars with a space → file_id_malformed', parseDriveFileId(`${DOC.slice(0, 20)} ${DOC.slice(21)}`, 'doc'), refused('file_id_malformed'));
expect('URL without /d/ or id= → file_id_malformed', parseDriveFileId('https://docs.google.com/document/u/0/', 'doc'), refused('file_id_malformed'));
expect('URL with too-short id → file_id_malformed', parseDriveFileId('https://docs.google.com/document/d/abc/edit', 'doc'), refused('file_id_malformed'));
expect('suffixed but too-short id → file_id_malformed', parseDriveFileId('abc/edit', 'sheet'), refused('file_id_malformed'));
expect('email-shaped value → file_id_malformed', parseDriveFileId('someone@example.com', 'sheet'), refused('file_id_malformed'));
expect('title instead of id → file_id_malformed', parseDriveFileId('Q3 Budget Spreadsheet', 'sheet'), refused('file_id_malformed'));
expect('malformed reason names the expected shape', parseDriveFileId('abc123', 'doc'), (p: P) => !p.ok && p.reason.includes(DRIVE_FILE_ID_SHAPE) && p.reason.includes('no approval link'));
expect('malformed reason uses the kind noun', parseDriveFileId('abc123', 'sheet'), (p: P) => !p.ok && p.reason.includes('A spreadsheet id is'));
expect('very long junk is clipped in the reason', parseDriveFileId('x'.repeat(500), 'doc'), (p: P) => !p.ok && !p.reason.includes('x'.repeat(200)));
expect('81-char run is malformed, not a bare id', parseDriveFileId('a'.repeat(81), 'doc'), refused('file_id_malformed'));

if (failures > 0) {
  console.error(`\n${failures} drive-file-id test(s) failed.`);
  process.exit(1);
}
console.log('\nAll drive-file-id tests passed.');
