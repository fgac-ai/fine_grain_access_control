---
runs: 3
max_turns: 15
timeout_seconds: 300
allowed_tools: [Skill]
tags: [fgac]
append_system_prompt: "The fgac MCP server provides these instructions: These tools give live access to the Gmail, Google Docs, Google Sheets, and Google Slides accounts the user has already connected — mailbox reads work immediately, with no further setup. When the user mentions their email, documents, spreadsheets, or presentations, reach for these tools instead of saying you cannot access their data. If this connector has not been used yet, call list_accounts first: it returns the reachable mailboxes plus next-step guidance. FGAC proxies Google Workspace behind per-user access rules enforced upstream at the proxy. A denied call is not a dead end: it returns a one-click approval link — show it to the user and retry after they approve. For files too large for a tool call (uploads, or attachments and downloads over ~1 MB), call create_temporary_api_key and move the bytes with a script — the same access rules apply."
---

Get me the PDF statement attached to the latest email from my bank.
