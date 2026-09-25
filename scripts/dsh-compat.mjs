#!/usr/bin/env node
// dsh-ping real-DSH compatibility canary runner.
//
// Installs a pinned @deepseek-ai/dsh release plus the matching
// dsh-agent-loop-testkit into a temp dir, then runs test/dsh-compat.test.mjs
// against it with an ISOLATED environment (temp DSH_HOME, temp cwd, live
// Telegram credentials stripped, install scripts disabled).
//
// Usage:
//   npm run test:dsh -- <version-or-dist-tag>   e.g. next | latest | 0.1.7-rc.1
//   node scripts/dsh-compat.mjs --root <dir>    use a pre-provisioned DSH tree (offline)
//
// Flags: --keep  retain the temp installation even on success
//        --help  this text
//
// The runner asserts the INSTALLED dsh/testkit versions equal the resolved
// target (a pinned request must never silently test something else), cleans
// up the temp installation on success unless --keep, and retains it on any
// failure for diagnosis.
//
// Interpretation: an environment/setup failure means "compatibility not
// evaluated", not "incompatible".
//
// parseArgs() is exported for test/args.test.mjs; the main path only runs
// when this file is executed directly.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const USAGE = `Usage:
  npm run test:dsh -- <version-or-dist-tag>   install that DSH release + matching testkit
  node scripts/dsh-compat.mjs --root <dir>    use a pre-provisioned DSH tree (offline)
Flags:
  --keep   retain the temp installation even on success
  --help   show this text
An environment/setup failure means "compatibility not evaluated", not "incompatible".`

/**
 * Parse runner arguments (the array after `node scripts/dsh-compat.mjs`).
 * Exported for regression tests. Returns one of:
 *   { help: true }
 *   { error: <message> }
 *   { requested, keep, providedRoot }   requested defaults to 'next'
 */
export function parseArgs(args) {
  const KNOWN_FLAGS = new Set(['--keep', '--root', '--help', '-h'])
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  for (const arg of args) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.has(arg)) {
      return { error: `unknown flag: ${arg}` }
    }
  }
  const keep = args.includes('--keep')
  const rootIndex = args.indexOf('--root')
  let providedRoot
  if (rootIndex !== -1) {
    providedRoot = args[rootIndex + 1]
    if (!providedRoot || providedRoot.startsWith('--')) return { error: '--root needs a directory value' }
    providedRoot = resolve(providedRoot)
  }
  // Positional = the requested version/dist-tag. The token after --root is
  // its directory argument, never the version. With --root absent the filter
  // must keep index 0 — `index !== rootIndex + 1` alone drops it when
  // rootIndex is -1, silently replacing a pinned version with 'next'.
  const positional = args.filter((arg, index) => !arg.startsWith('--') && (rootIndex === -1 || index !== rootIndex + 1))
  if (positional.length > 1) return { error: 'expected at most one version/dist-tag' }
  return { requested: positional[0] ?? 'next', keep, providedRoot }
}

/** Bounded subprocess; throws spawn errors instead of leaving them to stdout parsing. */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    timeout: 180_000,
    killSignal: 'SIGKILL',
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  })
  if (result.error) throw result.error
  return result
}

// npm ≥11.19 allow-scripts scoping: a project-scoped install must source
// allow-scripts from the project (package.json/.npmrc), never inherited
// CLI/env config. `npm run` exports its whole config as npm_config_* env
// vars into this script, so the child npm sees the inherited allow-scripts
// as CLI-scoped and fails with EALLOWSCRIPTS. Strip it here: the install
// already runs with --ignore-scripts, so nothing may execute either way.
const npmEnv = { ...process.env }
for (const key of Object.keys(npmEnv)) {
  if (/^npm_config_allow_scripts/i.test(key)) delete npmEnv[key]
}

function installedVersion(root, name) {
  try {
    return JSON.parse(readFileSync(join(root, 'node_modules', '@deepseek-ai', name, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(`[dsh-compat] ${parsed.error}\n\n${USAGE}`)
    process.exit(2)
  }
  if (parsed.help) {
    console.log(USAGE)
    process.exit(0)
  }
  const { requested, keep, providedRoot } = parsed
  const repo = fileURLToPath(new URL('..', import.meta.url))

  let compatRoot = providedRoot
  let created = false
  try {
    if (!compatRoot) {
      compatRoot = mkdtempSync(join(tmpdir(), 'dsh-ping-compat-'))
      created = true

      const view = run('npm', ['view', `@deepseek-ai/dsh@${requested}`, 'version', '--json'], { cwd: compatRoot, timeout: 60_000, env: npmEnv })
      if (view.status !== 0) throw new Error(`could not resolve @deepseek-ai/dsh@${requested} (npm view exit ${view.status ?? view.signal})`)
      const viewed = JSON.parse(view.stdout)
      if (typeof viewed !== 'string') throw new Error(`target ${requested} must resolve to exactly one DSH release`)
      // The testkit is an upstream devDependency whose dist-tags lag dsh's, so
      // pin BOTH packages to the exact same version for a consistent pair.
      const testkit = run('npm', ['view', `@deepseek-ai/dsh-agent-loop-testkit@${viewed}`, 'version', '--json'], { cwd: compatRoot, timeout: 60_000, env: npmEnv })
      if (testkit.status !== 0) throw new Error(`no dsh-agent-loop-testkit@${viewed} on npm — this release cannot be canaried (installation retained at ${compatRoot})`)

      console.log(`[dsh-compat] installing dsh@${viewed} + dsh-agent-loop-testkit@${viewed} into ${compatRoot}`)
      const install = run('npm', [
        'install', '--ignore-scripts', '--no-audit', '--no-fund',
        `@deepseek-ai/dsh@${viewed}`,
        `@deepseek-ai/dsh-agent-loop-testkit@${viewed}`,
      ], { cwd: compatRoot, stdio: 'inherit', env: npmEnv })
      if (install.status !== 0) throw new Error(`npm install failed (exit ${install.status ?? install.signal}); installation retained at ${compatRoot}`)

      // The resolved target is the contract: whatever lands in node_modules
      // must be exactly it, or a pinned request silently tested something else.
      const dshInstalled = installedVersion(compatRoot, 'dsh')
      const testkitInstalled = installedVersion(compatRoot, 'dsh-agent-loop-testkit')
      if (dshInstalled !== viewed || testkitInstalled !== viewed) {
        throw new Error(`installed versions drifted from resolved target ${viewed} (dsh ${dshInstalled}, testkit ${testkitInstalled}); installation retained at ${compatRoot}`)
      }
    }

    const dshVersion = installedVersion(compatRoot, 'dsh')
    const testkitVersion = installedVersion(compatRoot, 'dsh-agent-loop-testkit')
    console.log(`[dsh-compat] dsh ${dshVersion} · testkit ${testkitVersion} · DSH_COMPAT_ROOT=${compatRoot}`)

    // Isolation: fresh DSH_HOME and working directory, no inherited live
    // credentials, absolute test path. The canary stubs Telegram delivery and
    // uses an offline model adapter — no live bot/provider credentials needed.
    const home = mkdtempSync(join(tmpdir(), 'dsh-ping-home-'))
    const env = { ...process.env, DSH_COMPAT_ROOT: compatRoot, DSH_HOME: home }
    for (const key of Object.keys(env)) {
      if (/^DSH_PING_TG_(TOKEN|CHAT)$/.test(key) || /^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)$/.test(key)) {
        delete env[key]
      }
    }

    const test = run(process.execPath, ['--test', join(repo, 'test/dsh-compat.test.mjs')], {
      cwd: home,
      env,
      stdio: 'inherit',
      timeout: 120_000,
    })
    rmSync(home, { recursive: true, force: true })

    if (test.status !== 0) {
      if (created) console.error(`[dsh-compat] FAILED — installation retained for diagnosis: ${compatRoot}`)
      process.exit(test.status ?? 1)
    }
    if (created && keep) console.error(`[dsh-compat] --keep: installation retained at ${compatRoot}`)
    if (created && !keep) rmSync(compatRoot, { recursive: true, force: true })
    process.exit(0)
  } catch (error) {
    console.error(`[dsh-compat] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
