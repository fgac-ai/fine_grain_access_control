# Capabilities — Assertion Checklists

> **These are NOT standalone tests.** They define WHAT to verify, not HOW.
> Each assertion is executed through an agent interface doc in `agents/` or `production/`.

## How to Use

1. Each capability doc lists assertions with expected outcomes.
2. Agent docs (`agents/01_hosted_mcp.md`, etc.) describe how to execute these assertions in a specific runtime.
3. Every agent doc must cover every capability.
4. When adding a new capability file here, update ALL agent docs to cover it.

## Capabilities

| # | File | What It Tests |
|---|------|---------------|
| 01 | `01_send_whitelist.md` | Whitelisted send succeeds, blocked send returns 403 |
| 02 | `02_read_blacklist.md` | Content-based read blocking, rule names in errors |
| 03 | `03_multi_email_scoping.md` | Key-to-email isolation, power key multi-access |
| 04 | `04_delegation.md` | Cross-user delegated email access |
| 05 | `05_label_access.md` | Label whitelist/blacklist filtering |
| 06 | `06_connection_lifecycle.md` | Pending → approve → block → unblock → nickname |
| 07 | `07_key_lifecycle.md` | Revoke, roll, cross-user isolation |
| 08 | `08_strict_light_mode.md` | No dark mode leaks regardless of OS preference |
| 09 | `09_sheets_management.md` | Per-spreadsheet read/write/block rules |
| 10 | `10_raw_google_api.md` | Allow-by-default raw Google API pair (sends whitelisted, honest refusals) |
| 11 | `11_partner_handoff.md` | Partner OAuth handoff, consent provisioning, bypass fail-safe |
| 12 | `12_push_notifications.md` | Watch/PubSub pipeline, rule-filtered thin pings, retry/suspend |
| 13 | `13_default_profile_instant_start.md` | Auto-provisioned default profile, instant-start flow |
| 14 | `14_magic_link_approvals.md` | Magic approval links: signing, expiry, single-use, owner-only |
| 15 | `15_request_access_tool.md` | Conversational permission upgrades via `request_access` |
| 16 | `16_analytics_events.md` | PostHog events arrive with canonical schema (`$mcp_tool_call` + tool names, outcomes, environment tags) |
| 17 | `17_sheets_grant_recovery.md` | Sheets approval verifies the Google-side grant; picker + video recovery when missing; honest post-policy errors |
| 18 | `18_google_reconnect.md` | Broken/expired Google grants route into the Reconnect Google flow |
| 19 | `19_docs_management.md` | Per-document read/write/block rules, docs MCP tools, raw `documents` enforcement, docs grant recovery |
| 20 | `20_attachment_reading.md` | Caller-directed windowing of large read payloads (offset/limit envelope) across attachment, gmail_read, docs, sheets, and raw GET; guided size-cap refusal |
| 21 | `21_slides_management.md` | Per-presentation expose/access rules and the Slides MCP tools |
| 23 | `23_temporary_api_keys.md` | MCP-minted short-lived proxy keys: parent-profile parity, no escalation, live rule changes, expiry/revoke/cascade, agent guidance, mint-to-use telemetry |
| 24 | `24_large_file_transfer.md` | Over-4.5 MB transfers: streamed downloads, resumable chunked Drive/Gmail uploads routed through FGAC, first-chunk recipient check, size-limit guidance |
