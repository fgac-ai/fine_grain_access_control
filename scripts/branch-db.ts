/* eslint-disable */
import { config } from 'dotenv'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

// Load environment variables from .env.local
config({ path: '.env.local' })

function runNeonCmd(cmd: string) {
  try {
    return JSON.parse(execSync(`npx --yes neonctl ${cmd} -o json`, { encoding: 'utf-8' }));
  } catch (error: any) {
    console.error(`❌ Neon CLI error. Are you authenticated?`);
    process.exit(1);
  }
}

/** Like runNeonCmd, but returns the failure instead of exiting — for callers
 * that can recover (e.g. branch-limit → cleanup → retry). */
function tryNeonCmd(cmd: string): { result?: any; error?: string } {
  try {
    return { result: JSON.parse(execSync(`npx --yes neonctl ${cmd} -o json`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] })) };
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() ?? '';
    return { error: (stderr || error?.message || 'unknown neonctl error').trim() };
  }
}

/** Plain-text neonctl output (commands whose `-o json` is not JSON, e.g. `connection-string`). */
function tryNeonText(cmd: string): { result?: string; error?: string } {
  try {
    return { result: execSync(`npx --yes neonctl ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() };
  } catch (error: any) {
    const stderr = error?.stderr?.toString?.() ?? '';
    return { error: (stderr || error?.message || 'unknown neonctl error').trim() };
  }
}

async function getGitBranch() {
  if (process.env.VERCEL_GIT_COMMIT_REF) {
    return process.env.VERCEL_GIT_COMMIT_REF;
  }
  try {
    return execSync('git rev-parse --abbrev-ref HEAD').toString().trim()
  } catch {
    console.error('❌ Error: Not a git repository or git is not installed.')
    process.exit(1)
  }
}

async function updateEnvLocal(connectionString: string) {
  const envPath = path.join(process.cwd(), '.env.local')
  let envContent = ''

  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8')
  }

  // Regex to remove old URL mappings
  envContent = envContent.replace(/^DATABASE_URL=.*$/gm, '')
  envContent = envContent.replace(/^neon__POSTGRES_URL=.*$/gm, '')
  envContent = envContent.replace(/^DB_PROVIDER=.*$/gm, '')
  envContent = envContent.replace(/^POSTGRES_PRISMA_URL=.*$/gm, '')
  envContent = envContent.replace(/^POSTGRES_URL_NON_POOLING=.*$/gm, '')
  envContent = envContent.replace(/^POSTGRES_URL_NO_SSL=.*$/gm, '')
  envContent = envContent.replace(/^POSTGRES_URL=.*$/gm, '')

  const newEntry = `neon__POSTGRES_URL="${connectionString}"\nDB_PROVIDER="neon"`
  envContent += `\n${newEntry}\n`

  fs.writeFileSync(envPath, envContent.replace(/\n\n+/g, '\n'))
  console.log('✅ Updated .env.local with new neon__POSTGRES_URL')
}

async function main() {
  if (process.env.VERCEL || process.env.CI) {
    console.log('☁️  Vercel CI environment detected. Skipping interactive database branching.');
    return;
  }

  const gitBranch = await getGitBranch()
  const branchName = gitBranch.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()

  if (branchName === 'main') {
    const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout })
    console.error('\n🚨 FATAL: You are attempting to run an operation against the PRODUCTION database!')
    console.error('Did you forget to run `npm run db:branch` first?\n')

    await new Promise<void>((resolve) => {
      readline.question(`Type 'prod please' to modify production, or anything else to safely abort.\n> `, (answer: string) => {
        readline.close()
        if (answer.trim() === 'prod please') {
          console.warn('\n⚠️  Proceeding to fetch PRODUCTION database credentials...')
          resolve()
        } else {
          console.error('\n🛑 Aborted.')
          process.exit(1)
        }
      })
    })
  }

  console.log(`🚀 Preparing Neon database branch for: ${branchName}`)

  let projectId = process.env.NEON_PROJECT_ID
  if (!projectId) {
    const projects = runNeonCmd('projects list');
    if (projects.length === 0) {
      console.error('❌ No Neon projects found.');
      process.exit(1);
    }
    projectId = projects[0].id;
  }

  console.log(`Using project ID: ${projectId}`);

  const branches = runNeonCmd(`branches list --project-id ${projectId}`);
  let branch = branches.find((b: any) => b.name === branchName);

  if (!branch) {
    console.log(`🌿 Branch '${branchName}' not found. Creating from 'main'...`);
    // Neon caps the project at 10 branches; stale branches accumulate until
    // creation fails. Self-heal: on a limit error, prune stale branches
    // (scripts/cleanup-neon-branches.ts — deletes a branch idle more than 6h
    // once it is either older than 24h or its PR is merged; never the primary,
    // never a `protected` branch, never one whose compute is running) and retry
    // once. Note the idle floor: if every branch was touched in the last 6h the
    // prune frees nothing and the retry fails with the message below.
    let created = tryNeonCmd(`branches create --project-id ${projectId} --name ${branchName} --compute`);
    if (created.error) {
      if (!/limit/i.test(created.error)) {
        console.error(`❌ Neon CLI error: ${created.error}`);
        process.exit(1);
      }
      console.log('⚠️ Neon branch limit reached — running stale-branch cleanup and retrying...');
      execSync('npx tsx scripts/cleanup-neon-branches.ts', { stdio: 'inherit' });
      created = tryNeonCmd(`branches create --project-id ${projectId} --name ${branchName} --compute`);
      if (created.error) {
        console.error(`❌ Branch creation still failing after cleanup: ${created.error}`);
        console.error('   Every remaining Neon branch maps to active work — free one manually.');
        process.exit(1);
      }
    }
    const createdBranch = created.result;
    if (createdBranch && createdBranch.connection_uris && createdBranch.connection_uris.length > 0) {
      const uri = createdBranch.connection_uris[0].connection_uri;
      console.log(`✅ Created branch '${branchName}'!`);
      await updateEnvLocal(uri);
      console.log(`🎉 Ready! Local environment connected to branch: ${branchName}`);
    } else {
        console.error("❌ Failed to parse connection URI from generated branch.");
        process.exit(1);
    }
  } else {
    // A second checkout of the same git branch (a fresh worktree for an open
    // PR) lands here with an .env.local that has never seen this branch.
    // `neonctl connection-string` returns the pooled URI with the role
    // password, so the existing branch can be adopted instead of leaving the
    // guard hook to block every schema step (2026-09-16).
    console.log(`🌿 Branch '${branchName}' already exists — adopting it.`);
    const cs = tryNeonText(`connection-string --branch ${branchName} --project-id ${projectId} --pooled`);
    const uri = typeof cs.result === 'string' ? cs.result.trim() : '';
    if (cs.error || !/^postgres(ql)?:\/\//.test(uri)) {
      console.error(`❌ Could not fetch the branch's connection string: ${cs.error || 'unexpected output'}`);
      console.error('   Retrieve it from the Neon console and set neon__POSTGRES_URL in .env.local.');
      process.exit(1);
    }
    await updateEnvLocal(uri);
    console.log(`🎉 Ready! Local environment connected to existing branch: ${branchName}`);
  }
}

main()
