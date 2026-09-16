import { pgTable, text, timestamp, uuid, uniqueIndex, jsonb, integer, boolean } from 'drizzle-orm/pg-core';

// ─── Users ───────────────────────────────────────────────────────────────────
// Core user table. proxyKey removed — keys now live in proxy_keys table.
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email').notNull(), // Primary Clerk email
  // Set when the backing Clerk account is deleted. The row is kept for audit,
  // but it is inert: its proxy keys and delegations are revoked, and a later
  // sign-up with the same address starts a fresh account rather than inheriting
  // this one. NULL = live user.
  deletedAt: timestamp('deleted_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Proxy Keys ──────────────────────────────────────────────────────────────
// Multiple keys per user, each with a label and optional invalidation/TTL.
export const proxyKeys = pgTable('proxy_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  key: text('key').notNull().unique(), // "sk_proxy_xxx"
  publicKey: text('public_key'), // RSA Public Key PEM
  label: text('label').notNull(), // "Claude Agent", "Work Bot"
  // Marks the auto-created "Default Profile" that new MCP connections attach
  // to (instant-start, connector-growth plan). At most one live default per
  // user; found by flag, never by label.
  isDefault: boolean('is_default').notNull().default(false),
  revokedAt: timestamp('revoked_at'), // NULL = active, set = revoked
  expiresAt: timestamp('expires_at'), // optional TTL
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Approval Link Consumptions (DEPRECATED) ────────────────────────────────
// Single-use enforcement for the retired JWT approval links. Nothing reads or
// writes this table since 2026-08-25 (links became deterministic and are no
// longer single-use), but it is deliberately NOT dropped in the same change
// that stops using it: a rollback of that deploy would need it to exist.
// Drop it in a follow-up migration once the redesign is confirmed in
// production. Kept in the schema so drizzle does not generate a drop.
export const approvalConsumptions = pgTable('approval_consumptions', {
  jti: text('jti').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  consumedAt: timestamp('consumed_at').defaultNow().notNull(),
});

// ─── Approval Requests ──────────────────────────────────────────────────────
// One row per approval REQUEST, keyed by the deterministic request_id from
// approvalLinks.ts. Replaced approval_consumptions (single-use jti tracking)
// on 2026-08-25 when links became deterministic and permanent.
//
// This table is the unit of analysis the old telemetry lacked. Because
// request_id is stable across retries, `mintCount` separates DEMAND (one row)
// from RETRY PRESSURE (mintCount), which link-level counting conflated —
// that conflation is what made a funnel converting near 58% report as 31%.
// `openedAt` makes "minted but never opened" answerable in SQL without
// depending on the analytics pipeline.
//
// targetHash is hashed, never the raw id: spreadsheet ids, document ids, and
// recipient addresses are customer data.
export const approvalRequests = pgTable('approval_requests', {
  requestId: text('request_id').primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  proxyKeyId: uuid('proxy_key_id').references(() => proxyKeys.id, { onDelete: 'cascade' }).notNull(),
  action: text('action').notNull(),
  targetHash: text('target_hash'),
  mintCount: integer('mint_count').notNull().default(1),
  firstMintedAt: timestamp('first_minted_at').defaultNow().notNull(),
  lastMintedAt: timestamp('last_minted_at').defaultNow().notNull(),
  openedAt: timestamp('opened_at'),
  approvedAt: timestamp('approved_at'),
  // Human-readable title of the file behind a sheets/docs request, when the
  // agent supplied one via request_access. The approve page can only show
  // Google's file id for a file Google does not share with FGAC yet, and the
  // Picker lists files by NAME — so without this the user has to map an
  // opaque id onto a sheet title themselves (the 2026-09 Picker-cancel leak).
  // First non-empty value wins; never carried in the URL.
  resourceName: text('resource_name'),
});

// ─── Email Delegations ───────────────────────────────────────────────────────
// Tracks cross-user email delegation. Owner grants delegate permission to
// create API keys/rules that access the owner's Gmail.
// The owner's Clerk user has the Google OAuth token — Clerk is the token vault.
// A user's OWN email is always implicitly accessible (no delegation needed).
export const emailDelegations = pgTable('email_delegations', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  delegateUserId: uuid('delegate_user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  status: text('status').notNull().default('active'), // 'active', 'revoked'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  revokedAt: timestamp('revoked_at'),
}, (table) => [
  uniqueIndex('delegation_unique').on(table.ownerUserId, table.delegateUserId),
]);

// ─── Key ↔ Email Access ─────────────────────────────────────────────────────
// Join table: which proxy keys can access which emails.
// References either a delegation (for cross-user access) or NULL delegation
// with a target email (for own-email access).
// If a key has no rows here, it can access NO emails (deny by default).
export const keyEmailAccess = pgTable('key_email_access', {
  id: uuid('id').defaultRandom().primaryKey(),
  proxyKeyId: uuid('proxy_key_id').references(() => proxyKeys.id, { onDelete: 'cascade' }).notNull(),
  // For delegated emails, this references the delegation.
  // For own-email access, this is NULL and targetEmail is set instead.
  delegationId: uuid('delegation_id').references(() => emailDelegations.id, { onDelete: 'cascade' }),
  // The email address this key can access (denormalized for query convenience).
  targetEmail: text('target_email').notNull(),
}, (table) => [
  uniqueIndex('key_email_unique').on(table.proxyKeyId, table.targetEmail),
]);

// ─── Access Rules ────────────────────────────────────────────────────────────
// Fine-grained access control rules. Scoped to a user, optionally to a specific email or resource.
// Rules with no key_rule_assignments rows are GLOBAL (apply to all keys).
export const accessRules = pgTable('access_rules', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  targetEmail: text('target_email'), // NULL = applies to all emails, or specific email address
  ruleName: text('rule_name').notNull(), // e.g., "Block Project X" or "Q3 Financials Read Only"
  service: text('service').notNull(), // 'gmail', 'sheets', 'docs'
  actionType: text('action_type').notNull(), // Gmail: 'read_blacklist', 'send_whitelist', etc. | Sheets: 'sheet_read', 'sheet_read_write', 'sheet_block' | Docs: 'doc_read', 'doc_read_write', 'doc_block'
  regexPattern: text('regex_pattern'), // Optional: Gmail regex pattern or label ID
  targetResourceId: text('target_resource_id'), // e.g. spreadsheetId (sheets) or documentId (docs)
  resourceName: text('resource_name'), // e.g. human-readable document title "Q3 Financials"
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Key ↔ Rule Assignments ─────────────────────────────────────────────────
// Join table: maps access rules to specific proxy keys.
// If a rule has NO rows here, it is a GLOBAL rule (applies to ALL keys for that user).
// If a rule has rows, it ONLY applies to those specific keys.
// ─── Waitlist ────────────────────────────────────────────────────────────────
// Captures both partial and completed waitlist / beta sign-up submissions.
export const waitlist = pgTable('waitlist', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email'),
  numAccounts: text('num_accounts'),
  priceTooCheap: text('price_too_cheap'),
  priceBargain: text('price_bargain'),
  priceExpensive: text('price_expensive'),
  priceTooExpensive: text('price_too_expensive'),
  pricingModelPreference: text('pricing_model_preference'), // 'seat-based vs usage-based'
  wantsBeta: text('wants_beta'), // stored as text or boolean, using text for flexibility (e.g. 'true'/'false')
  agreedToInterview: text('agreed_to_interview'),
  agreedToBetaPricing: text('agreed_to_beta_pricing'),
  comfortableWithUnverifiedApp: text('comfortable_with_unverified_app'),
  status: text('status').default('partial'), // 'partial', 'completed'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const keyRuleAssignments = pgTable('key_rule_assignments', {
  id: uuid('id').defaultRandom().primaryKey(),
  proxyKeyId: uuid('proxy_key_id').references(() => proxyKeys.id, { onDelete: 'cascade' }).notNull(),
  accessRuleId: uuid('access_rule_id').references(() => accessRules.id, { onDelete: 'cascade' }).notNull(),
}, (table) => [
  uniqueIndex('key_rule_unique').on(table.proxyKeyId, table.accessRuleId),
]);

// ─── Agent Connections ──────────────────────────────────────────────────────
// Tracks OAuth client connections from MCP agents/apps.
// Each unique (userId, clientId) pair is one "connection".
// Connections start as 'pending' — the user must approve them in the dashboard
// and bind them to a proxy key (agent profile) before they can access anything.
// Once approved, reconnections with the same clientId auto-inherit permissions.
export const agentConnections = pgTable('agent_connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  clientId: text('client_id').notNull(),          // From DCR registration
  clientName: text('client_name'),                 // From DCR metadata (e.g., "claude-desktop")
  nickname: text('nickname'),                      // User-assigned label (e.g., "My Work Agent")
  proxyKeyId: uuid('proxy_key_id').references(() => proxyKeys.id, { onDelete: 'set null' }), // NULL = pending
  status: text('status').notNull().default('pending'), // 'pending', 'approved', 'blocked'
  // Partner-app provenance: set when the connection was provisioned through the
  // /oauth/authorize consent interstitial for a registered partner app. The
  // manifestVersion pins which manifest revision the user consented to — a
  // registry manifest bump must NOT widen this connection until re-consent.
  partnerAppId: uuid('partner_app_id').references(() => partnerApps.id, { onDelete: 'set null' }),
  manifestVersion: integer('manifest_version'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  approvedAt: timestamp('approved_at'),
  lastUsedAt: timestamp('last_used_at'),
}, (table) => [
  uniqueIndex('connection_user_client_unique').on(table.userId, table.clientId),
]);

// ─── Partner Apps ───────────────────────────────────────────────────────────
// Registry of third-party applications that hand their users off to FGAC via
// the /oauth/authorize consent interstitial. Registered out-of-band by
// scripts/register-partner-app.ts (which also creates the pre-registered Clerk
// OAuth application with consent_screen_enabled=false — FGAC's interstitial is
// the ONLY consent screen). The manifest declares the app's requested "agent
// role"; consent-time provisioning copies it into concrete keys/rules so later
// manifest edits can never silently widen existing grants.
export const partnerApps = pgTable('partner_apps', {
  id: uuid('id').defaultRandom().primaryKey(),
  clientId: text('client_id').notNull().unique(),  // Clerk OAuth app client_id
  clerkOauthAppId: text('clerk_oauth_app_id'),     // Clerk "oa_..." id, for admin ops
  name: text('name').notNull(),                    // e.g. "Data Driven Job Search"
  logoUrl: text('logo_url'),
  // { services: ['gmail'], access: 'read_only', rule_templates: [...],
  //   notifications?: { trigger: 'new_email' } }
  manifest: jsonb('manifest').notNull(),
  manifestVersion: integer('manifest_version').notNull().default(1),
  redirectUris: jsonb('redirect_uris').notNull(),  // string[] — validated on /oauth/authorize
  webhookUrl: text('webhook_url'),                 // partner's notification receiver
  webhookSecret: text('webhook_secret'),           // HMAC-SHA256 signing secret
  status: text('status').notNull().default('active'), // 'active', 'suspended'
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Notification Subscriptions ─────────────────────────────────────────────
// One row per (partner connection, watched mailbox). Created inside the consent
// provisioning transaction when the partner's manifest requests notifications.
// lastHistoryId is the Gmail history cursor the diff resumes from; the watch is
// re-armed by /api/cron/renew-watches (Gmail watches expire after 7 days).
export const notificationSubscriptions = pgTable('notification_subscriptions', {
  id: uuid('id').defaultRandom().primaryKey(),
  connectionId: uuid('connection_id').references(() => agentConnections.id, { onDelete: 'cascade' }).notNull(),
  targetEmail: text('target_email').notNull(),
  lastHistoryId: text('last_history_id'),
  watchExpiresAt: timestamp('watch_expires_at'),   // NULL = watch not armed (cron retries)
  status: text('status').notNull().default('active'), // 'active', 'suspended', 'cancelled'
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('subscription_connection_email_unique').on(table.connectionId, table.targetEmail),
]);

// ─── Webhook Deliveries ─────────────────────────────────────────────────────
// The delivery outbox AND the user-facing audit trail. One row per
// (subscription, Gmail message) — the unique index is what makes Pub/Sub's
// at-least-once redelivery idempotent. The drainer groups due rows per
// subscription into one thin ping (message IDs only, never content).
// Backoff ladder: 1m, 5m, 15m, 1h, 6h, 24h → dead.
export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').defaultRandom().primaryKey(),
  subscriptionId: uuid('subscription_id').references(() => notificationSubscriptions.id, { onDelete: 'cascade' }).notNull(),
  messageId: text('message_id').notNull(),         // Gmail message id (opaque to us)
  status: text('status').notNull().default('pending'), // 'pending', 'delivering', 'delivered', 'dead'
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at').defaultNow().notNull(),
  lastError: text('last_error'),
  deliveredAt: timestamp('delivered_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => [
  uniqueIndex('delivery_subscription_message_unique').on(table.subscriptionId, table.messageId),
]);

// ─── Short Links (QR / flyer tracking) ──────────────────────────────────────
// One row per printed QR / short URL variant: fgac.ai/go/<slug> 302s to
// `destination` with UTM params appended, so PostHog can attribute downstream
// conversion to the physical variant. Slugs are operator-managed via
// scripts/short-links.ts (there is no UI); `destination` stays editable so a
// printed QR can be re-pointed without reprinting. Per-scan detail lives in
// the `flyer_scanned` PostHog event, not here — this table only keeps the
// running counter, so no per-scan PII (IP/UA) is ever stored. The counter is
// deliberately a second tally: PostHog query access needs a personal API key
// that is not provisioned everywhere (see docs/analytics.md), so
// `npm run links -- list` must answer "did anyone scan?" on its own.
export const shortLinks = pgTable('short_links', {
  slug: text('slug').primaryKey(),
  destination: text('destination').notNull(),      // absolute URL or site-relative path
  campaign: text('campaign').notNull(),            // e.g. 'fall26'
  variant: text('variant'),                        // e.g. headline 'u' / 's'
  channel: text('channel'),                        // e.g. 'umich-kiosk', 'emu-boards'
  notes: text('notes'),
  scanCount: integer('scan_count').notNull().default(0),
  lastScannedAt: timestamp('last_scanned_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
