/**
 * Placeholder-address detector for the caller-chosen `account` parameter.
 *
 * Why (production, 2026-09-21 → 09-23): one Claude.ai agent, a day after its
 * owner had delegated a real second mailbox to it, started passing two
 * INVENTED addresses on the RFC 2606 example domain — the local parts of the
 * mailboxes it wanted, with `@example.com` filled in — and re-sent both, in
 * parallel, on every turn: 140 `account_not_permitted` refusals in three
 * days, the pair repeated verbatim after every denial. Two of the four
 * owner-refusal emails FGAC has ever sent were about those two values — an
 * owner told "your task passes ufficio@example.com", an address nobody has.
 *
 * A value like that cannot be a mailbox anyone could delegate, so it is a
 * different situation from a real-but-unpermitted address: the fix is never
 * "add that account", it is "stop guessing and ask the user". Pure string
 * logic, so `scripts/test-placeholder-email.ts` pins it without a database.
 *
 * Deliberately narrow. A false positive costs an owner one email about a
 * value their agent genuinely meant (the 🚫 refusal itself is unchanged
 * either way); a false negative is the status quo. So: reserved names
 * (RFC 2606 / RFC 6761), the handful of template domains and local parts
 * that documentation samples use, and values that are not an address at
 * all. Real providers that merely sound generic (mail.com, email.com,
 * test.com's neighbours) are NOT on the list.
 */

export type PlaceholderKind =
  /** RFC 2606 / 6761 reserved: example.com/.net/.org, .test, .invalid, .localhost, .example. */
  | 'reserved_domain'
  /** Documentation-template values: a `user@` local part on `domain.com`, `john.doe@…`, `{email}`, … */
  | 'synthetic'
  /** Not an address: no `@`, no dot in the domain, spaces, brackets. */
  | 'malformed';

/** Second-level names reserved for documentation (RFC 2606 §3) — any subdomain counts. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org', 'example.edu'];
/** Top-level labels that can never resolve on the public internet (RFC 2606 §2, RFC 6761). */
const RESERVED_TLDS = new Set(['test', 'invalid', 'localhost', 'example', 'local']);

/** Domains that only ever appear as the sample in a form or a doc. */
const SYNTHETIC_DOMAINS = new Set([
  'domain.com', 'domain.tld', 'yourdomain.com', 'your-domain.com', 'yourcompany.com',
  'your-company.com', 'company.com', 'placeholder.com', 'sample.com', 'test.com',
  'email.tld', 'mail.tld', 'foo.com', 'bar.com', 'foo.bar', 'acme.com',
]);
/** Local parts that only ever appear as the sample — at ANY domain. */
const SYNTHETIC_LOCAL_PARTS = new Set([
  'firstname.lastname', 'first.last', 'john.doe', 'jane.doe', 'johndoe', 'janedoe',
  'your.email', 'your-email', 'youremail', 'your_email',
  'someone', 'somebody', 'nobody', 'username', 'yourname', 'your-name', 'your_name',
]);

const ADDRESS_SHAPE = /^[^\s@<>{}[\]()"]+@[^\s@<>{}[\]()"]+\.[^\s@<>{}[\]()".]+$/;

/**
 * Classify a caller-supplied `account` value. Returns `null` for anything
 * that could be a real mailbox (permitted or not — that is the access
 * check's job, not this one's).
 */
export function classifyPlaceholderEmail(value: string): PlaceholderKind | null {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return 'malformed';
  // Template markers — `<email>`, `{{account}}`, `[your address]` — and any
  // value without the local-part `@` domain `.` tld shape (spaces, missing
  // `@`, a bare host with no dot, `user@localhost`).
  if (!ADDRESS_SHAPE.test(v)) {
    const host = v.includes('@') ? v.slice(v.lastIndexOf('@') + 1) : '';
    if (host && !host.includes('.') && RESERVED_TLDS.has(host)) return 'reserved_domain';
    return 'malformed';
  }
  const at = v.lastIndexOf('@');
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  const labels = domain.split('.');
  const tld = labels[labels.length - 1];

  if (RESERVED_TLDS.has(tld)) return 'reserved_domain';
  if (RESERVED_DOMAINS.some(d => domain === d || domain.endsWith(`.${d}`))) return 'reserved_domain';

  if (SYNTHETIC_DOMAINS.has(domain)) return 'synthetic';
  if (SYNTHETIC_LOCAL_PARTS.has(local)) return 'synthetic';
  // `user@…` / `test@…` / `email@…` / `name@…` are only synthetic when the
  // domain is generic too — a `test@` local part on gmail.com can be somebody's real address,
  // and mail.com / email.com are real providers, so they are not "generic".
  if (/^(user|test|email|name|admin|info|example|sample|demo)[0-9]*$/.test(local)
      && /^(example|domain|test|sample|placeholder|company)\d*\.[a-z]+$/.test(domain)) {
    return 'synthetic';
  }
  return null;
}

export function isPlaceholderEmail(value: string): boolean {
  return classifyPlaceholderEmail(value) !== null;
}
