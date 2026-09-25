#!/usr/bin/env node
// dsh-ping installation smoke test — the user path the canary does not cover.
//
// The compatibility canary imports the plugin into real DSH components, but
// it never exercises the user-facing installation path. This script does:
//
//   1. Disposable DSH_HOME + a fresh profile from the shipped web template.
//   2. `dsh plugin --profile <p> add <source>` — the real install flow.
//   3. `--dump-config` proves the dsh-ping bundle is composed into the
//      profile tree (bundle registration).
//   4. Boots the profile with NO Telegram credentials, asserts HTTP
//      readiness on the bound port, and asserts the plugin's own inert
//      boot line — runtime proof the plugin loaded and did not break
//      startup. A configured-transport functional check is NOT in scope
//      here: fixture-based delivery behavior is covered by the canary.
//
// Usage:
//   node scripts/dsh-install-smoke.mjs [--source <github-ref-or-path>] [--keep]
//     --source   defaults to this checkout (pre-push validation);
//                post-push/CI should pass the public ref, e.g.
//                github:chintoleung/dsh-ping#<full-sha>
//     --keep     retain the disposable DSH_HOME even on success
//
// Requires: `dsh` (with `pnpm` reachable) on PATH. Tests the INSTALLED dsh
// host, not a downloaded one — record its version alongside any results.
//
// Boundaries: local boot smoke, not a browser-rendering or live Telegram
// delivery test, and not dsh.so's own server-side verification.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const PROFILE = 'websmoke'
const BOOT_TIMEOUT_MS = 120_000

const rawArgs = process.argv.slice(2)
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log('Usage: node scripts/dsh-install-smoke.mjs [--source <github-ref-or-path>] [--keep]')
  process.exit(0)
}
const sourceIndex = rawArgs.indexOf('--source')
if (sourceIndex !== -1 && (rawArgs[sourceIndex + 1] === undefined || rawArgs[sourceIndex + 1].startsWith('--'))) {
  console.error('[smoke] --source needs a value')
  process.exit(2)
}
const source = sourceIndex !== -1 ? rawArgs[sourceIndex + 1] : repo
const keep = rawArgs.includes('--keep')

// Isolation: temp DSH_HOME, no inherited Telegram credentials (the inert
// boot line is an assertion target, not an accident), and no inherited
// npm_config_allow_scripts (npm ≥11.19 rejects project installs whose
// allow-scripts arrives via env; dsh plugin add shells out to a package
// manager that inherits this process's environment).
let home
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^DSH_PING_TG_(TOKEN|CHAT)$/.test(key) || /^(TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID)$/.test(key) || /^npm_config_allow_scripts/i.test(key)) {
    delete env[key]
  }
}

function tail(text, lines = 25) {
  return String(text).trim().split('\n').slice(-lines).join('\n')
}

function die(message) {
  // No cleanup on failure: the disposable DSH_HOME is retained for diagnosis.
  console.error(`[smoke] FAILED — ${message}${home ? ` (DSH_HOME retained for diagnosis: ${home})` : ''}`)
  process.exit(1)
}

const dshV = spawnSync('dsh', ['-V'], { encoding: 'utf8', timeout: 30_000, env })
if (dshV.error || dshV.status !== 0) die(`dsh not runnable on PATH (${dshV.error?.message ?? `exit ${dshV.status}`})`)
console.log(`[smoke] host dsh ${String(dshV.stdout).trim()} · source ${source}`)

try {
  home = mkdtempSync(join(tmpdir(), 'dsh-ping-smoke-'))
  env.DSH_HOME = home

  // 1. Fresh profile from the shipped web template (also persists it).
  const init = spawnSync('dsh', ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], { encoding: 'utf8', timeout: 60_000, env })
  if (init.status !== 0) die(`profile init failed (exit ${init.status}):\n${tail(init.stdout + init.stderr)}`)

  // 2. Real installation flow.
  const install = spawnSync('dsh', ['plugin', '--profile', PROFILE, 'add', source], { stdio: 'inherit', timeout: 300_000, env })
  if (install.status !== 0) die(`dsh plugin add failed (exit ${install.status})`)

  // 3. Bundle composed into the profile tree.
  const dump = spawnSync('dsh', ['--profile', PROFILE, '--dump-config'], { encoding: 'utf8', timeout: 60_000, env })
  if (dump.status !== 0) die(`--dump-config failed (exit ${dump.status}):\n${tail(dump.stdout + dump.stderr)}`)
  if (!String(dump.stdout).includes('dsh-ping')) die('dsh-ping not present in the composed profile tree')

  // 4. Boot with no credentials: HTTP readiness + the plugin's inert line.
  const child = spawn('dsh', ['--profile', PROFILE, '--no-open', '--port', '0'], { env })
  let combined = ''
  let url = null
  child.stdout.on('data', (chunk) => { combined += chunk })
  child.stderr.on('data', (chunk) => { combined += chunk })

  const exited = new Promise((resolveExit) => child.on('exit', (code, signal) => resolveExit({ code, signal })))
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (!url && Date.now() < deadline) {
    const match = combined.match(/https?:\/\/[\w.-]+:\d+/)
    if (match) url = match[0]
    else if (child.exitCode !== null) break
    else await new Promise((r) => setTimeout(r, 250))
  }
  if (!url) {
    child.kill('SIGKILL')
    die(`boot did not announce an HTTP URL within ${BOOT_TIMEOUT_MS / 1000}s:\n${tail(combined)}`)
  }

  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    child.kill('SIGKILL')
    die(`HTTP readiness check failed for ${url}: ${error.message}`)
  }
  // Intentionally supported statuses only: successful responses, or the
  // expected unauthenticated 401 from the browser-trust fence (proof the
  // protected server is responding — not of authenticated UI). Anything
  // else — 403, 404, 5xx — fails the smoke.
  if (!(response.status === 401 || (response.status >= 200 && response.status < 300))) {
    child.kill('SIGKILL')
    die(`HTTP readiness check got unexpected ${response.status} from ${url} (expected 2xx or 401)`)
  }

  if (!combined.includes('[dsh-ping]')) {
    child.kill('SIGKILL')
    die('plugin produced no boot log line:\n' + tail(combined))
  }
  if (!/inert/.test(combined)) {
    child.kill('SIGKILL')
    die('plugin boot line is not inert with empty credentials:\n' + tail(combined))
  }

  child.kill('SIGTERM')
  await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000)).then(() => child.kill('SIGKILL'))])
  console.log(`[smoke] PASS — installed, composed, HTTP ${response.status} on ${url}, inert boot line present`)
  console.log('[smoke] boundaries: local boot smoke against the installed dsh host; no browser/live-Telegram coverage')
  if (!keep) rmSync(home, { recursive: true, force: true })
  else console.error(`[smoke] --keep: DSH_HOME retained at ${home}`)
  process.exit(0)
} catch (error) {
  die(error instanceof Error ? error.message : String(error))
}
