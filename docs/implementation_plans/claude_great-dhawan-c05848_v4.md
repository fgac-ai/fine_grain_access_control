# Full Drive / folder support — research plan v4

Branch: `claude/great-dhawan-c05848` · Date: 2026-09-18 · Status: research, no code change · Supersedes v3 (Design A now specifies same-turn burst collapse and a batched reminder email, from the 2026-09-18 review's burst evidence)

## The question

Ken (2026-09-17): "continue our research on full drive/folder support so people
don't need to approve items individually." A healthcare-company user who
installed FGAC on his own wrote this week that he wishes it "wouldn't ask for
permission for each file", that he doubts people "know or even care about
file level permission", and that Google's version history makes file-level
control feel redundant. Ken's reply weighed (a) read access to everything by
default versus (b) letting people share whole folders, and asked whether
people value per-file control at all.

Follow-up from Ken mid-research: if FGAC took the full `drive` scope, could it
build its own permission system on top, and does `drive` alone let us
manipulate Sheets, Docs and Slides, or do those APIs need their own scopes too?

This plan continues `feature-google-drive-sheets-fgac_v1.md` (question 1,
"Scope Granularities") and `_v2.md` ("Scope Expansion Behavior"). It does
not restart them: the decision those plans made (non-restricted `drive.file`
plus the Google Picker, zero CASA overhead) is still the right default. What
has changed is that we now have four weeks of production funnel data and a
measured answer to the folder question.

## TL;DR recommendation

Ship **Design A — batch approvals with "read by default within what was
picked"** now. It needs no scope change, no Google verification, and it
serves the whole measured population (every multi-file user picks in the
Google Picker anyway; the Picker already multi-selects, one user picked 50
files in one go). **Reject Design B (folder grant under `drive.file`)**: the
measured experiment in §1.1 shows a folder pick grants the folder object only,
so folders cannot be done without a restricted scope. Defer Design C
(incremental opt-in `drive.readonly` / `drive`) until the batch design has
been measured for four weeks; the restricted-scope path costs a CASA
assessment every year and Google's own scope guidance says to prefer
`drive.file` + Picker. Ken's full-`drive` variant (Design D) is technically
sound — one scope does cover the Sheets, Docs and Slides APIs — but it turns
FGAC into the only gate on a user's entire Drive, which reverses the product's
core promise and carries the same audit cost as Design C.

## 1. Measured answers

### 1.1 Folder pick under `drive.file` — what Google grants

Run by a `qa-setup-driver` runner on 2026-09-17 against a local dev server
with the QA account (USER_A, consumer Gmail). Method: create a probe folder and
a user-created child sheet in Drive; call the Drive/Sheets APIs with the
Picker token before and after picking the FOLDER in a Picker built with
`DocsView(FOLDERS).setSelectFolderEnabled(true)` and our `appId`; then add a
second child after the pick.

**Result: the pick grants the folder object only.** After the pick,
`files.get` on the folder returns 200 with `capabilities.canListChildren:
true`, yet `files.list` with `'<folder>' in parents` returns an empty list and
`files.get` / `spreadsheets.get` on the user-created child inside it stay 404.
A second child created after the pick is equally unreachable, immediately and
after 60 s. A `files.list` with no query lists the picked folder and earlier
picked files, never the children. Full request/response table (ids redacted)
in `docs/spike_results/drive-file-folder-pick.md`.

Shared drives could not be measured: USER_A has none and USER_B is a read-only
member of two, so no probe could be created there (creating a shared drive is
outside a QA run). The grant model is per file id, so the consumer result is
expected to hold, but it is unmeasured.

Consequence: **there is no folder grant under `drive.file`.** Any "share a
folder" feature needs `drive.readonly` (or `drive.metadata.readonly` for
listing plus `drive.file` for content — both restricted, §1.2), so folder
support and "read everything by default" are the same decision.

What the documentation says, for the record. Google's Drive scope guide
(updated 2026-09-03) defines `drive.file` as "Create new Drive files, or
modify existing files, that you open with an app or that the user shares with
an app while using the Google Picker API"; neither it nor the Picker
`DocsView` reference (`setSelectFolderEnabled`: "Allows the user to select a
folder in Google Drive") says anything about children. Every third-party
write-up found treats a folder pick as granting the folder object only. That
is why the measurement, not the reading, decides §2 Design B.

### 1.2 Cost of a broader scope

Sources (fetched 2026-09-17):
Drive scope guide `developers.google.com/workspace/drive/api/guides/api-specific-auth`
(updated 2026-09-03); restricted-scope verification
`developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification`
(updated 2026-08-19); security assessment `support.google.com/cloud/answer/13465431`;
changes to an approved app `support.google.com/cloud/answer/13464018`; CASA Tier 2
overview `appdefensealliance.dev/casa/tier-2/tier2-overview` (updated 2024-11-07);
lab price survey `switchlabs.dev` (2026) and TAC Security's CASA FAQ.

| item | finding |
| --- | --- |
| Classification | `drive.file` is **non-sensitive** (basic verification only). `drive`, `drive.readonly`, `drive.metadata.readonly`, `drive.metadata`, `drive.activity*`, `drive.scripts` are **restricted**. There is no sensitive-tier Drive scope that lists a folder's children; any "see files I did not pick" capability is restricted. |
| Who may hold restricted Drive scopes | Only three app types qualify: "Backup and sync", "Productivity and education", "Reporting and security". FGAC would have to argue "productivity". Google's same page recommends migrating to `drive.file` + Picker. |
| Security assessment | Required for every app that stores or transmits restricted-scope data through its own servers, which a proxy does by definition. Framework is App Defense Alliance CASA; Google assigns assurance level AL1/AL2 dynamically by user count and risk. **Annual**: "reverified for compliance and complete a security assessment at least every 12 months after your assessor's Letter of Assessment". CASA self-scan is deprecated; the lab runs it. |
| Lab cost and time | Tier-2 lab quotes in 2026: TAC Security (Google's preferred lab) $540–$1,800 depending on plan, 1–3 weeks; Leviathan $800–$1,200, 2–3 weeks; Bishop Fox $1,500+, 2–4 weeks. Plus internal remediation time for the OWASP ASVS findings the scan raises. |
| Google review | Brand verification 2–3 business days; restricted-scope review "can potentially take several weeks". Requires a demo video showing the full consent screen with the exact scopes and the app using them. |
| Adding a scope to a verified app | Allowed any time in Cloud Console, but "your app needs to be verified and approved for these scopes before your app can start to call these APIs". If code uses the new scope first, users see the unverified-app screen and the app "will be subject to the 100-user cap" (Testing status additionally limits refresh tokens to 7 days). Previously approved scopes are not mentioned as affected; the practical reading, consistent with the v2 plan, is that existing grants keep working and only consents that include the new scope are gated. |
| Incremental consent | Clerk already supports it: `googleReconnect.ts` calls `reauthorize({ additionalScopes })`, so a per-user opt-in that keeps the default install on `drive.file` is a small change. **It does not confine the audit.** CASA is assessed per app; one opted-in user puts restricted data on our servers and the annual assessment applies to the whole app. What incremental consent confines is the consent-screen blast radius (only opted-in users see the "View and download all your Drive files" line) and the number of accounts exposed if a key leaks. |
| Open question for Ken | `gmail.modify` is itself a restricted Gmail scope, and more than 100 external accounts have granted it. The docs never record whether FGAC already holds a CASA Letter of Assessment for Gmail. If it does, Design C adds a scope to an existing annual assessment and a re-verification submission (video + justification), not a new program. If it does not, the Gmail scope is the bigger exposure and should be settled first. |

### 1.3 "Read by default" inside the current rule engine

`checkFilePermission` (`src/app/api/mcp/route.ts` ~1286) matches a rule to a
call only when `rule.targetResourceId === fileId` (or the legacy
`regexPattern === fileId`). There is no wildcard for files; Gmail's
`send_whitelist` has a `'*'` pattern, Sheets/Docs do not. "Read by default"
would be one new rule shape, `sheet_read` / `doc_read` with
`targetResourceId = '*'` (global or per profile), and one extra clause in the
matcher. Denial behaviour changes only for reads: `*_not_exposed` never fires
for a read, `sheets_write` links still mint for writes, `*_block` rules still
win.

**It is not expressible with `drive.file`.** The rule would pass policy and
then every un-picked file 404s at Google, which is exactly the
`file_grant_missing_at_google` trap `driveFileGrantCheck.ts` documents (29
denials from 15 people in the last 7 days already). So under the current scope
"read by default" can only mean **"read by default within what was picked"**:
any file the user has ever picked (dashboard, approve page, setup page) is
readable by every profile, instead of only by the key that asked. Today the
approve page assigns the rule to the requesting key only
(`actions.ts` ~1151), so a second profile hitting the same file gets a fresh
link. A true "all files" default needs a restricted scope (§1.2, Design C/D).

### 1.4 Demand shape from production data

PostHog project 343912, production, five internal/QA accounts excluded, run
2026-09-17 via the HogQL runner (`docs/monitoring.md` 7.14, 7.18, 7.19 plus
the new queries in §5). All counts are people or links, never accounts.

Approval funnel per action, 7 days (7.14 + 7.19):

| action | links minted | people | opened | approved | approved / minted |
| --- | --- | --- | --- | --- | --- |
| sheets_expose | 71 | 39 | 25 | 22 | 31% |
| sheets_write | 30 | 19 | 17 | 15 | 50% |
| docs_expose | 25 | 11 | 5 | 4 | 16% |
| docs_write | 19 | 6 | 15 | 13 | 68% |

Denials, 7 days: `sheets_not_exposed` 115 calls / 40 people;
`docs_not_exposed` 46 / 12; `file_grant_missing_at_google` 29 / 15. Picker, 7
days: 59 picks by 31 people granting 119 files; 5 picks were multi-file, the
largest picked 50 files at once. Launch to date (8 weeks): 124 people tried
Sheets/Docs tools, 97 succeeded, **27 never did**.

Per-person distribution, 30 days:

| distinct files… | 1 | 2 | 3–4 | 5–9 | 10+ | people |
| --- | --- | --- | --- | --- | --- | --- |
| requested via approval links | 37 | 23 | 6 | 15 | 3 | 84 |
| approved via approval links | 36 | 13 | 5 | 3 | 1 | 58 (+26 approved none) |
| hit the not-exposed gate on | 25 | 46 | 8 | 8 | 2 | 89 |
| used successfully | 41 | 17 | 13 | 8 | 3 | 82 |

Readings that matter for the design:

- **The multi-file population is real but a minority.** 18 of 84 people (21%)
  had links minted for 5+ distinct files in 30 days, 24 (29%) for 3+. Only 4
  people approved 5+ files through links, 9 approved 3+; but 11 of 82 (13%)
  *used* 5+ distinct files successfully, so the heavy users get there through
  the dashboard Picker (22 dashboard picks by 16 people granted 74 files, 3.4
  per pick, versus 73 approve-page picks by 40 people granting 176 files, 2.4
  per pick, and 151 of 165 approve-page approvals granted exactly one file).
- **The gate converts under half the time.** Of 178 (person, file) pairs that
  hit a not-exposed denial in 30 days, 78 (44%) later succeeded and 100 never
  did; 152 files were used without ever being gated (picked or agent-created
  first). When it converts it is fast: median 6 minutes from first denial to
  first success, p90 4.2 hours.
- **Bursts exist.** Five person-days in 30 days minted links for 5+ distinct
  files in one day (23, 12, 7, 7 and 5 files). The 23-file day is the case a
  folder or batch grant is for; today it is 25 separate links.
- **Leaving at the gate is rarer than it looked.** 89 people hit the gate in
  30 days; 22 never passed it; 10 of those have been silent 7+ days; only 2
  of them never succeeded on any tool. The larger loss is the 26 people (30%
  of link recipients) who approved nothing, most of whom never opened a link
  (7.19: the open step, not the Picker, is where sheets_expose loses).

### 1.5 Ken's follow-up: full `drive` scope as the substrate

**Yes on both counts, technically.** Google's per-method scope tables list
`https://www.googleapis.com/auth/drive` as sufficient for every content
endpoint we use or plan to use: `spreadsheets.values.update` accepts `drive`,
`drive.file`, `spreadsheets`; `documents.batchUpdate` accepts `documents`,
`drive`, `drive.file`; `presentations.batchUpdate` accepts `drive`,
`drive.file`, `drive.readonly`, `presentations` (and, oddly, the two
`spreadsheets*` scopes). Reads accept the same plus the `*.readonly` forms.
FGAC already proves the pattern in production: it runs Sheets and Docs with
**no** `spreadsheets` or `documents` scope, only `drive.file`, and `drive` is
the superset of `drive.file` in every one of those tables. So neither
`spreadsheets`, `documents` nor `presentations` would be needed. Slides
additionally needs the Slides API **enabled on the GCP project** (today it
returns `SERVICE_DISABLED`; a console action for Ken, independent of scope).

And FGAC's rule engine is already "our own permission system on top": every
Sheets/Docs call passes through `checkFilePermission`. What changes under
`drive` is that Google stops enforcing anything, so FGAC becomes the **only**
gate on the whole Drive. Three consequences decide whether that is acceptable:

1. Every Drive endpoint must be guarded, including the ones the MCP path still
   passes through today (`PATCH files/{id}`, `permissions`, `files.list`,
   `DELETE`), and `files.list` results must be filtered server-side because
   Google will now return everything.
2. A leaked proxy key or a mis-scoped rule exposes the user's entire Drive
   rather than the files they picked. The product's pitch ("the agent can only
   reach what you exposed") becomes a promise FGAC keeps alone.
3. It is a restricted scope: §1.2 applies in full (CASA annually, app-type
   eligibility, review weeks, unverified screen until approved).

### 1.6 Attempted spike: full `drive` scope on a QA account

Ken asked (2026-09-17) for a real spike: widen a QA account's grant to the
full `drive` scope and try to edit Sheets and Docs with it. Recorded in
`docs/spike_results/drive-scope-sheets-docs-edit.md`. Outcome: **incomplete**,
no `drive`-scoped token was obtained, so §1.5 still rests on Google's
per-method scope tables plus the in-house proof that `drive.file` alone
already drives the Sheets and Docs APIs. Two things were measured on the
way and matter for Design C:

- Google's consent page **accepted the undeclared restricted `drive` scope on
  the dev client** through Clerk's `reauthorize({ additionalScopes })`,
  listing it as one extra line ("See, edit, create, and delete all of your
  Google Drive files"). The incremental-consent mechanism works on Google's
  side without any console change for an unverified dev client.
- Clerk's OAuth callback failed in the built-in browser (`authorization_invalid`
  403, also for a plain `drive.file` reconnect) and succeeded in a normal
  Chrome. The spike needs one human sign-in-and-consent in a normal browser;
  after that the calls are routine (retry path in the spike doc).

Residual: USER_A's Google-side grant to the dev client now includes full
Drive, but Clerk's refresh token predates it, so every token FGAC mints is
still the narrow baseline. Nothing in FGAC changed.

## 2. Candidate designs

### Design A — batch approvals + read-by-default within picks (no scope change)

What ships:

1. `request_access` accepts up to 10 file ids (or titles) in one call and
   mints **one** link; the approve page opens the Picker once with
   multi-select and grants everything picked (the 10-pick cap and the
   substitution logic in `actions.ts` already exist).
2. A **pending approvals** panel on `/dashboard` built on the
   `approval_requests` ledger (`approvedAt IS NULL`), with one "Pick these in
   Google" button that resolves every pending file request for every profile
   in a single Picker session. This is the same surface the approval
   sign-in-wall work already needs (a banner with explicit clearing rules).
3. Denial copy: from the second un-opened file link in a session, the MCP
   denial says "N files are waiting — approve them all at once here" and
   re-uses the pending panel URL instead of minting per file (cuts `mint_count`
   pressure and the 23-links-in-a-morning shape).
4. **Read by default within picks** (opt-out per user): a file picked on any
   surface gets a global `*_read` rule instead of a key-scoped one; write
   stays per profile. One matcher change, one setting.
5. **Same-turn burst collapse** (added v4). The 2026-09-18 review measured
   the shape item 3 must handle: one new org user's agent minted 12
   `sheets_expose` links in 8 seconds (one per `sheets_not_exposed` denial
   while iterating a list of spreadsheets; 14 distinct targets over 36 h, 3
   approved), and a known power user minted 20 links over 7 targets in one
   hour. Today every denial mints its own `request_id`, so a burst is N links
   and N clicks however the user reaches them. The design collapses it at
   the mint: `policyDenialWithLink` looks up this key's **unopened, unapproved
   requests in the last 10 minutes** (`approval_requests`, `openedAt IS NULL`,
   `approvedAt IS NULL`) and, when one or more exist, returns a **batch
   link** — a signed link whose payload is the list of pending request ids
   for that key (capped at the approve page's existing 10-pick limit; beyond
   it the link points at the pending panel). Per-file rows keep being written
   (the ledger and 7.14/7.19 stay per request); the batch link is an
   additional row keyed by the batch id and consumed once. Opening it opens
   the Picker once with every pending file's title listed, and grants what is
   picked to the requesting key exactly as the single-file page does. The
   denial text changes from "share this link" to "N spreadsheets are waiting
   — one link approves them all: …", and `AGENT_APPROVAL_PROTOCOL` gains the
   line "do not request the rest one by one; the link already covers them".
6. **Reminder carries the batch** (added v4). The repeat-mint reminder
   (`approvalNotify.ts`) is keyed per `request_id`, fires only on a re-mint
   after the minimum gap, and although `notifyOwnerOfApprovalLinks` accepts a
   `links[]` array the mint path passes one link, so a 12-file burst reminded
   4 times still meant 12 clicks for the user in the review's case 1. Change:
   when a reminder becomes due for any request, the email lists **every**
   unopened, unapproved request for that owner (all keys) as one batch link
   plus the per-file list, and the claim marks all of them `notified_at` in
   the same statement so no later request in the batch can trigger a second
   email. The per-person daily cap is unchanged. `approval_link_notified`
   already carries `link_count`; it becomes the measure of how many files a
   reminder covered.

Cost: about a week of code, no Google interaction, no audit. Rule model: no
schema change (global rules exist; a per-user setting row for the opt-out).
MCP nudge: the batched denial text plus `get_my_permissions` listing pending
requests. Serves: every user (the 21% multi-file cohort gets one pick instead
of N links; the 30% who never open a link get a dashboard surface that does
not depend on the agent relaying a URL).

### Design B — folder grant via the Picker — REJECTED by measurement

Would have been: a `folder_read` / `folder_read_write` rule (`service:
'drive'`, `targetResourceId = folderId`), resolution by `files.get(fileId,
fields=parents)` cached per file, a FOLDERS view with
`setSelectFolderEnabled(true)` on the approve page and dashboard. §1.1 shows
the pick never reaches children, so under `drive.file` the rule would pass
policy and 404 at Google for every child — the same trap as "read by default"
in §1.3. The folder rule model survives only inside Design C, where
`drive.readonly` makes `files.list` work. No spike is warranted.

### Design C — incremental opt-in `drive.readonly` (or `drive`) per user

Per-user "Let this agent read my whole Drive" toggle using
`reauthorize({ additionalScopes })`; default install stays `drive.file`; rules
gain the `'*'` default from §1.3 and folder rules from Design B evaluated via
`files.list`. Cost: 2–3 weeks code plus the audit path — CASA Tier 2 lab
($540–$1,800/yr, 1–4 weeks), ASVS remediation, demo video, Google review
"several weeks", **annual** re-assessment, eligibility argument as a
"productivity" app. Consent blast radius confined to opted-in users; audit
blast radius is the whole app. Serves: the ~13–21% heavy cohort, and only the
subset that accepts a "view and download all your Drive files" consent.

### Design D — full `drive` for everyone, FGAC as sole gate (Ken's question)

Feasible (§1.5) and the simplest data model ("read everything, rules only
block or grant writes"). Same audit cost as C, plus the enforcement work in
§1.5 item 1, plus a product reversal: the healthcare user's own observation
("once you get comfortable … you become less concerned") is the churn risk a
security product should not encode as its default. Not recommended.

## 3. Recommendation

Accept **A** now; **B** is closed by the measurement; put **C** on a dated review after
four weeks of A's data, with the CASA question in §1.2 (does FGAC already hold
an LOA for Gmail?) answered first; reject **D**.

Success measure for A, four weeks after deploy: approve-page approvals
granting more than one file rise from 8% (14 of 165) toward the dashboard's
share; `sheets_expose` approved/minted rises from 31%; the 30-day count of
people with links for 5+ distinct files who approve 5+ rises from 4 of 18;
and bursts read as one link — `approval_link_minted` rows per person per
10-minute window with `batch_size > 1` replace today's 12-in-8-seconds shape
(7 d to 2026-09-18: 398 mints by 53 people → 207 opened → 80 approved).

## 4. User actions versus code

| owner | item |
| --- | --- |
| Ken | Confirm whether the OAuth client already holds a CASA Letter of Assessment for `gmail.modify`, and its renewal date. |
| Ken (if the §1.6 spike should finish) | Sign in to a local dashboard as USER_A in a normal browser, run the reauthorize snippet once, then let a runner do the fifteen calls; afterwards restore the narrow grant. |
| Ken | Decide A now / C later / D rejected. |
| Ken (only if C) | Add `drive.readonly` to the consent screen, submit scope justification and the demo video, engage the CASA lab (TAC Security is Google's preferred), sign the LOA each year. |
| Ken (Slides, any design) | Enable the Google Slides API on the GCP project. |
| Code | Design A items 1–4; no folder spike (§1.1 closed it); monitoring 7.14/7.19 already cover the success measure, add the per-person distribution query (§5). |

## 5. Queries added for this research

The per-person distributions in §1.4 are not yet in `docs/monitoring.md`; the
two that the success measure needs are:

```sql
-- files requested vs approved per person (30 d), via the minted link's target_hash
WITH minted AS (
  SELECT properties.request_id AS rid, any(properties.target_hash) AS th, any(person_id) AS pid
  FROM events WHERE event = 'approval_link_minted' AND properties.environment = 'production'
    AND timestamp > now() - INTERVAL 30 DAY
    AND properties.action IN ('sheets_expose','sheets_write','docs_expose','docs_write')
    AND person.properties.email NOT IN (/* internal + QA accounts */)
  GROUP BY rid),
appr AS (SELECT DISTINCT properties.request_id AS rid FROM events
  WHERE event = 'approval_link_approved' AND timestamp > now() - INTERVAL 30 DAY),
per AS (SELECT m.pid AS pid, uniq(m.th) AS req, uniqIf(m.th, a.rid != '') AS appr
  FROM minted m LEFT JOIN appr a ON a.rid = m.rid GROUP BY pid)
SELECT count() AS people, countIf(req >= 5) AS req5, countIf(appr >= 5) AS appr5, countIf(appr = 0) AS appr0 FROM per
```

```sql
-- gate conversion per (person, file) and time-to-success (30 d)
WITH pf AS (
  SELECT person_id, toString(properties.file_id) AS f,
         countIf(properties.denial_code IN ('sheets_not_exposed','docs_not_exposed')) AS denied,
         countIf(properties.outcome = 'success' AND properties.file_service IN ('sheets','docs')) AS ok,
         minIf(timestamp, properties.denial_code IN ('sheets_not_exposed','docs_not_exposed')) AS first_deny,
         minIf(timestamp, properties.outcome = 'success') AS first_ok
  FROM events WHERE event = '$mcp_tool_call' AND properties.environment = 'production'
    AND timestamp > now() - INTERVAL 30 DAY AND properties.file_service IN ('sheets','docs')
    AND person.properties.email NOT IN (/* internal + QA accounts */)
  GROUP BY person_id, f)
SELECT countIf(denied > 0) AS gated, countIf(denied > 0 AND ok > 0) AS gated_then_ok,
       round(quantileIf(0.5)(dateDiff('minute', first_deny, first_ok), denied > 0 AND ok > 0)) AS median_min
FROM pf
```

`granted_count` on `approval_link_approved` is unset on rows older than the
2026-09-05 dedupe fix; bucket `isNull` separately or the nulls land in the top
bucket (they did, on the first pass of this research).
