#!/bin/bash
# Tests for scripts/vercel-should-build.sh against a throwaway git repo.
# Run: bash scripts/test-vercel-should-build.sh
# Remember the polarity: exit 0 = SKIP, exit 1 = BUILD.
set -u
SCRIPT="$(cd "$(dirname "$0")" && pwd)/vercel-should-build.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
cd "$TMP" || exit 2
git init -q && git config user.email t@example.com && git config user.name t
mkdir -p src docs/plans public/skills/x .claude
echo a > src/a.ts && git add -A && git commit -qm base
BASE=$(git rev-parse HEAD)
echo d > docs/plans/p.md && echo r > README.md && echo c > .claude/n.md && git add -A && git commit -qm docs
DOCS=$(git rev-parse HEAD)
echo s > public/skills/x/SKILL.md && git add -A && git commit -qm skill
SKILL=$(git rev-parse HEAD)
git checkout -q "$DOCS" && echo b > src/b.ts && git add -A && git commit -qm code && CODE=$(git rev-parse HEAD)

fails=0
expect() { # name want(BUILD|SKIP) env...
  local name=$1 want=$2; shift 2
  out=$(env -i PATH="$PATH" HOME="$HOME" "$@" bash "$SCRIPT"); rc=$?
  got=$([ $rc -eq 0 ] && echo SKIP || echo BUILD)
  if [ "$got" = "$want" ]; then echo "  ✓ $name → $got"; else echo "  ✗ $name → $got (want $want): $out"; fails=$((fails+1)); fi
}

expect 'production always builds'            BUILD VERCEL_ENV=production VERCEL_GIT_COMMIT_REF=main VERCEL_GIT_PREVIOUS_SHA=$BASE VERCEL_GIT_COMMIT_SHA=$DOCS
expect 'main preview builds even docs-only'  BUILD VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=main VERCEL_GIT_PREVIOUS_SHA=$BASE VERCEL_GIT_COMMIT_SHA=$DOCS
expect 'no ref (CLI deploy) builds'          BUILD VERCEL_ENV=preview
expect 'claude/* first push skips'           SKIP  VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=claude/x VERCEL_GIT_COMMIT_SHA=$CODE "VERCEL_GIT_COMMIT_MESSAGE=feat: thing"
expect 'other feature branch skips'          SKIP  VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=fix/y VERCEL_GIT_COMMIT_SHA=$CODE
expect '[preview] token opts a branch in'    BUILD VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=claude/x VERCEL_GIT_COMMIT_SHA=$CODE "VERCEL_GIT_COMMIT_MESSAGE=chore: request preview [preview]"
expect '[preview] wins over docs-only'       BUILD VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=integration/z VERCEL_GIT_PREVIOUS_SHA=$BASE VERCEL_GIT_COMMIT_SHA=$DOCS "VERCEL_GIT_COMMIT_MESSAGE=docs [preview]"
expect 'integration first push builds'       BUILD VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=integration/2026-10-08 VERCEL_GIT_COMMIT_SHA=$DOCS
expect 'integration docs-only skips'         SKIP  VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=integration/2026-10-08 VERCEL_GIT_PREVIOUS_SHA=$BASE VERCEL_GIT_COMMIT_SHA=$DOCS
expect 'integration code change builds'      BUILD VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=integration/2026-10-08 VERCEL_GIT_PREVIOUS_SHA=$BASE VERCEL_GIT_COMMIT_SHA=$CODE
expect 'served SKILL.md is not docs-only'    BUILD VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=integration/2026-10-08 VERCEL_GIT_PREVIOUS_SHA=$DOCS VERCEL_GIT_COMMIT_SHA=$SKILL
expect 'opted-in branch, docs-only skips'    SKIP  VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=claude/x VERCEL_GIT_PREVIOUS_SHA=$BASE VERCEL_GIT_COMMIT_SHA=$DOCS
expect 'opted-in branch, code builds'        BUILD VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=claude/x VERCEL_GIT_PREVIOUS_SHA=$DOCS VERCEL_GIT_COMMIT_SHA=$CODE
expect 'unknown previous SHA fails open'     BUILD VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=integration/z VERCEL_GIT_PREVIOUS_SHA=0123456789abcdef0123456789abcdef01234567 VERCEL_GIT_COMMIT_SHA=$DOCS
expect 'same commit redeploy skips'          SKIP  VERCEL_ENV=preview VERCEL_GIT_COMMIT_REF=integration/z VERCEL_GIT_PREVIOUS_SHA=$CODE VERCEL_GIT_COMMIT_SHA=$CODE

[ $fails -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
