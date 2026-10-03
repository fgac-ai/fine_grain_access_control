# Fine-Grained Access Control for Google APIs: Architecture & Strategy

## 1. Problem Statement
When giving AI agents access to Google APIs (like Gmail) on behalf of users, standard OAuth scopes (like `https://mail.google.com/`) provide overly broad access. This creates a "Rogue Agent" or "Confused Deputy" risk, where an agent could maliciously or accidentally delete important files, read sensitive emails, or perform destructive actions outside its intended scope.

The goal is to provide a proxy or gateway that intercepts agent requests to Google APIs, validates them against fine-grained rules (e.g., "Agent can only read files within Folder X", "Agent cannot use HTTP DELETE"), and forwards valid requests to Google. Crucially, we want to allow developers to use **off-the-shelf Google SDKs** with minimal friction.

## 2. Key Findings & Constraints

1. **Service Accounts vs. Proxies**: For Google Workspace APIs like Drive and Calendar, sharing specific resources directly with a Service Account is heavily underutilized but provides native, perfect isolation without needing a proxy. However, this model breaks down completely for Gmail (which requires Domain-Wide Delegation and grants full inbox access). To secure Gmail, a custom proxy is required.
2. **Tokens and Bypassing**: Giving self-modifying agents real Google Access Tokens is dangerous. An agent could simply rewrite its code to bypass our proxy and talk directly to `googleapis.com`. We must issue "Fake" tokens from a **Token Vault** that standard SDKs will pass to our proxy. If the agent tries to use the fake token directly with Google, it receives a 401 Unauthorized.
3. **The "Zero Code" Myth**: It is architecturally impossible to securely reroute official Google SDK HTTP traffic to a proxy using *only* a custom credential file. The developer must make a code configuration change (specifying an API endpoint override) or the deployment environment must enforce traffic routing via proxy variables/hijacking.

> **Note (April 2026):** We tested Google's `universe_domain` feature as a potential workaround to the Zero Code constraint. It does not work for Google Workspace APIs (Gmail, Calendar, Drive). The `googleapis` npm package and `google-api-python-client` hardcode API endpoints to `*.googleapis.com` regardless of `universe_domain`. See [ADR-001](adr/001_universe_domain_rejection.md) for full technical evidence.

## 3. The 3-Pronged Go-To-Market Strategy

To balance developer experience (DX) and perfect security across our target markets, we will pursue the following structured approach:

### Prong 1: Developer API Endpoint Override (PLG)
**Target**: Individual developers, startups, and open-source agent tinkerers.
**Approach**: We issue developers a fake `proxy_credentials.json` file. The developer uses the standard Google SDK but adds a single line of configuration to override the default root URL.

> **Note:** Each Google SDK uses a different parameter to override the API base URL, and the values differ:
> - **Python `api_endpoint`** replaces `rootUrl + servicePath`. You must include the service path (e.g., `/gmail/v1`).
> - **Node.js `rootUrl`** replaces only the domain. The SDK appends the service path automatically. Any path in `rootUrl` is stripped.

*   **Python Example**: `client_options={'api_endpoint': 'https://gmail.proxy.ourdomain.com/gmail/v1'}`
*   **Node.js Example**: `rootUrl: 'https://gmail.proxy.ourdomain.com/'`
*   **cURL Example**: `curl https://gmail.proxy.ourdomain.com/gmail/v1/users/me/messages`

**Pros**: Low friction, uses official SDKs, completely prevents agent bypass (via the fake token).
**Flaws & Risks**:
*   **The "Leaky Abstraction"**: Google's client libraries are finicky about pagination and file uploads when using custom endpoints. If an agent tries to upload an attachment to an email, the SDK might attempt to hit a specialized upload URI (like `https://www.googleapis.com/upload/gmail/v1/...` instead of the standard REST URI). The proxy must be engineered to catch and correctly map **all** varieties of Google's endpoint structures, or the standard code will mysteriously crash.

### Prong 2: Wrapper SDKs (Mid-Market)
**Target**: Application developers wanting a completely "zero-thought" integration.
**Approach**: We publish thin wrapper libraries (e.g., `npm install @ourcompany/google-api-proxy`). The developer changes their import statement, and we handle the authentication, fake token injection, and endpoint overriding dynamically behind the scenes.

**Pros**: Easiest developer experience; literally just changing an import statement.
**Flaws & Risks**:
*   **Maintenance Hell**: Google's API surface is massive and changes weekly. Attempting to write a wrapper that perfectly mimics every single Google method will fail.
*   **The Mitigation**: The wrapper SDK must be incredibly "dumb." It should only act as a custom factory/initializer that authenticates and immediately returns the *official*, unmodified Google Service Object (with the `api_endpoint` cleanly injected into it).

### Prong 3: HTTPS Proxy & MITM (Enterprise B2B)
**Target**: Enterprise IT Admins, CISOs, Corporate deployments.
**Approach**: We provide a containerized gateway. IT Admins deploy it in their VPC, install our custom Root CA on their Corporate infrastructure, and set the system `HTTPS_PROXY` environment variable.

**Pros**: The Holy Grail of B2B. Zero code changes required for the agents. IT guarantees compliance and safety across the entire organization.
**Flaws & Risks**:
*   **Certificate Pinning**: Some modern HTTP clients or specialized agent frameworks hardcode (pin) Google's actual TLS certificates into their source code to explicitly prevent MITM attacks. If an agent uses a pinned HTTP client, the MITM proxy will be violently rejected, even if the IT admin installed the Root CA.
*   **Support Overhead**: Debugging Enterprise TLS/SSL issues is notoriously expensive. A rock-solid diagnostic tool must be built into the proxy to prove "It's your firewall, not us."
*   **Latency & Compliance (SOC2/HIPAA)**: Decrypting, inspecting, and re-encrypting every payload adds latency. Furthermore, the proxy will temporarily hold highly sensitive corporate data (emails) in its memory. Enterprise customers will demand strict SOC2/HIPAA compliance proving the proxy doesn't log decrypted payloads.

## 4. MCP Server — Agent Connection & Pending Approval

### Overview
In addition to the REST proxy (Prong 1), we now operate a production MCP server at `/api/mcp`. This enables native integration with MCP-compatible clients (Claude Code, OpenClaw via remote MCP).

### Architecture
```
Agent (Claude Code) → OAuth via Clerk → MCP Server → Pending Approval → Proxy Key → Gmail API
```

**Key components:**
- **`/api/mcp/route.ts`** — Production MCP handler with Gmail tools
- **`agent_connections` table** — Tracks OAuth client connections per user
- **`/.well-known/oauth-*`** — RFC 9728 discovery endpoints (via Clerk)

### Pending Approval Flow
1. Agent authenticates via OAuth (Clerk handles DCR + consent)
2. MCP server creates a `pending` connection record
3. All tool calls return "pending approval" with a dashboard link
4. User approves in dashboard, assigns a proxy key (agent profile)
5. Subsequent tool calls use that key's email access and rules

### Permission Chain
```
OAuth Token → userId + clientId → agent_connections → proxy_key →
  key_email_access → Clerk Google Token → Gmail API
```

### Multi-Email Support
Each proxy key can access multiple email accounts (via `key_email_access`):
- Own email: always accessible if mapped to the key
- Delegated emails: resolved via `email_delegations` table
- Google tokens: fetched from Clerk for the email owner

### Distribution Channels
| Channel | Method | Best For |
|---------|--------|----------|
| Claude Code | Remote MCP server (`claude mcp add`) | Native MCP clients |
| OpenClaw | Local scripts + REST proxy API | Code flexibility, full API surface |
| CLI | `npx fgac auth login` (separate npm package) | Power users, headless flows |
| Direct API | `Bearer sk_proxy_...` to `gmail.fgac.ai` | Custom integrations |

### Google Sheets, Docs & Slides Per-File Access Control (`drive.file`)
In addition to Gmail, FGAC natively supports Google Sheets, Google Docs, and Google Slides using Google's **Per-File Access Scope (`https://www.googleapis.com/auth/drive.file`)**.

#### Key Architecture Principles for Per-File Access:
1. **Zero CASA Audit Overhead**: Utilizing `drive.file` scope avoids restricted scope audits, requiring only standard Google verification (3-7 days, $0 cost). Adding Docs required **no new OAuth scope** — the same per-file grants serve every file type; Slides (2026-09-17) likewise added nothing to the consent screen. What Slides DID need is the Google Slides API enabled on the GCP project behind the OAuth client — a console action, not a scope.
2. **Google Picker Integration**: Users intentionally select specific spreadsheets/documents via the native Google Picker UI (`SPREADSHEETS` or `DOCUMENTS` view). Google's servers bind file permissions directly to the app's scope grant on Google's authorization servers.
3. **FGAC Per-File Rules**: For each exposed file, users configure per-file permissions in the dashboard (`sheet_*` action types for spreadsheets, `doc_*` for documents):
   - **`sheet_read` / `doc_read` (Read Only)**: Agents can read (`GET`), but mutating operations return `403 Forbidden`.
   - **`sheet_read_write` / `doc_read_write` / `slide_read_write` (Read & Write)**: Agents can read and write. Note: the Docs and Slides APIs' only write endpoint is `batchUpdate`, so Read & Write on a document or presentation permits full-file editing — the dashboard copy states this plainly.
   - **`sheet_block` / `doc_block` (Blocked)**: Explicitly denies all agent operations for that file ID while keeping the underlying Google grant.
4. **MCP Tools**: Sheets — `sheets_get_spreadsheet`, `sheets_read_range`, `sheets_update_range`, `sheets_append_rows`, `sheets_edit` (native batchUpdate requests: formatting, charts, tabs). Docs — `docs_read_document` (returns the raw Docs API resource; optional `fields` mask for large documents), `docs_edit` (native batchUpdate requests: text, tables, styles). Slides — `slides_get_presentation` (raw Slides API resource, `fields` mask + windowing), `slides_edit` (native batchUpdate: slides, shapes, text, images). Cross-service — `comments_read` / `comments_add` (Drive-API comments, enforced by the file's rule). Agent-created files are auto-granted read & write to the creating key — raw `POST v4/spreadsheets` / `POST v1/documents` / `POST v1/presentations`, and since 2026-09-16 the Drive-side creates too (`POST drive/v3/files`, `POST drive/v3/files/{id}/copy`), because `drive.file` treats a file the app copies or uploads as app-owned exactly like one it creates natively; a copy additionally requires the source file to be exposed (any non-blocked rule) to the calling key.
5. **Kind descriptor**: everything per-file (rules, Picker exposure, grant verification, recovery pages, approval links, raw-API classification and host routing, dashboard cards, analytics names) keys off `src/lib/driveFileKinds.ts`. Slides (2026-09-17) was the acceptance test: it shipped as a descriptor entry, two tool definitions/registrations, three thin route/page files, and QA docs; the sheet/doc ternaries that had crept back into shared code were folded into descriptor fields rather than grown into three-way branches. The next file type must follow the same shape — shared code must not grow `if (kind === ...)` branches.

### Google Drive Tree Access (full `drive` scope, feature-flagged — 2026-10-01)
Behind a per-user feature flag — the PostHog feature flag `drive_tree`, evaluated server-side for the user's Clerk id with their email as a person property (so one email condition covers the dev and production Clerk instances), cached per user for a minute and failing closed; `FGAC_DRIVE_TREE` / `FGAC_DRIVE_TREE_USERS` are env overrides for local dev and CI only (`src/lib/featureFlags.ts`) — a profile scopes Google Drive by **folder** instead of file by file. The model (`src/lib/driveTreeAccess.ts`, pure; plan `docs/implementation_plans/claude_google-drive-permissions-ux-427163_v1.md`; design canvas "Drive Agent Permissions UX"):

1. **A default for every file** — `proxy_keys.drive_default`: Read everything (the default), Read & write everything, or Only files I allow. The quick option applies everywhere: My Drive, Shared with me, Shared drives.
2. **Settings on nodes** — `access_rules` rows with `service='drive'`, `target_kind` (`file` / `folder` / `shared_drive` / `shared_with_me` / `shared_drives`) and `drive_read` / `drive_read_write` / `drive_block`, assigned to the profile like any rule. A setting on a folder applies to everything inside it; **the nearest setting on the file's lineage wins**, in both directions (a Write on a file inside a Blocked folder allows, a Block on a file inside a Write folder blocks). Blocked files are invisible: reads deny and listings withhold them.
3. **Legacy per-file rules are file-level settings** (`sheet_*` / `doc_*` / `slide_*` from the Picker, approval links and the agent-created-file auto-grant), so nothing an existing user set changes meaning when their flag turns on; a tree setting on the same node outranks them.
4. **Lineage** (`src/lib/driveLineage.ts`): one `files.get` per uncached hop with the user's own token (`parents`, `driveId`, `ownedByMe`), cached per (user, file) for 10 minutes; a 404 mid-chain ends at the `shared-with-me` pseudo-root, a shared-drive root ends at `shared-drives`; any other Google failure fails closed (`lineage_unavailable`); 25-hop safety cap.
5. **Two gates, both required**: the flag, and the live token carrying `https://www.googleapis.com/auth/drive` (tokeninfo, never Clerk's record). A flagged user still on `drive.file` sees the legacy cards plus an "Enable full Drive access" card; the scope is requested **only** there (in-place `reauthorize`, consent prompt) and in the nav UserButton's connect-account scopes for flagged users. Nobody else's sign-in, reconnect or Picker flow mentions `drive`. The restricted scope needs Google verification (CASA) before the flag goes beyond ≤100 test users in production.
6. **Enforcement doors**: the MCP route's `checkFilePermission` (typed Sheets/Docs/Slides tools, comments, raw per-file calls), the id-addressed Drive guard (`checkDriveFileAccess` — every file kind, PDFs included), `files/{id}/copy`, raw `drive/v3/files` listings (forwarded with a widened `fields` mask, then filtered, `withheld: n`), and the REST proxy's Drive-file guard, per-kind handlers and listings — all through the same resolver. The engine context rides a dedicated AsyncLocalStorage store (`toolCallContext.ts`) so the token never enters the analytics bag. `get_my_permissions.defaults.drive` states the posture. Delegated mailboxes stay on the per-file path.
7. **Dashboard** (`DriveAccessCard`): the three roots as a lazy tree (`/api/drive/children`), search across the whole Drive with each hit's path (`/api/drive/search`), a folder view whose breadcrumb is the inheritance chain (pills only on folders that carry a setting), and an Inherit · Read · Write · Block control on every row that saves on change.
