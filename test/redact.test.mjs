// Tests for personal-path redaction in verification logs.
//
// Published compat logs must not carry personal filesystem paths
// (maintainer policy: sanitize before publishing, preserve meaning).
// verify-run.mjs redacts home-directory prefixes at log-write time;
// these tests pin that contract.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as verifyRun from '../scripts/verify-run.mjs'

const redact = verifyRun.redactPersonalPaths

test('verify-run exports the redaction helper', () => {
  assert.equal(typeof redact, 'function', 'verify-run.mjs must export redactPersonalPaths (and stay import-safe)')
})

test('redacts macOS home-directory prefixes, keeping the rest of the path', () => {
  assert.equal(
    redact('pnpm store at /Users/chintoleung/Library/pnpm/store/v11 done'),
    'pnpm store at ~/Library/pnpm/store/v11 done',
  )
})

test('redacts Linux home-directory prefixes', () => {
  assert.equal(redact('/home/someuser/.cache/dsh/x.tar'), '~/.cache/dsh/x.tar')
})

test('redacts every occurrence on a line', () => {
  assert.equal(
    redact('from /Users/alice/a to /Users/bob/b'),
    'from ~/a to ~/b',
  )
})

test('leaves non-home paths untouched', () => {
  const line = 'temp at /var/folders/ab/c123/T/xyz and /tmp/scratch and /Users'
  assert.equal(redact(line), line)
})

test('handles a bare home directory with trailing punctuation', () => {
  assert.equal(redact('root: /Users/chintoleung, done'), 'root: ~, done')
})
