#!/bin/bash
# Vercel "Ignored Build Step" (wired up as `ignoreCommand` in vercel.json).
#
#   EXIT 0 = SKIP the build.   EXIT 1 = BUILD.
#
# That is Vercel's convention, and it is the opposite of what you'd guess. Every
# path below goes through build()/skip() so the polarity lives in one place.
#
# Policy (docs/implementation_plans/claude_vercel-build-cost_v1.md; ADR-002):
#   - production, and anything on main      → always build
#   - head commit message contains [preview] → build (deliberate opt-in)
#   - integration/* trains                  → build, unless the change since the
#                                              last successful build is docs-only
#   - a branch that already has a successful deployment (opted in earlier)
#                                           → same docs-only rule as a train
#   - every other branch (claude/*, …)      → skip; feature branches are validated
#                                              through an integration train (ADR-002)
#
# Anything uncertain (missing env, a SHA the shallow clone doesn't have, a git
# error) BUILDS. Failing open costs a few cents; failing closed hides a preview
# someone is waiting on.
set -u

build() { echo "vercel-should-build: BUILD — $*"; exit 1; }
skip()  { echo "vercel-should-build: SKIP — $*"; exit 0; }

ENV_NAME="${VERCEL_ENV:-}"
REF="${VERCEL_GIT_COMMIT_REF:-}"
MSG="${VERCEL_GIT_COMMIT_MESSAGE:-}"
PREV="${VERCEL_GIT_PREVIOUS_SHA:-}"
HEAD_SHA="${VERCEL_GIT_COMMIT_SHA:-HEAD}"

[ "$ENV_NAME" = "production" ] && build "production deployment"
[ -z "$REF" ] && build "no git ref (CLI or API deployment)"
[ "$REF" = "main" ] && build "main"

case "$MSG" in *"[preview]"*) build "[preview] in the head commit message" ;; esac

case "$REF" in
  integration/*) ;;
  *)
    # VERCEL_GIT_PREVIOUS_SHA is the last *successful* deployment of this branch,
    # so it is only set once the branch has been opted in at least once.
    [ -z "$PREV" ] && skip "feature branch '$REF' — push a commit with [preview] in its message to get a preview"
    ;;
esac

[ -z "$PREV" ] && build "first deployment of '$REF'"

if ! git cat-file -e "${PREV}^{commit}" 2>/dev/null; then
  git fetch --quiet --depth=100 origin "$PREV" 2>/dev/null || true
fi
if ! CHANGED=$(git diff --name-only "$PREV" "$HEAD_SHA" 2>/dev/null); then
  build "could not diff against the last built commit ${PREV:0:7}"
fi
[ -z "$CHANGED" ] && skip "no file changes since the last built commit ${PREV:0:7}"

# Docs-only = docs/**, .claude/**, or a Markdown file at the repo root.
# NOT every *.md: public/skills/**/SKILL.md is served by the app.
CODE=$(printf '%s\n' "$CHANGED" | grep -vE '^(docs/|\.claude/)|^[^/]+\.md$' || true)
[ -z "$CODE" ] && skip "docs-only change since ${PREV:0:7}"
build "$(printf '%s\n' "$CODE" | wc -l | tr -d ' ') non-doc file(s) changed since ${PREV:0:7}"
