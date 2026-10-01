#!/bin/sh
# Shared forbidden-content pattern for the pre-commit and commit-msg hooks.
# Sourced, not executed — sets FORBIDDEN_PATTERN.
#
# Secrets are just as permanent in a commit message as in a file, so both hooks
# check the same pattern.

# Proxy API keys.
FORBIDDEN_PATTERN="(sk_proxy_[a-fA-F0-9]{15,})"

# Private QA test emails, if the local config is present. The file is
# gitignored, so this silently degrades to the key-only pattern on machines
# that do not have it (CI, fresh clones).
CONFIG_FILE=".qa_test_emails.json"
if [ -f "$CONFIG_FILE" ]; then
  PRIVATE_EMAILS=$(grep -oE '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' "$CONFIG_FILE" \
    | tr '\n' '|' | sed 's/|$//' | sed 's/\./\\./g')
  if [ -n "$PRIVATE_EMAILS" ]; then
    FORBIDDEN_PATTERN="(sk_proxy_[a-fA-F0-9]{15,}|$PRIVATE_EMAILS)"
  fi
fi

# ── Generic email guard (deny-by-default) ────────────────────────────────────
# This repo is PUBLIC. After an internal/personal address slipped through (the
# pattern above only knew proxy keys + QA emails), the hooks now treat EVERY
# email address in newly added content as forbidden unless it matches the
# allowlist below. Real addresses of any kind — customers, operators, personal
# accounts — never belong in a commit; use placeholders on example.com.
#
# Allowlist: the public support address, the RFC 5321 MTA senders that DSN
# fixtures quote (mailer-daemon, postmaster), noreply senders (includes the
# Co-Authored-By trailer), GitHub noreply, and RFC 2606 placeholder domains.
EMAIL_REGEX='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
ALLOWED_EMAIL_REGEX='^(support|sales)@fgac\.ai$|^(mailer-daemon|postmaster)@|^(noreply|no-reply)@|@users\.noreply\.github\.com$|@(example|test|invalid|localhost)\.|@company\.com$'

# stdin -> prints disallowed addresses found (empty when clean)
scan_disallowed_emails() {
  grep -oE "$EMAIL_REGEX" 2>/dev/null | grep -viE "$ALLOWED_EMAIL_REGEX" | sort -u
}
