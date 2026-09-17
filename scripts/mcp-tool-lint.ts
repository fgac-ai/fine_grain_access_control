/**
 * MCP tool-registry lint — the standing Anthropic Connectors Directory
 * invariants, enforced in CI (chained into `npm run lint`).
 *
 * Once the connector is listed, every deploy to main goes live for directory
 * users with no re-review, so these must hold on every commit:
 *   1. Every tool has a non-empty `title`.
 *   2. Every tool is readOnly (→ readOnlyHint) or declares `destructive`
 *      explicitly (→ destructiveHint).
 *   3. Tool names are ≤ 64 chars, [a-zA-Z0-9_-] only.
 *   4. No tool forwards both safe (GET/HEAD/OPTIONS) and unsafe HTTP methods.
 *   5. DELETE is never forwarded.
 *   6. Freeform-path tools name the target API docs in their description.
 *   7. Descriptions are non-empty and don't instruct the model how to behave.
 *   8. Convenience tools with a raw-API superset name their fallback tool in
 *      the description (the typed layer is capped-with-redirects: agents read
 *      catalogs as paths, so every dead end must point at the full surface).
 *   9. Descriptions stay under a length cap (directory token-frugality).
 */
import { TOOL_DEFS, type FgacToolDef } from '../src/app/api/mcp/toolDefs';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Typed convenience tools and the raw-pair tool their description must
// reference as the fallback for operations they cannot express.
const REQUIRED_FALLBACK_REF: Record<string, string> = {
  gmail_list: 'google_api_get',
  gmail_read: 'google_api_get',
  gmail_send: 'google_api_modify',
  sheets_update_range: 'sheets_edit',
  sheets_append_rows: 'sheets_edit',
  sheets_edit: 'google_api_modify',
  docs_read_document: 'docs_edit',
  docs_edit: 'google_api_modify',
  slides_get_presentation: 'slides_edit',
  slides_edit: 'google_api_modify',
};

const MAX_DESCRIPTION_CHARS = 1500;
const errors: string[] = [];

const defs = Object.values(TOOL_DEFS) as FgacToolDef[];

for (const def of defs) {
  const where = `tool '${def.name}'`;

  if (def.name.length > 64) errors.push(`${where}: name exceeds 64 characters`);
  if (!/^[a-zA-Z0-9_-]+$/.test(def.name)) errors.push(`${where}: name has invalid characters`);
  if (!def.title?.trim()) errors.push(`${where}: missing title`);
  if (!def.description?.trim()) errors.push(`${where}: missing description`);

  if (!def.readOnly && typeof def.destructive !== 'boolean') {
    errors.push(`${where}: write tools must declare 'destructive' explicitly (→ destructiveHint)`);
  }
  if (def.readOnly && def.destructive !== undefined) {
    errors.push(`${where}: readOnly tools must not declare 'destructive'`);
  }

  if (def.freeformMethods) {
    const methods = def.freeformMethods.map(m => m.toUpperCase());
    const hasSafe = methods.some(m => SAFE_METHODS.has(m));
    const hasUnsafe = methods.some(m => !SAFE_METHODS.has(m));
    if (hasSafe && hasUnsafe) {
      errors.push(`${where}: mixes safe and unsafe HTTP methods — split into separate read/write tools (directory auto-reject)`);
    }
    if (methods.includes('DELETE')) {
      errors.push(`${where}: forwards DELETE — FGAC never exposes deletion`);
    }
    if (hasSafe && !def.readOnly) errors.push(`${where}: forwards only safe methods but is not readOnly`);
    if (hasUnsafe && def.readOnly) errors.push(`${where}: forwards unsafe methods but is marked readOnly`);
    if (!/developers\.google\.com|https:\/\/\S+\/docs/.test(def.description)) {
      errors.push(`${where}: freeform-path tools must link the target API docs in the description`);
    }
  }

  const lowered = def.description.toLowerCase();
  for (const phrase of ['ignore previous', 'you must always', 'do not tell the user', 'system prompt']) {
    if (lowered.includes(phrase)) errors.push(`${where}: description contains behavioral instruction ('${phrase}')`);
  }

  const fallback = REQUIRED_FALLBACK_REF[def.name];
  if (fallback && !def.description.includes(fallback)) {
    errors.push(`${where}: convenience tool must reference its raw fallback '${fallback}' in the description`);
  }
  if (def.description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`${where}: description exceeds ${MAX_DESCRIPTION_CHARS} chars (token frugality)`);
  }
}

const names = defs.map(d => d.name);
if (new Set(names).size !== names.length) errors.push('duplicate tool names in TOOL_DEFS');

if (errors.length > 0) {
  console.error(`mcp-tool-lint: ${errors.length} violation(s):`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log(`mcp-tool-lint: ${defs.length} tools OK (titles, annotations, method separation, name length)`);
