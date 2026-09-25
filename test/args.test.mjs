// Regression tests for the canary runner's argument parsing.
//
// A pinned version supplied alone used to be silently dropped and replaced
// by the 'next' default (the positional filter excluded index 0 whenever
// --root was absent), so a release-watch check could test the wrong
// release. These tests pin the fixed semantics.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { parseArgs } from '../scripts/dsh-compat.mjs'

test('a pinned version supplied alone is honored, not replaced by next', () => {
  assert.deepEqual(parseArgs(['0.1.7-rc.2']), { requested: '0.1.7-rc.2', keep: false, providedRoot: undefined })
})

test('dist-tags supplied alone are honored', () => {
  assert.equal(parseArgs(['next']).requested, 'next')
  assert.equal(parseArgs(['latest']).requested, 'latest')
})

test('an unknown version string is passed through, never silently swapped', () => {
  // Resolution/validation happens via npm view at run time; the parser must
  // surface the request verbatim so an invalid target FAILS loudly.
  assert.equal(parseArgs(['not-a-version']).requested, 'not-a-version')
})

test('no positional defaults to next', () => {
  assert.equal(parseArgs([]).requested, 'next')
})

test('--keep before the version', () => {
  assert.deepEqual(parseArgs(['--keep', '0.1.7-rc.2']), { requested: '0.1.7-rc.2', keep: true, providedRoot: undefined })
})

test('--keep after the version', () => {
  assert.deepEqual(parseArgs(['0.1.7-rc.2', '--keep']), { requested: '0.1.7-rc.2', keep: true, providedRoot: undefined })
})

test('--keep alone keeps the next default', () => {
  assert.deepEqual(parseArgs(['--keep']), { requested: 'next', keep: true, providedRoot: undefined })
})

test('--root consumes its directory value, not the version', () => {
  assert.deepEqual(parseArgs(['--root', '/tmp/tree', '0.1.7-rc.2']), {
    requested: '0.1.7-rc.2',
    keep: false,
    providedRoot: resolve('/tmp/tree'),
  })
})

test('--root without a version defaults to next', () => {
  assert.deepEqual(parseArgs(['--root', '/tmp/tree']), {
    requested: 'next',
    keep: false,
    providedRoot: resolve('/tmp/tree'),
  })
})

test('--root with --keep and a version', () => {
  assert.deepEqual(parseArgs(['--keep', '--root', '/tmp/tree', 'latest']), {
    requested: 'latest',
    keep: true,
    providedRoot: resolve('/tmp/tree'),
  })
})

test('--root without a value is an error', () => {
  assert.match(parseArgs(['--root']).error, /needs a directory value/)
  assert.match(parseArgs(['--root', '--keep']).error, /needs a directory value/)
})

test('two positionals are an error', () => {
  assert.match(parseArgs(['0.1.7-rc.1', '0.1.7-rc.2']).error, /at most one version/)
})

test('unknown flags are an error', () => {
  assert.match(parseArgs(['--bogus']).error, /unknown flag/)
})

test('help requests short-circuit', () => {
  assert.deepEqual(parseArgs(['--help']), { help: true })
  assert.deepEqual(parseArgs(['-h']), { help: true })
})
