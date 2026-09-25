#!/usr/bin/env node
// dsh-ping verification orchestrator — run the suites, record the truth.
//
// Runs the syntax checks, unit suite, real-DSH canary, and installation
// smoke in one bounded pass, tees everything into a human-readable log, and
// writes a machine-readable results JSON that scripts/bump-compat-claim.mjs
// REQUIRES when publishing. Outcomes are captured from actual exit codes —
// a failed phase makes the whole run exit nonzero, and nothing downstream
// can mistake a failed run for a passing one.
//
// Usage:
//   node scripts/verify-run.mjs <dshVersion> [--source <github-ref-or-path>] [--skip-smoke]
//     <dshVersion>  exact DSH release to canary (never a moving tag)
//     --source      passed to the install smoke (default: this checkout);
//                   post-push runs should pass the public ref, e.g.
//                   github:chintoleung/dsh-ping#<full-sha>
//     --skip-smoke  omit the installation smoke (constrained environments);
//                   the results JSON then carries no smoke entry
//
// Outputs (both under compat/logs/):
//   <stamp>-dsh-<version>.log          full combined output
//   <stamp>-dsh-<version>.results.json consumed by the publisher, which
//                                       cross-checks testedCommit and
//                                       dshVersion before publishing
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/

const rawArgs = process.argv.slice(2)
if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
  console.log('Usage: node scripts/verify-run.mjs <dshVersion> [--source <ref-or-path>] [--skip-smoke]')
  process.exit(0)
}
const sourceIndex = rawArgs.indexOf('--source')
if (sourceIndex !== -1 && (rawArgs[sourceIndex + 1] === undefined || rawArgs[sourceIndex + 1].startsWith('--'))) {
  console.error('[verify] --source needs a value')
  process.exit(2)
}
const source = sourceIndex !== -1 ? rawArgs[sourceIndex + 1] : repo
const skipSmoke = rawArgs.includes('--skip-smoke')
const dshVersion = rawArgs.find((a, i) => !a.startsWith('--') && rawArgs[i - 1] !== '--source')
if (!dshVersion || !VERSION_RE.test(dshVersion)) {
  console.error('[verify] an exact DSH version is required (e.g. 0.1.7-rc.2), never a moving tag')
  process.exit(2)
}

const now = new Date()
const stamp = `${now.toISOString().slice(0, 10).replace(/-/g, '')}T${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`
const base = `compat/logs/${stamp}-dsh-${dshVersion}`
const LOG = join(repo, `${base}.log`)
const RESULTS = join(repo, `${base}.results.json`)

const testedCommit = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
if (testedCommit.status !== 0) {
  console.error('[verify] not a git checkout — cannot record the tested commit')
  process.exit(1)
}
const sha = testedCommit.stdout.trim()

mkdirSync(join(repo, 'compat/logs'), { recursive: true })
const logLines = [
  `# dsh-ping verification run — ${now.toISOString()}`,
  `# node ${process.version} · ${process.platform} ${release()} ${process.arch}`,
  `# dsh target ${dshVersion} · smoke source ${skipSmoke ? '(skipped)' : source}`,
]
const results = {
  schemaVersion: 1,
  testedCommit: sha,
  dshVersion,
  executedAt: now.toISOString(),
  node: process.version,
  platform: `${process.platform} ${release()} ${process.arch}`,
}

let failed = false

function phase(key, label, command, args, { countSummary = false } = {}) {
  const began = Date.now()
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: 420_000, maxBuffer: 20 * 1024 * 1024, cwd: repo })
  const exit = r.status ?? 1
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  logLines.push('', `# ${label} — exit ${exit} (${((Date.now() - began) / 1000).toFixed(1)}s)`, out)
  const entry = { status: exit === 0 ? 'passed' : 'failed' }
  if (countSummary) {
    const pass = out.match(/ℹ pass (\d+)/)
    const skipped = out.match(/ℹ skipped (\d+)/)
    if (pass) entry.passed = Number(pass[1])
    if (skipped) entry.skipped = Number(skipped[1])
  }
  results[key] = entry
  if (exit !== 0) {
    failed = true
    console.error(`[verify] ${label} FAILED (exit ${exit})`)
  } else {
    console.log(`[verify] ${label} passed${entry.passed !== undefined ? ` (${entry.passed} tests)` : ''}`)
  }
  return out
}

phase('syntaxChecks', 'syntax check src/index.mjs', process.execPath, ['--check', 'src/index.mjs'])
for (const script of ['scripts/dsh-compat.mjs', 'scripts/bump-compat-claim.mjs', 'scripts/dsh-install-smoke.mjs', 'scripts/verify-run.mjs']) {
  phase('syntaxChecks', `syntax check ${script}`, process.execPath, ['--check', script])
}
phase('unitTests', 'unit suite', 'npm', ['test'], { countSummary: true })

const canaryOut = phase('canary', `real-DSH compatibility canary (dsh@${dshVersion})`, 'npm', ['run', 'test:dsh', '--', dshVersion], { countSummary: true })
const installed = canaryOut.match(/\[dsh-compat\] dsh (\S+) · testkit (\S+)/)
if (installed) {
  results.installedDshVersion = installed[1]
  results.testkitVersion = installed[2]
}

if (!skipSmoke) {
  phase('smoke', 'installation smoke', process.execPath, ['scripts/dsh-install-smoke.mjs', '--source', source])
}

writeFileSync(LOG, `${logLines.join('\n')}\n`)
writeFileSync(RESULTS, `${JSON.stringify(results, null, 2)}\n`)
console.log(`[verify] log: ${base}.log`)
console.log(`[verify] results: ${base}.results.json`)
console.log(`[verify] tested commit: ${sha}`)
process.exit(failed ? 1 : 0)
