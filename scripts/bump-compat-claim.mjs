#!/usr/bin/env node
// Publish an evidence-backed compatibility.json record + README summary.
//
// The README carries no handwritten version claims. This script is the ONLY
// writer of compatibility.json records and of the marker-delimited README
// "DSH support at a glance" blocks (EN + 简体中文), both generated from the
// record being published so the three can never drift.
//
// Publishing contract (enforced; exit 1 on violation):
//   - Outcome records REQUIRE --results: a structured JSON produced by
//     scripts/verify-run.mjs from actual exit codes. The publisher
//     cross-checks testedCommit === HEAD and dshVersion === <dshVersion>,
//     then derives outcomes and counts from the file — it never trusts
//     hand-declared `passed`.
//   - Without --results you may only declare NOT-RUN (skipped outcomes),
//     which derives to status pending/blocked/unknown. Publishing
//     passed/failed without execution results is impossible.
//   - The working tree must be clean: pluginCommit records the full SHA of
//     the exact tested commit. Untracked fresh evidence under compat/logs/
//     is allowed — it is run output, committed together with the report.
//   - status `passed` additionally requires an evidence reference whose
//     local file exists (repo-relative) — no evidence, no claim.
//   - History is preserved: records are keyed by (dshVersion, pluginCommit).
//     Re-publishing the same pair replaces that record in place; a new
//     plugin revision prepends a new record. Existing records are never
//     dropped silently.
//
// Usage:
//   node scripts/bump-compat-claim.mjs <dshVersion> [options]
//     <dshVersion>         the verified DSH release (e.g. 0.1.7-rc.2)
//     --results <path>     REQUIRED for outcomes: verify-run results JSON
//                          (repo-relative or absolute)
//     --evidence <ref>     REQUIRED for passed/failed: public log/report —
//                          URL, or repo-relative path (must exist)
//     --testkit <version>  matching dsh-agent-loop-testkit
//                          (default: results.testkitVersion, else <dshVersion>)
//     --status <s>         passed | pending | failed | blocked | unknown
//                          (default derived from the outcomes)
//     --channel <version>  freshly resolved `next` dist-tag at publish time;
//                          recorded as channelVersion/channelCheckedAt
//     --live               ALSO advance the live-verified claim — use ONLY
//                          after a real live pass on the running profile
//     --dry-run            print the planned record and README blocks, change nothing
//     --root <dir>         operate on another checkout (testing)
//
//   Not-run declaration (pending/blocked/unknown only):
//     node scripts/bump-compat-claim.mjs <dshVersion> --unit-tests skipped --canary skipped [--status <s>]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const GH = 'https://github.com/chintoleung/dsh-ping'
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/
const SHA_RE = /^[0-9a-f]{40}$/
const STATUSES = new Set(['passed', 'pending', 'failed', 'blocked', 'unknown'])
const OUTCOMES = new Set(['passed', 'failed', 'skipped'])
const EN_START = '<!-- dsh-compat:start -->'
const EN_END = '<!-- dsh-compat:end -->'
const ZH_START = '<!-- dsh-compat-zh:start -->'
const ZH_END = '<!-- dsh-compat-zh:end -->'

const repo = process.argv.includes('--root')
  ? resolve(process.argv[process.argv.indexOf('--root') + 1])
  : dirname(dirname(fileURLToPath(import.meta.url)))
const rawArgs = process.argv.slice(2)
const flagIndex = new Map()
for (let i = 0; i < rawArgs.length; i += 1) {
  if (rawArgs[i].startsWith('--')) flagIndex.set(rawArgs[i], i)
}

function valueOf(flag) {
  const at = flagIndex.get(flag)
  const value = at === undefined ? undefined : rawArgs[at + 1]
  if (flagIndex.has(flag) && (value === undefined || value.startsWith('--'))) {
    console.error(`[bump-claim] ${flag} needs a value`)
    process.exit(1)
  }
  return value
}

function valueOr(flag, fallback) {
  return flagIndex.has(flag) ? valueOf(flag) : fallback
}

const version = (() => {
  const skipAfter = new Set(['--root', '--results', '--testkit', '--status', '--unit-tests', '--canary', '--channel', '--evidence'])
  return rawArgs.find((a, i) => !a.startsWith('--') && !(i > 0 && skipAfter.has(rawArgs[i - 1])))
})()
const USAGE_LINE = 'usage: node scripts/bump-compat-claim.mjs <dshVersion> --results <verify-run.json> [--evidence <ref>] [--testkit <v>] [--status <s>] [--channel <v>] [--live] [--dry-run] [--root <dir>]\n       node scripts/bump-compat-claim.mjs <dshVersion> --unit-tests skipped --canary skipped [--status pending|blocked|unknown] [flags]'

if (!version || !VERSION_RE.test(version)) {
  console.error(USAGE_LINE)
  console.error(`  <dshVersion> must look like 0.1.7-rc.2 (got: ${version ?? 'nothing'})`)
  process.exit(1)
}

const dryRun = rawArgs.includes('--dry-run')
const live = rawArgs.includes('--live')
const evidence = flagIndex.has('--evidence') ? valueOf('--evidence') : undefined
const channelVersion = flagIndex.has('--channel') ? valueOf('--channel') : undefined
const statusFlag = valueOr('--status', undefined)

function git(args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000 })
  if (result.error) throw result.error
  return result
}

// Clean-tree requirement: the record's pluginCommit must be a real commit,
// and cross-checks against verify-run results depend on HEAD being the
// tested revision. Fresh, untracked evidence under compat/logs/ is permitted
// run output. `-uall` lists untracked files individually — porcelain would
// otherwise collapse a fully-untracked compat/ tree to `?? compat/`.
const porcelain = git(['status', '--porcelain', '-uall']).stdout
const dirty = porcelain.split('\n').filter((line) => line && !/^\?\? compat\/logs\//.test(line))
if (dirty.length) {
  console.error(`[bump-claim] working tree not clean — commit the candidate first; a record must reference a real commit:\n${dirty.join('\n')}`)
  process.exit(1)
}
const sha = git(['rev-parse', 'HEAD']).stdout.trim()
if (!SHA_RE.test(sha)) {
  console.error(`[bump-claim] could not resolve HEAD in ${repo} (got: ${sha})`)
  process.exit(1)
}
const described = git(['describe', '--tags', '--exact-match', 'HEAD'])
const pluginTag = described.status === 0 ? described.stdout.trim() : undefined

// ---- Derive outcomes ------------------------------------------------------
let unitOutcome
let canaryOutcome
let smokeStatus
let unitCount
let canaryCount
let testkitDefault
let resultsRef

if (flagIndex.has('--results')) {
  if (flagIndex.has('--unit-tests') || flagIndex.has('--canary')) {
    console.error('[bump-claim] --unit-tests/--canary are declarations for the not-run path only — with --results the outcomes come from the file')
    process.exit(1)
  }
  const resultsPath = valueOf('--results')
  const absolute = isAbsolute(resultsPath) ? resultsPath : join(repo, resultsPath)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch (error) {
    console.error(`[bump-claim] cannot read --results ${resultsPath}: ${error.message}`)
    process.exit(1)
  }
  if (parsed.testedCommit !== sha) {
    console.error(`[bump-claim] stale results: testedCommit ${parsed.testedCommit} ≠ HEAD ${sha} — rerun verify-run against this commit`)
    process.exit(1)
  }
  if (parsed.dshVersion !== version) {
    console.error(`[bump-claim] results dshVersion ${parsed.dshVersion} ≠ requested ${version}`)
    process.exit(1)
  }
  unitOutcome = parsed.unitTests?.status
  canaryOutcome = parsed.canary?.status
  smokeStatus = parsed.smoke?.status
  if (!OUTCOMES.has(unitOutcome ?? '') || !OUTCOMES.has(canaryOutcome ?? '') || (smokeStatus !== undefined && !OUTCOMES.has(smokeStatus))) {
    console.error('[bump-claim] results file lacks valid unitTests/canary statuses — regenerate it with scripts/verify-run.mjs')
    process.exit(1)
  }
  unitCount = typeof parsed.unitTests.passed === 'number' ? parsed.unitTests.passed : undefined
  canaryCount = typeof parsed.canary.passed === 'number' ? parsed.canary.passed : undefined
  testkitDefault = VERSION_RE.test(parsed.testkitVersion ?? '') ? parsed.testkitVersion : undefined
  resultsRef = isAbsolute(resultsPath) ? resultsPath.slice(repo.length + 1) : resultsPath
} else {
  const declaredUnit = valueOf('--unit-tests')
  const declaredCanary = valueOf('--canary')
  if (declaredUnit !== 'skipped' || declaredCanary !== 'skipped') {
    console.error('[bump-claim] outcomes require --results (execution evidence); without it you may only declare --unit-tests skipped --canary skipped')
    process.exit(1)
  }
  unitOutcome = 'skipped'
  canaryOutcome = 'skipped'
}

const testkit = valueOr('--testkit', testkitDefault ?? version)
const anyFailed = unitOutcome === 'failed' || canaryOutcome === 'failed' || smokeStatus === 'failed'
const anySkipped = unitOutcome === 'skipped' || canaryOutcome === 'skipped'
const derivedStatus = anyFailed ? 'failed' : anySkipped ? 'pending' : 'passed'
const status = statusFlag ?? derivedStatus

if (!STATUSES.has(status)) {
  console.error(`[bump-claim] invalid --status ${status}`)
  process.exit(1)
}
if (!VERSION_RE.test(testkit)) {
  console.error(`[bump-claim] --testkit must look like 0.1.7-rc.2 (got: ${testkit})`)
  process.exit(1)
}
if (status === 'passed' && (anyFailed || anySkipped)) {
  console.error('[bump-claim] status passed is inconsistent with the recorded outcomes — rejected')
  process.exit(1)
}
if (status === 'passed' && !evidence) {
  console.error('[bump-claim] --evidence is REQUIRED for passed records — no evidence, no claim')
  process.exit(1)
}
if (status === 'failed' && !evidence) {
  console.error('[bump-claim] --evidence is REQUIRED for failed records — publish the failing log')
  process.exit(1)
}
if (channelVersion !== undefined && !VERSION_RE.test(channelVersion)) {
  console.error(`[bump-claim] --channel must look like 0.1.7-rc.2 (got: ${channelVersion})`)
  process.exit(1)
}
if (evidence !== undefined && !/^https?:\/\//.test(evidence) && !existsSync(join(repo, evidence.replace(/^\.\//, '').replace(/^\//, '')))) {
  console.error(`[bump-claim] evidence file not found: ${evidence} — a published claim must point at a real artifact`)
  process.exit(1)
}

const COMPAT = join(repo, 'compatibility.json')
const PKG = join(repo, 'package.json')
const README = join(repo, 'README.md')
let pkg
let compat
let readme
try {
  pkg = JSON.parse(readFileSync(PKG, 'utf8'))
  readme = readFileSync(README, 'utf8')
} catch (error) {
  console.error(`[bump-claim] cannot read repo files under ${repo}: ${error.message}`)
  process.exit(1)
}
try {
  compat = JSON.parse(readFileSync(COMPAT, 'utf8'))
} catch (error) {
  if (error.code === 'ENOENT') compat = { records: [] }
  else {
    console.error(`[bump-claim] compatibility.json is malformed (${error.message}) — fix by hand, never bulldoze`)
    process.exit(1)
  }
}
if (!Array.isArray(compat.records)) {
  console.error('[bump-claim] compatibility.json lacks a records[] array — fix by hand, never bulldoze')
  process.exit(1)
}
if (compat.schemaVersion !== undefined && compat.schemaVersion !== 1) {
  console.error(`[bump-claim] unknown compatibility.json schemaVersion ${compat.schemaVersion} — upgrade the publisher first`)
  process.exit(1)
}

const now = new Date().toISOString()
const passing = status === 'passed' && unitOutcome === 'passed' && canaryOutcome === 'passed'
const record = {
  status,
  dshVersion: version,
  testkitVersion: testkit,
  pluginVersion: pkg.version,
  pluginCommit: sha,
  installRef: `${GH.replace('https://github.com/', 'github:')}#${sha}`,
  node: process.version,
  platform: `${process.platform} ${release()} ${process.arch}`,
  unitTests: unitOutcome,
  canary: canaryOutcome,
  verifiedAt: now,
}
if (pluginTag !== undefined) record.pluginTag = pluginTag
if (unitCount !== undefined) record.unitTestsPassed = unitCount
if (canaryCount !== undefined) record.canaryChecksPassed = canaryCount
if (smokeStatus !== undefined) record.smoke = smokeStatus
if (resultsRef !== undefined) record.results = resultsRef
if (channelVersion !== undefined) {
  record.channelVersion = channelVersion
  record.channelCheckedAt = now
}
if (evidence !== undefined) record.evidence = evidence

const existingAt = compat.records.findIndex((r) => r && r.dshVersion === version && r.pluginCommit === sha)
if (existingAt === -1) compat.records.unshift(record)
else compat.records[existingAt] = record

const nextCompat = {
  ...compat,
  schemaVersion: 1,
  channel: compat.channel ?? 'next',
  channelVersion: channelVersion ?? compat.channelVersion,
  channelCheckedAt: channelVersion !== undefined ? now : compat.channelCheckedAt,
  records: compat.records,
}

const nextClaims = { ...(pkg.dshCompatibility ?? {}) }
if (passing) nextClaims.canaryVerified = version
if (live) nextClaims.liveVerified = version

// Repo-relative evidence is committed with the generated report, which lands
// AFTER the tested commit — so a sha-pinned blob URL would 404 until history
// rewriting. Pin to master (resolvable as soon as the report is pushed);
// the record itself keeps the repo-relative path for in-checkout readers.
const evidenceUrl = (ref) => (/^https?:\/\//.test(ref) ? ref : `${GH}/blob/master/${ref.replace(/^\.\//, '').replace(/^\//, '')}`)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const utc = new Date(record.verifiedAt)
const enTime = `${MONTHS[utc.getUTCMonth()]} ${utc.getUTCDate()}, ${utc.getUTCFullYear()} · ${String(utc.getUTCHours()).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')} UTC`
const zhTime = `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, '0')}-${String(utc.getUTCDate()).padStart(2, '0')} ${String(utc.getUTCHours()).padStart(2, '0')}:${String(utc.getUTCMinutes()).padStart(2, '0')} UTC`
const rev = SHA_RE.test(record.pluginCommit) ? record.pluginCommit.slice(0, 7) : record.pluginCommit
const pluginCell = `\`${rev}\``
const unitText = unitOutcome === 'passed' ? (unitCount !== undefined ? `${unitCount} passed` : 'passed') : unitOutcome
const canaryText = canaryOutcome === 'passed' ? (canaryCount !== undefined ? `${canaryCount} passed; none skipped` : 'passed') : canaryOutcome
const smokeRow = record.smoke !== undefined ? `| Installation smoke | ${record.smoke} |\n` : ''
const smokeRowZh = record.smoke !== undefined ? `| 安装冒烟测试 | ${{ passed: '通过', failed: '失败', skipped: '跳过' }[record.smoke]} |\n` : ''

function enHeadline() {
  if (status === 'passed') {
    return `**✅ Verified with DSH \`${record.dshVersion}\`**\n\n_\`next\` as checked ${enTime} · Plugin \`${rev}\`_`
  }
  const mark = { failed: '❌ Latest published check FAILED', pending: '⏳ Verification pending', blocked: '🚧 Verification blocked', unknown: '❔ No usable verification result' }[status]
  return `**${mark}: DSH \`${record.dshVersion}\`**`
}

function zhHeadline() {
  if (status === 'passed') {
    return `**✅ 已随 DSH \`${record.dshVersion}\` 验证**\n\n_\`next\` 检查于 ${zhTime} · 插件 \`${rev}\`_`
  }
  const mark = { failed: '❌ 最新发布检查失败', pending: '⏳ 验证进行中', blocked: '🚧 验证受阻', unknown: '❔ 暂无可用验证结果' }[status]
  return `**${mark}：DSH \`${record.dshVersion}\`**`
}

function renderEn() {
  const logLine = evidence !== undefined ? `[Verification log](${evidenceUrl(evidence)})` : '_no evidence reference published_'
  const channelRow = channelVersion !== undefined
    ? `| Channel resolved at publish | \`${channelVersion}\` · checked ${enTime} |\n`
    : ''
  return `## DSH support at a glance

${enHeadline()}

| Check | Published result |
|---|---|
| Tracked release channel | \`next\` |
${channelRow}| Tested plugin revision | ${pluginCell} |
| Unit tests | ${unitText} |
| Real-DSH compatibility canary | ${canaryText} |
${smokeRow}| Verification time | ${enTime} |
| Test environment | Node.js ${record.node} · ${record.platform} |

[Machine-readable compatibility][compatibility] ·
${logLine}

We track DSH's \`next\` channel through release monitoring and
maintainer-run verification. DSH keeps its native question cards,
answers, and approval handling; dsh-ping only sends notifications.

"Verified with" identifies our published test result at the stated
time. A newer upstream release remains unverified until its checks
pass. npm's separate \`latest\` channel must be checked independently.

This is maintainer-produced compatibility evidence, not a claim of
independent dsh.so verification.`
}

function renderZh() {
  const logLine = evidence !== undefined ? `[验证日志](${evidenceUrl(evidence)})` : '_未发布证据引用_'
  const channelRowZh = channelVersion !== undefined ? `| 发布时渠道解析 | \`${channelVersion}\` · 检查于 ${zhTime} |\n` : ''
  const unitZh = unitOutcome === 'passed' ? (unitCount !== undefined ? `${unitCount} 通过` : '通过') : { failed: '失败', skipped: '跳过' }[unitOutcome]
  const canaryZh = canaryOutcome === 'passed' ? (canaryCount !== undefined ? `${canaryCount} 通过；无跳过` : '通过') : { failed: '失败', skipped: '跳过' }[canaryOutcome]
  return `## DSH 支持速览

${zhHeadline()}

| 项目 | 已发布结果 |
|---|---|
| 跟踪的发布渠道 | \`next\` |
${channelRowZh}| 被测插件修订 | ${pluginCell} |
| 单元测试 | ${unitZh} |
| 真实 DSH 兼容性 canary | ${canaryZh} |
${smokeRowZh}| 验证时间 | ${zhTime} |
| 测试环境 | Node.js ${record.node} · ${record.platform} |

[机器可读兼容性数据][compatibility] ·
${logLine}

我们通过发布监控与维护者执行的验证跟踪 DSH 的 \`next\` 渠道。
DSH 保留原生问题卡片、回答与审批处理；dsh-ping 只负责通知。

“已随 … 验证”指所述时间点发布的测试结果。更新的上游版本在检查
通过前一律视为未验证。npm 单独的 \`latest\` 渠道需单独验证。

这是维护者产出的兼容性证据，不代表 dsh.so 的独立验证。`
}

function spliceBlock(text, start, end, block) {
  const i = text.indexOf(start)
  const j = text.indexOf(end)
  if (i === -1 || j === -1) {
    console.error(`[bump-claim] README is missing the ${start.slice(0, 22)}… markers — fix by hand, never bulldoze`)
    process.exit(1)
  }
  if (j < i || text.indexOf(start, i + 1) !== -1 || text.indexOf(end, j + 1) !== -1) {
    console.error('[bump-claim] README compatibility markers are duplicated or out of order — fix by hand')
    process.exit(1)
  }
  return text.slice(0, i) + start + '\n' + block + '\n' + end + text.slice(j + end.length)
}

const newReadme = spliceBlock(spliceBlock(readme, EN_START, EN_END, renderEn()), ZH_START, ZH_END, renderZh())

const report = [
  `compatibility.json: ${existingAt === -1 ? 'prepend' : 'replace'} record dsh ${version} @ ${rev} (${status}, unit ${unitOutcome}, canary ${canaryOutcome}${record.smoke ? `, smoke ${record.smoke}` : ''})`,
  `installRef: ${record.installRef}${pluginTag ? ` (tag ${pluginTag})` : ' (untagged commit)'}`,
  `outcomes source: ${resultsRef !== undefined ? `results ${resultsRef} (cross-checked: testedCommit=HEAD, dshVersion)` : 'not-run declaration'}`,
  `README: regenerated ${EN_START.slice(0, 22)}… EN + 简体中文 blocks`,
  `package.json dshCompatibility: ${passing ? `canary ${pkg.dshCompatibility?.canaryVerified ?? '—'} → ${nextClaims.canaryVerified}` : 'unchanged (record is not a full pass)'}${live ? `, live → ${nextClaims.liveVerified}` : ''}`,
]

if (dryRun) {
  console.log(`[bump-claim] dry-run — would write (${repo}):`)
  console.log(JSON.stringify(record, null, 2))
  console.log('--- README EN block ---')
  console.log(renderEn())
  console.log('--- README ZH block ---')
  console.log(renderZh())
  for (const line of report) console.log(`  ${line}`)
  process.exit(0)
}

writeFileSync(COMPAT, JSON.stringify(nextCompat, null, 2) + '\n')
if (passing || live) {
  pkg.dshCompatibility = nextClaims
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n')
}
writeFileSync(README, newReadme)

// Post-write verification: exactly one record for the pair, README blocks
// carry the published facts, and package.json advanced on a full pass.
const rewrittenCompat = JSON.parse(readFileSync(COMPAT, 'utf8'))
const matches = rewrittenCompat.records.filter((r) => r && r.dshVersion === version && r.pluginCommit === sha)
if (matches.length !== 1 || matches[0].status !== status || matches[0].unitTests !== unitOutcome || matches[0].canary !== canaryOutcome) {
  console.error('[bump-claim] post-write check failed on compatibility.json — restore from git')
  process.exit(1)
}
const rewrittenReadme = readFileSync(README, 'utf8')
const enBlock = rewrittenReadme.slice(rewrittenReadme.indexOf(EN_START), rewrittenReadme.indexOf(EN_END))
if (!enBlock.includes(record.dshVersion) || !enBlock.includes(rev)) {
  console.error('[bump-claim] post-write check failed: README EN block lacks the published version/revision — restore from git')
  process.exit(1)
}
if (evidence !== undefined && !rewrittenReadme.includes(evidenceUrl(evidence))) {
  console.error('[bump-claim] post-write check failed: README lacks the evidence link — restore from git')
  process.exit(1)
}
if (passing && JSON.parse(readFileSync(PKG, 'utf8')).dshCompatibility?.canaryVerified !== version) {
  console.error('[bump-claim] post-write check failed: package.json canary claim not advanced — restore from git')
  process.exit(1)
}
console.log(`[bump-claim] published (dsh ${version}, ${status}):`)
for (const line of report) console.log(`  ${line}`)
