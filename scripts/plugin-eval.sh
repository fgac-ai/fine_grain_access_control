#!/usr/bin/env bash
# Eval the fgac-mcp directory plugin's skill: with-skill vs without-skill, the
# (mocked) fgac MCP server present in BOTH arms.
#
#   bash scripts/plugin-eval.sh            # all cases, 3 runs each, both arms
#   bash scripts/plugin-eval.sh --runs 1   # extra args go to `claude plugin eval`
#
# Why not `claude plugin eval`'s built-in ablation: its baseline arm loads no
# plugin at all, so it also loses the MCP server and every tool grader fails —
# that measures "has FGAC vs has nothing", not "skill vs no skill". Instead this
# builds two temp copies of public/skills/fgac-mcp (one with skills/ removed),
# drops the suite from evals/fgac-mcp-plugin/ into each, and scores each with
# --ablation none. Tool calls are answered by the mocks in the suite, never by
# fgac.ai (no --mocks off / --allow-real-servers).
#
# The suite lives outside the plugin folder so the published bundle ships no
# eval files. Needs a logged-in `claude` CLI (`claude login`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/public/skills/fgac-mcp"
SUITE="$ROOT/evals/fgac-mcp-plugin"
OUT="$ROOT/evals/fgac-mcp-plugin-results/$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

build_arm() { # name keep_skill
  local dir="$WORK/$1/fgac-mcp"
  mkdir -p "$(dirname "$dir")"
  cp -R "$PLUGIN" "$dir"
  [ "$2" = yes ] || rm -rf "$dir/skills"
  cp -R "$SUITE" "$dir/evals"
  echo "$dir"
}

mkdir -p "$OUT"
status=0
for arm in with-skill:yes without-skill:no; do
  name="${arm%%:*}"; keep="${arm##*:}"
  dir="$(build_arm "$name" "$keep")"
  echo "== $name"
  (cd "$dir" && claude plugin eval . --trust-plugin --ablation none --threshold 0 --no-publish \
      --json "$OUT/$name.json" --report "$OUT/$name.html" --output-dir "$OUT/$name" "$@") || status=$?
done

echo "Results: $OUT"
exit "$status"
