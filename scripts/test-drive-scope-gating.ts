/**
 * Guard: the full Google Drive scope (`https://www.googleapis.com/auth/drive`)
 * is REQUESTED from Google only for users on the `drive_tree` feature flag.
 * Run: npx tsx scripts/test-drive-scope-gating.ts  (part of `npm run mcp:lint`)
 *
 * Ken, 2026-10-03: "I want to make sure we are only asking for the escalated
 * permissions for people who are enabled with the feature flag." This is a
 * static scan of src/ so a future change cannot start requesting the scope
 * from a new place without updating the allowlists here on purpose.
 *
 * Two kinds of use are distinguished:
 *   - READERS inspect a token's scopes (tokeninfo) — allowed anywhere listed.
 *   - REQUESTERS hand the scope to a Google authorization (Clerk reauthorize /
 *     createExternalAccount / UserButton additionalOAuthScopes) — allowed only
 *     in the two flag-gated components, whose gating is asserted below.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (!cond) { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
  else console.log(`  ✓ ${name}`);
}

const ROOT = join(__dirname, '..', 'src');
const FULL_SCOPE = 'https://www.googleapis.com/auth/drive';
const SYMBOL = 'DRIVE_FULL_SCOPE';

/** Files allowed to name the full scope at all (readers + requesters). */
const READERS = new Set([
  'src/lib/googleTokenScopes.ts',        // verdicts from tokeninfo
  'src/app/dashboard/googleAccess.ts',   // dashboard access state
  'src/app/dashboard/googleReconnect.ts',// exports the constant; default request stays drive.file
  'src/lib/driveTreeServer.ts',          // Drive routes require the scope on the token
  'src/app/api/proxy/[...path]/route.ts',// engine gate reads the live token
  'src/app/dashboard/accounts/ReconnectGoogleButton.tsx', // post-reconnect verify treats a full-Drive token as satisfying drive.file; requests drive.file only
]);
/** Files allowed to REQUEST it — each must be flag-gated (asserted below). */
const REQUESTERS = new Set([
  'src/app/NavUserButton.tsx',
  'src/app/dashboard/EnableDriveAccessCard.tsx',
]);
const REQUEST_MARKERS = ['startGoogleReconnect(', 'additionalOAuthScopes', 'reauthorize(', 'createExternalAccount('];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const rel = (p: string) => p.slice(join(__dirname, '..').length + 1);
const namesFullScope = (src: string) => src.includes(`'${FULL_SCOPE}'`) || src.includes(`"${FULL_SCOPE}"`) || src.includes(SYMBOL);
/** A line that mentions the scope only to READ it (compare / includes / define / import / comment). */
const READ_LINE = [/\.includes\(/, /===/, /^\s*(export )?const DRIVE_FULL_SCOPE/, /^\s*import /, /^\s*\*/, /^\s*\/\//, /^\s*[^,]*, type /];
const scopeLines = (src: string) => src.split('\n').filter(l => l.includes(FULL_SCOPE) || l.includes(SYMBOL));

console.log('full Drive scope: who may name it, who may request it');
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const r = rel(file);
  if (!namesFullScope(src)) continue;
  const allowed = READERS.has(r) || REQUESTERS.has(r);
  check(`${r} is on the allowlist`, allowed, 'a new file names the full Drive scope: read-only inspection goes in READERS, a request site must be flag-gated and listed in REQUESTERS');
  if (!allowed) continue;
  if (READERS.has(r)) {
    // A reader may also REQUEST scopes (the Accounts reconnect button does),
    // but every line that names the full scope must be a read: a compare,
    // an includes(), the constant's definition, an import or a comment —
    // never an argument list handed to a Google authorization.
    const offending = scopeLines(src).filter(l => !READ_LINE.some(re => re.test(l)));
    check(`${r} only reads the scope`, offending.length === 0, offending.map(l => l.trim()).join(' | '));
    // googleReconnect.ts defines the request helper; it must not default to the full scope.
    if (r === 'src/app/dashboard/googleReconnect.ts') {
      check('googleReconnect default additionalScopes is drive.file, not the full scope', src.includes('additionalScopes: string[] = [DRIVE_FILE_SCOPE]'));
    }
    if (r === 'src/app/dashboard/accounts/ReconnectGoogleButton.tsx') {
      check('ReconnectGoogleButton requests gmail + drive.file only', src.includes('[GMAIL_MODIFY_SCOPE, DRIVE_FILE_SCOPE]') && !REQUEST_MARKERS.some(m => scopeLines(src).some(l => l.includes(m))));
    }
  }
}

console.log('the two request sites are flag-gated');
const nav = readFileSync(join(ROOT, 'app/NavUserButton.tsx'), 'utf8');
check('NavUserButton asks the server flag route before widening', nav.includes("fetch('/api/drive/flag')"));
check('NavUserButton adds the full scope only in the flag-true branch', nav.includes('driveTree ? [GMAIL_MODIFY_SCOPE, DRIVE_FULL_SCOPE] : [GMAIL_MODIFY_SCOPE]'));
const flagRoute = readFileSync(join(ROOT, 'app/api/drive/flag/route.ts'), 'utf8');
check('/api/drive/flag answers from driveTreeFlagOn (PostHog flag + local override)', flagRoute.includes('driveTreeFlagOn('));

const view = readFileSync(join(ROOT, 'app/dashboard/AgentProfilesView.tsx'), 'utf8');
const enableIdx = view.indexOf('<EnableDriveAccessCard');
const gateIdx = view.lastIndexOf('driveTree?.flagOn && (', enableIdx);
check('EnableDriveAccessCard renders only under driveTree?.flagOn', enableIdx > 0 && gateIdx > 0 && enableIdx - gateIdx < 200);
const treeIdx = view.indexOf('<DriveAccessCard');
const treeGate = view.lastIndexOf('driveTree?.flagOn && driveTree.hasFullScope', treeIdx);
check('DriveAccessCard renders only with the flag AND the scope', treeIdx > 0 && treeGate > 0 && treeIdx - treeGate < 400);

const enable = readFileSync(join(ROOT, 'app/dashboard/EnableDriveAccessCard.tsx'), 'utf8');
check('EnableDriveAccessCard requests gmail + full drive with a consent prompt (refresh token)', enable.includes('[GMAIL_MODIFY_SCOPE, DRIVE_FULL_SCOPE]') && enable.includes("'consent'"));

console.log('the legacy request sites stay on drive.file');
for (const legacy of ['app/dashboard/ConnectGoogleWarning.tsx', 'app/dashboard/useGooglePicker.ts']) {
  const src = readFileSync(join(ROOT, legacy), 'utf8');
  check(`${legacy} never names the full scope`, !namesFullScope(src));
}
const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
check('layout.tsx delegates the UserButton scopes to NavUserButton (no inline scope list)', layout.includes('<NavUserButton />') && !layout.includes('additionalOAuthScopes'));

if (failures > 0) {
  console.error(`\n${failures} Drive scope gating check(s) failed`);
  process.exit(1);
}
console.log('\nAll Drive scope gating checks passed');
