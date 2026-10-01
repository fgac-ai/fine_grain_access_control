/**
 * The ONE place the Neon CLI version is chosen.
 *
 * Every script that shells out to neonctl builds its command here, so the
 * version is pinned once and bumped deliberately. It used to be
 * `npx --yes neonctl …` unpinned, which means "whatever the registry published
 * last night": between 2026-09-18 and 2026-09-29 that was twelve releases
 * across three major versions (5.0.0 → 7.0.1), and the daily neon-branch-prune
 * run of 2026-09-26 died on its first delete with a yargs arg-parsing error
 * (`Not enough non-option arguments: got 0, need at least 1`) that no single
 * release reproduces afterwards — the dependency was moving under the job.
 *
 * Bumping the pin: re-verify, against the real project, every subcommand the
 * scripts use — `projects list`, `branches list`, `branches create --compute`,
 * `branches delete <id>`, `connection-string --branch … --pooled`, and
 * `api <path>` — all with `-o json` where the caller parses JSON. 7.0.1 was
 * verified that way on 2026-09-30 (docs/implementation_plans/claude-brave-cerf-54ac0a_v1.md).
 */
export const NEONCTL_VERSION = '7.0.1';
export const NEONCTL_SPEC = `neonctl@${NEONCTL_VERSION}`;

/** `neonctl('branches list --project-id x -o json')` → the full shell command. */
export const neonctl = (args: string): string => `npx --yes ${NEONCTL_SPEC} ${args}`;
