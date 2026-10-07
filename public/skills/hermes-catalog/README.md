# Hermes Agent MCP catalog entry (staging copy)

`fgac/manifest.yaml` is FGAC's entry for Nous Research's Hermes Agent
built-in MCP catalog, in the exact format of
`NousResearch/hermes-agent/optional-mcps/<name>/manifest.yaml`
(`manifest_version: 1`, loader `hermes_cli/mcp_catalog.py`). It lives here so
it is versioned with the product; the catalog itself only accepts entries via a
merged PR to that repo.

Until (or unless) it is merged, Hermes users add FGAC by hand — see
<https://fgac.ai/hermes>:

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  fgac:
    url: https://fgac.ai/api/mcp
    auth: oauth
```

## Submitting (vendor action — public, under FGAC's name)

Do not open the PR until the real-client verification has passed (Hermes
completes FGAC's OAuth and a tool call; its CIMD client id
`https://nousresearch.github.io/hermes-agent/docs/oauth/client-metadata.json`
is admitted by Clerk).

1. In a fork of `NousResearch/hermes-agent`, copy `fgac/` to
   `optional-mcps/fgac/`. The PR touches nothing else.
2. Run `pytest tests/hermes_cli/test_mcp_catalog.py -q` and
   `python scripts/check`; then `hermes mcp install fgac` with
   `HERMES_OPTIONAL_MCPS` pointing at the fork, and capture the live
   `tools/list`.
3. Title: `feat(optional-mcps): add FGAC (rule-limited Google Workspace)`.
   Search open PRs for duplicates first.
4. Body: disclose that the submitter is the vendor; list the tool audit
   (22 tools, read/destructive annotations, the three excluded by default and
   why); explain that `google_api_get`/`google_api_modify` are not a generic
   executor — every call is checked server-side against the owner's
   per-key rules and denied calls return an owner approval link.

## Expectations

As of 2026-10-06 the maintainers hold entries from early-stage,
single-maintainer products, and the curation pass (PR #94513) listed Google
Workspace (per-account setup) as deliberately excluded. Treat the submission
as a long shot; the manual config above and the `/hermes` page are the
working path. Fallback listing route: `plugin-catalog/` (see its README in
that repo).
