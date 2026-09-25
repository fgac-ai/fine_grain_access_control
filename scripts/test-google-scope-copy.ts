/**
 * Unit tests for the "Google access incomplete" card copy
 * (src/lib/googleScopeCopy.ts).
 * Run: npx tsx scripts/test-google-scope-copy.ts  (part of `npm run mcp:lint`)
 *
 * The invariant: the card must name the scope that is actually missing.
 * A drive.file-only gap must never render as a Gmail problem (the pre-2026-09
 * copy did exactly that, to users whose Gmail worked and whose Drive
 * permission a Google sign-in had just reset).
 */
import { describeMissingGoogleAccess } from '../src/lib/googleScopeCopy';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`  ✗ ${name}`); }
  else console.log(`  ✓ ${name}`);
}

console.log('describeMissingGoogleAccess:');

check('complete access renders no card',
  describeMissingGoogleAccess({ gmail: true, driveFile: true }, true) === null);

const driveOnly = describeMissingGoogleAccess({ gmail: true, driveFile: false }, true)!;
check('drive.file gap names drive.file', driveOnly.missing.length === 1 && driveOnly.missing[0] === 'drive_file');
check('drive.file gap title mentions Drive', /Drive/.test(driveOnly.title));
check('drive.file gap never blames Gmail', !/not granted .* Gmail/i.test(driveOnly.body) && !/Gmail access .* missing/i.test(driveOnly.body));
check('drive.file gap for a Sheets/Docs user names the pre-drive.file connection and the unchecked box, never leads with a sign-in reset', /connected before FGAC asked/.test(driveOnly.body) && /Drive box/.test(driveOnly.body) && !/^.{0,160}sign-in/.test(driveOnly.body));
check('drive.file gap for a Sheets/Docs user says which tools fail', /Sheets and Docs/.test(driveOnly.body));

const driveOnlyNoRules = describeMissingGoogleAccess({ gmail: true, driveFile: false }, false)!;
check('drive.file gap without Sheets/Docs rules is the softer copy and says to tick the box', !/rules depend/.test(driveOnlyNoRules.body) && /Sheets and Docs/.test(driveOnlyNoRules.body) && /tick the Google Drive box/.test(driveOnlyNoRules.body));

const gmailOnly = describeMissingGoogleAccess({ gmail: false, driveFile: true }, false)!;
check('gmail gap names gmail', gmailOnly.missing.length === 1 && gmailOnly.missing[0] === 'gmail');
check('gmail gap title mentions Gmail', /Gmail/.test(gmailOnly.title));
check('gmail gap mentions the unchecked checkbox', /checkbox/.test(gmailOnly.body));

const none = describeMissingGoogleAccess({ gmail: false, driveFile: false }, true)!;
check('no access lists both scopes', none.missing.length === 2);
check('no access keeps the connect button label', none.button === 'Sign in with Google');

const dead = describeMissingGoogleAccess({ gmail: false, driveFile: false, disconnected: true }, true)!;
check('dead grant lists both scopes', dead.missing.length === 2);
check('dead grant says reconnect, not connect', dead.title === 'Action Required: Reconnect Google' && dead.button === 'Reconnect Google');
check('dead grant names the causes (revoked / password / aged out)', /revoked/.test(dead.body) && /password/.test(dead.body));
check('dead grant says agent calls are refused until reconnected', /refused until you reconnect/.test(dead.body));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll google-scope-copy checks passed.');
