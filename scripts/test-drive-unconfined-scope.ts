/**
 * Guard: a Google token carrying the FULL `drive` scope must never reach the
 * legacy per-file Drive path, which assumes `drive.file` (Google itself hides
 * every file the user never picked, so listings pass through and non-Sheets/
 * Docs/Slides files ride the per-file grant as `mime_other`).
 * Run: npx tsx scripts/test-drive-unconfined-scope.ts  (part of `npm run mcp:lint`)
 *
 * Found 2026-10-03: the Drive tree engine runs only for the key owner's OWN
 * mailbox with the flag on. A delegated mailbox whose owner granted the full
 * scope (or the owner's own mailbox after the flag is switched off) fell back
 * to the legacy path with an unconfined token — another user's key could list
 * the owner's whole Drive and download every PDF/image through
 * google_api_get. Fail closed: refuse Drive discovery and `mime_other` reads.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { driveScopeUnconfined, isDriveApiPath, unconfinedDriveDenialText } from '../src/lib/driveTreeAccess';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ✓ ${name}`);
}

console.log('driveScopeUnconfined (engine context → legacy path unsafe?):');
// The reported case: delegated mailbox (engine inactive), owner granted `drive`.
check('delegated mailbox + full drive scope → unconfined', driveScopeUnconfined({ active: false, hasDriveFullScope: true }));
// Own mailbox after the flag is switched off, grant still wide.
check('own mailbox, flag off, full scope → unconfined', driveScopeUnconfined({ active: false, hasDriveFullScope: true }));
check('tree engine active → confined by the tree', !driveScopeUnconfined({ active: true, hasDriveFullScope: true }));
check('drive.file-only token → Google confines it', !driveScopeUnconfined({ active: false, hasDriveFullScope: false }));
check('no engine context (non-Google call) → not unconfined', !driveScopeUnconfined(undefined));

console.log('isDriveApiPath:');
for (const p of ['drive/v3/files', 'drive/v3/files?q=trashed%3Dfalse', 'drive/v3/changes?pageToken=1', 'drive/v3/drives', 'drive/v2/files', 'drive/v3/files/abc?alt=media', 'upload/drive/v3/files', '/drive/v3/files', 'Drive/V3/files']) {
  check(`${p} is Drive`, isDriveApiPath(p));
}
for (const p of ['gmail/v1/users/me/messages', 'v4/spreadsheets/abc', 'docs/v1/documents/abc', 'drivex/v3/files', 'calendar/v3/calendars']) {
  check(`${p} is not Drive`, !isDriveApiPath(p));
}

console.log('unconfinedDriveDenialText:');
const delegated = unconfinedDriveDenialText({ targetEmail: 'owner@example.com', delegated: true, what: 'listing' });
check('starts with the 🚫 marker', delegated.startsWith('🚫'));
check('names the account', delegated.includes('owner@example.com'));
check('says STOP / retrying will not help', /STOP/.test(delegated) && /retry/i.test(delegated));
check('points at the files that still work (Sheets/Docs/Slides by id)', /Sheets, Docs (and|&) Slides/.test(delegated));
const ownFile = unconfinedDriveDenialText({ targetEmail: 'me@example.com', delegated: false, what: 'file', fileId: 'F1' });
check('file variant names the file id', ownFile.includes("'F1'"));
check('own-mailbox variant does not claim a delegation', !/delegat/i.test(ownFile));

console.log('MCP route wiring (static):');
const route = readFileSync(join(__dirname, '..', 'src', 'app', 'api', 'mcp', 'route.ts'), 'utf8');
const fnBody = (name: string) => {
  const start = route.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const next = route.indexOf('\nasync function ', start + 1);
  const nextConst = route.indexOf('\nconst ', start + 1);
  const end = [next, nextConst].filter(i => i > 0).reduce((a, b) => Math.min(a, b), route.length);
  return route.slice(start, end);
};
const access = fnBody('checkDriveFileAccess');
const legacyMimeOther = access.lastIndexOf("drive_file_gate: 'mime_other'");
const guardInAccess = access.indexOf('driveScopeUnconfined(');
check('checkDriveFileAccess consults driveScopeUnconfined', guardInAccess >= 0);
check('…before the legacy mime_other passthrough', guardInAccess >= 0 && guardInAccess < legacyMimeOther);
check("…after the engine branch (tree decides when active)", guardInAccess > access.indexOf('engine?.active'));

const passStart = route.indexOf("if (cls.kind === 'passthrough') {");
const passBlock = route.slice(passStart, route.indexOf("if (cls.kind === 'file') {", passStart));
const guardInPass = passBlock.indexOf('driveScopeUnconfined(');
const forward = passBlock.indexOf('googleFetch(');
check('passthrough branch consults driveScopeUnconfined', guardInPass >= 0);
check('…before forwarding to Google', guardInPass >= 0 && guardInPass < forward);
check('…for Drive paths only', /isDriveApiPath\(cleanPath\)/.test(passBlock));
check('denial stamps a dedicated denial_code', /denial_code: 'drive_full_scope_unconfined'/.test(route));

console.log('REST proxy wiring (static):');
const proxy = readFileSync(join(__dirname, '..', 'src', 'app', 'api', 'proxy', '[...path]', 'route.ts'), 'utf8');
check('proxy refuses Drive discovery on an unconfined token when the tree engine is off', /proxyUnconfinedDriveDiscovery\(/.test(proxy));
check('proxy has no delegated-mailbox Drive path (owner token only)', !/delegat\w*\s*Google token|getDelegatedToken/i.test(proxy));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll unconfined-scope checks passed');
