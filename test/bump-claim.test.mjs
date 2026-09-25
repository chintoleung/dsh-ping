// Safety-contract tests for the compatibility publisher.
//
// The publisher is the only writer of compatibility claims; these tests pin
// its enforcement rules using a disposable git fixture operated via --root.
// Outcomes must come from a verify-run results JSON cross-checked against
// HEAD — hand-declared `passed` is unpublishable by construction.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const PUBLISHER = join(repo, 'scripts/bump-compat-claim.mjs')
const README_TEMPLATE = `# fixture\n\n<!-- dsh-compat:start -->\nstale\n<!-- dsh-compat:end -->\n\n<!-- dsh-compat-zh:start -->\n旧内容\n<!-- dsh-compat-zh:end -->\n`

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ping-bump-'))
  const g = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' })
  g('init', '-q')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-ping', version: '0.1.1',
    dshCompatibility: { canaryVerified: '0.1.7-rc.1', liveVerified: '0.1.7-rc.1' },
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'README.md'), README_TEMPLATE)
  g('add', '-A')
  g('commit', '-qm', 'init')
  return { dir, g }
}

function head(dir) {
  return spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
}

const RESULTS_REF = 'compat/logs/verify.results.json'
const LOG_REF = 'compat/logs/verify.log'

function writeArtifacts(dir, over = {}) {
  const base = {
    schemaVersion: 1,
    testedCommit: head(dir),
    dshVersion: '0.1.7-rc.2',
    testkitVersion: '0.1.7-rc.2',
    unitTests: { status: 'passed', passed: 3, skipped: 1 },
    canary: { status: 'passed', passed: 8, skipped: 0 },
    smoke: { status: 'passed' },
    executedAt: new Date().toISOString(),
    node: 'v99.9.9',
    platform: 'test 0.0.0 x64',
  }
  const merged = {
    ...base,
    ...over,
    unitTests: { ...base.unitTests, ...(over.unitTests ?? {}) },
    canary: { ...base.canary, ...(over.canary ?? {}) },
    smoke: over.smoke === null ? undefined : { ...base.smoke, ...(over.smoke ?? {}) },
  }
  if (over.smoke === null) delete merged.smoke
  mkdirSync(join(dir, 'compat/logs'), { recursive: true })
  writeFileSync(join(dir, RESULTS_REF), JSON.stringify(merged, null, 2) + '\n')
  writeFileSync(join(dir, LOG_REF), '# simulated verification log\n')
}

function publish(dir, ...args) {
  return spawnSync(process.execPath, [PUBLISHER, ...args, '--root', dir], { encoding: 'utf8' })
}

function compat(dir) {
  return JSON.parse(readFileSync(join(dir, 'compatibility.json'), 'utf8'))
}

function pkg(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

test('outcomes without --results are rejected', () => {
  const { dir } = fixture()
  const r = publish(dir, '0.1.7-rc.2', '--unit-tests', 'passed', '--canary', 'passed')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /--results/)
  rmSync(dir, { recursive: true, force: true })
})

test('a missing results file is rejected', () => {
  const { dir } = fixture()
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /cannot read --results/)
  rmSync(dir, { recursive: true, force: true })
})

test('stale results (testedCommit ≠ HEAD) are rejected', () => {
  const { dir, g } = fixture()
  writeArtifacts(dir)
  writeFileSync(join(dir, 'touch.txt'), 'x')
  g('add', '-A')
  g('commit', '-qm', 'move on') // results now describe the previous commit
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /stale results/)
  rmSync(dir, { recursive: true, force: true })
})

test('results dshVersion mismatch is rejected', () => {
  const { dir } = fixture()
  writeArtifacts(dir, { dshVersion: '0.1.9-rc.1' })
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /dshVersion/)
  rmSync(dir, { recursive: true, force: true })
})

test('a repo-relative evidence path that does not exist is rejected', () => {
  const { dir } = fixture()
  writeArtifacts(dir)
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', 'compat/logs/nope.log')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /evidence file not found/)
  rmSync(dir, { recursive: true, force: true })
})

test('declarations are forbidden alongside --results', () => {
  const { dir } = fixture()
  writeArtifacts(dir)
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--unit-tests', 'passed')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /declarations/)
  rmSync(dir, { recursive: true, force: true })
})

test('happy path: outcomes, counts, smoke, and README all derive from the results file', () => {
  const { dir } = fixture()
  const sha = head(dir)
  writeArtifacts(dir)
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF, '--channel', '0.1.7-rc.2')
  assert.equal(r.status, 0, r.stderr)

  const c = compat(dir)
  assert.equal(c.schemaVersion, 1)
  assert.equal(c.channel, 'next')
  assert.equal(c.channelVersion, '0.1.7-rc.2')
  assert.equal(c.records.length, 1)
  const rec = c.records[0]
  assert.equal(rec.status, 'passed')
  assert.equal(rec.pluginCommit, sha)
  assert.equal(rec.installRef, `github:chintoleung/dsh-ping#${sha}`)
  assert.equal(rec.pluginTag, undefined)
  assert.equal(rec.unitTestsPassed, 3)
  assert.equal(rec.canaryChecksPassed, 8)
  assert.equal(rec.smoke, 'passed')
  assert.equal(rec.testkitVersion, '0.1.7-rc.2') // derived from results
  assert.equal(rec.results, RESULTS_REF)

  const readme = readFileSync(join(dir, 'README.md'), 'utf8')
  assert.match(readme, /Verified with DSH `0\.1\.7-rc\.2`/)
  assert.match(readme, /Tested plugin revision/)
  assert.match(readme, new RegExp(sha.slice(0, 7)))
  assert.match(readme, /3 passed/)
  assert.match(readme, /8 passed; none skipped/)
  assert.match(readme, /Installation smoke \| passed/)
  assert.match(readme, /\/blob\/master\/compat\/logs\/verify\.log/)
  assert.match(readme, /已随 DSH `0\.1\.7-rc\.2` 验证/)
  assert.match(readme, /被测插件修订/)
  assert.match(readme, /安装冒烟测试/)

  assert.equal(pkg(dir).dshCompatibility.canaryVerified, '0.1.7-rc.2')
  assert.equal(pkg(dir).dshCompatibility.liveVerified, '0.1.7-rc.1') // untouched without --live
  rmSync(dir, { recursive: true, force: true })
})

test('a failed smoke in the results derives status failed and advances nothing', () => {
  const { dir, g } = fixture()
  writeArtifacts(dir, { smoke: { status: 'failed' } })
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF)
  assert.equal(r.status, 0, r.stderr)
  const rec = compat(dir).records[0]
  assert.equal(rec.status, 'failed')
  assert.equal(rec.smoke, 'failed')
  assert.equal(pkg(dir).dshCompatibility.canaryVerified, '0.1.7-rc.1') // unchanged
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /FAILED/)

  g('add', 'compatibility.json', 'README.md', 'package.json') // commit the report, stay clean
  g('commit', '-qm', 'report')
  writeArtifacts(dir, { smoke: { status: 'failed' } }) // results for the new HEAD
  const forced = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF, '--status', 'passed')
  assert.notEqual(forced.status, 0)
  assert.match(forced.stderr, /inconsistent/)
  rmSync(dir, { recursive: true, force: true })
})

test('not-run declarations publish pending without evidence', () => {
  const { dir } = fixture()
  const r = publish(dir, '0.2.0-rc.1', '--unit-tests', 'skipped', '--canary', 'skipped')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(compat(dir).records[0].status, 'pending')
  assert.equal(compat(dir).records[0].evidence, undefined)
  rmSync(dir, { recursive: true, force: true })
})

test('blocked is declarable for uncanaried releases', () => {
  const { dir } = fixture()
  const r = publish(dir, '0.2.0-rc.1', '--unit-tests', 'skipped', '--canary', 'skipped', '--status', 'blocked')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(compat(dir).records[0].status, 'blocked')
  rmSync(dir, { recursive: true, force: true })
})

test('a dirty tracked tree is rejected', () => {
  const { dir } = fixture()
  writeArtifacts(dir)
  writeFileSync(join(dir, 'README.md'), README_TEMPLATE + '\nstray edit\n')
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /not clean/)
  rmSync(dir, { recursive: true, force: true })
})

test('missing README markers are rejected, never bulldozed', () => {
  const { dir, g } = fixture()
  writeFileSync(join(dir, 'README.md'), '# no markers here\n')
  g('add', 'README.md') // commit only the marker strip; artifacts stay untracked
  g('commit', '-qm', 'strip markers')
  writeArtifacts(dir) // fresh testedCommit for the new HEAD
  const r = publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /markers/)
  rmSync(dir, { recursive: true, force: true })
})

test('same pair replaces in place; a new plugin commit appends history', () => {
  const { dir, g } = fixture()
  const commitReport = () => { g('add', 'compatibility.json', 'README.md', 'package.json'); g('commit', '-qm', 'report') }
  writeArtifacts(dir)
  assert.equal(publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF).status, 0)
  // discard the report, still at the same clean HEAD → republish replaces
  g('checkout', '--', '.')
  g('clean', '-fdq')
  writeArtifacts(dir)
  assert.equal(publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF).status, 0)
  assert.equal(compat(dir).records.length, 1)
  commitReport()

  writeFileSync(join(dir, 'touch.txt'), 'x')
  g('add', 'touch.txt') // keep the run artifacts untracked
  g('commit', '-qm', 'change')
  writeArtifacts(dir) // results for the new HEAD (artifacts stay untracked)
  const sha2 = head(dir)
  assert.equal(publish(dir, '0.1.7-rc.2', '--results', RESULTS_REF, '--evidence', LOG_REF).status, 0)
  const records = compat(dir).records
  assert.equal(records.length, 2)
  assert.equal(records[0].pluginCommit, sha2)
  assert.notEqual(records[1].pluginCommit, sha2)
  rmSync(dir, { recursive: true, force: true })
})
