// dsh-ping tests — fake ctx + fake fetch + fake clock, no network, no host,
// no real sleeps: debounce/dedup timing is driven by a manual clock.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPingPlugin, apply, excerpt, turnEndInfo, normalizeSessionEventArgs } from '../src/index.mjs'

/** Real-timer microtask/macrotask flush (the plugin's fetch is promise-based). */
const flush = () => new Promise((resolve) => { setTimeout(resolve, 0) })

/**
 * Deterministic clock: the plugin receives now/setTimeout/clearTimeout
 * overrides; tests advance virtual time and due timers run synchronously.
 */
function fakeClock(startAt = 0) {
  const state = { now: startAt }
  const timers = new Map()
  let nextId = 0
  const setTimeoutImpl = (fn, ms) => {
    const id = (nextId += 1)
    timers.set(id, { fn, at: state.now + Math.max(0, Number(ms) || 0) })
    return id
  }
  const clearTimeoutImpl = (id) => { timers.delete(id) }
  const advance = (ms) => {
    const target = state.now + ms
    for (;;) {
      let dueId = -1
      let dueAt = Infinity
      for (const [id, timer] of timers) {
        if (timer.at <= target && timer.at < dueAt) { dueId = id; dueAt = timer.at }
      }
      if (dueId < 0) break
      const { fn } = timers.get(dueId)
      timers.delete(dueId)
      state.now = dueAt
      fn()
    }
    state.now = target
  }
  return { now: () => state.now, setTimeoutImpl, clearTimeoutImpl, advance, timers }
}

function fakeCtx() {
  const logs = []
  const registrations = new Map()
  const disposers = []
  const on = (name, fn, options) => {
    if (!registrations.has(name)) registrations.set(name, [])
    const entry = { fn, options }
    registrations.get(name).push(entry)
    return () => {
      const arr = registrations.get(name) ?? []
      const index = arr.indexOf(entry)
      if (index >= 0) arr.splice(index, 1)
    }
  }
  const ctx = {
    on,
    logger: { warn: (...args) => logs.push(args.join(' ')) },
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return () => dispose?.() },
  }
  const fire = (name, ...args) => {
    for (const { fn } of [...(registrations.get(name) ?? [])]) fn(...args)
  }
  const listener = (name) => (registrations.get(name) ?? [])[0]
  const dispose = () => { for (const d of [...disposers]) d?.() }
  return { ctx, logs, registrations, fire, listener, dispose }
}

function fakeFetch(script = [{ ok: true, status: 200 }]) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const step = script[Math.min(calls.length - 1, script.length - 1)]
    if (step === 'network') throw new Error('network down')
    return { ok: step.ok === true, status: step.status ?? (step.ok === true ? 200 : 500) }
  }
  return { impl, calls }
}

const CREDS = { telegram: { botToken: '123:abc', chatId: '42' }, debounceMs: 10 }

function build(overrides = {}, config = CREDS) {
  const fetch = overrides.fetch ?? fakeFetch()
  const harness = overrides.ctx ?? fakeCtx()
  const clock = overrides.clock ?? fakeClock()
  createPingPlugin({
    fetchImpl: fetch.impl,
    now: clock.now,
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
  })(harness.ctx, config)
  return { ...harness, fetch, clock }
}

const turnEnd = (seq, turn, reason = 'completed') => ({ type: 'turn/end', seq, data: { turn, reason } })

test('excerpt collapses whitespace and clamps', () => {
  assert.equal(excerpt('  a\n b  c ', 80), 'a b c')
  assert.equal(excerpt('x'.repeat(100), 10).length, 10)
  assert.ok(excerpt('x'.repeat(100), 10).endsWith('…'))
})

test('turnEndInfo handles string and object reason kinds', () => {
  assert.deepEqual(turnEndInfo({ turn: 3, reason: 'completed' }), { turn: 3, completed: true })
  assert.deepEqual(turnEndInfo({ turn: 3, reason: { kind: 'completed' } }), { turn: 3, completed: true })
  assert.deepEqual(turnEndInfo({ turn: 3, reason: { kind: 'error' } }), { turn: 3, completed: false })
  assert.deepEqual(turnEndInfo(undefined), { turn: 0, completed: false })
})

test('normalizeSessionEventArgs accepts tuple and envelope shapes', () => {
  const session = { id: 's1' }
  const event = { type: 'turn/end', seq: 1 }
  assert.deepEqual(normalizeSessionEventArgs([session, event]), { session, event })
  assert.deepEqual(normalizeSessionEventArgs([{ session, event }]), { session, event })
  assert.equal(normalizeSessionEventArgs([session]), undefined)
})

test('question ping: observer pings and passes the waterfall through untouched', async () => {
  const { fire, listener, fetch } = build()
  const registered = listener('user-questions/request')
  assert.ok(registered, 'waterfall listener registered')
  assert.deepEqual(registered.options, { prepend: true, global: true })
  const sentinel = { answers: [] }
  let nextCalls = 0
  const result = registered.fn(
    { questions: [{ id: 'q1', question: 'Deploy now?  \n or later' }, { id: 'q2', question: 'Second' }] },
    () => { nextCalls += 1; return sentinel },
  )
  assert.equal(result, sentinel, 'next() return value propagates to the host')
  assert.equal(nextCalls, 1)
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.match(fetch.calls[0].body.text, /Question asked: Deploy now\? or later \(\+1 more\)/)
  assert.equal(fetch.calls[0].body.chat_id, '42')
  assert.equal(fetch.calls[0].url, 'https://api.telegram.org/bot123:abc/sendMessage')
})

test('question observer: telegram failure never breaks the waterfall', async () => {
  const fetch = fakeFetch(['network', 'network'])
  const { listener } = build({ fetch })
  const sentinel = { answers: [] }
  const result = listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => sentinel)
  assert.equal(result, sentinel)
  await flush()
  await flush()
  assert.equal(fetch.calls.length, 2, 'retried once, then dropped')
})

test('waterfall contract: a downstream synchronous throw propagates unchanged', () => {
  const { listener } = build()
  const boom = new Error('NO_PROVIDER')
  assert.throws(
    () => listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => { throw boom }),
    (error) => error === boom,
    'same error object, never swallowed',
  )
})

test('waterfall contract: a downstream rejected promise propagates as the same object', async () => {
  const { listener } = build()
  const boom = new Error('late NO_PROVIDER')
  const rejection = Promise.reject(boom)
  const returned = listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => rejection)
  assert.equal(returned, rejection, 'never wrapped, never settled here')
  await assert.rejects(returned, (error) => error === boom)
})

test('question disabled: no ping, pass-through still intact', async () => {
  const { listener, fetch } = build({}, { ...CREDS, events: { question: false, approval: true, turnEnd: true } })
  const sentinel = {}
  const result = listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => sentinel)
  assert.equal(result, sentinel)
  await flush()
  assert.equal(fetch.calls.length, 0)
})

test('turn/end: completed sessions ping after debounce; subagent-origin and incomplete do not', async () => {
  const { fire, fetch, clock } = build()
  fire('session/event', { id: 'root-1', header: { title: 'My Task' } }, turnEnd(10, 2))
  fire('session/event', { id: 'sub-1', header: { title: 'Sub', origin: 'subagent', parentSession: 'root-1' } }, turnEnd(11, 1))
  fire('session/event', { id: 'root-1', header: { title: 'My Task' } }, { type: 'turn/end', seq: 12, data: { turn: 3, reason: { kind: 'error' } } })
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.match(fetch.calls[0].body.text, /✅ Done: My Task \(turn 2\)/)
})

test('turn/end: ordinary fork (parentSession without subagent origin) still pings', async () => {
  const { fire, fetch, clock } = build()
  fire('session/event', { id: 'fork-1', header: { title: 'Forked chat', parentSession: 'root-9' } }, turnEnd(13, 5))
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1, 'fork lineage alone must not suppress the ping')
  assert.match(fetch.calls[0].body.text, /✅ Done: Forked chat \(turn 5\)/)
})

test('turn/end: duplicate replay of the same seq is deduped', async () => {
  const { fire, fetch, clock } = build()
  const session = { id: 'root-2', header: {} }
  for (let i = 0; i < 3; i += 1) fire('session/event', session, turnEnd(7, 1))
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1)
})

test('turn/end: duplicate arriving after the announce fired produces no second ping', async () => {
  const { fire, fetch, clock } = build()
  const session = { id: 'root-4', header: {} }
  fire('session/event', session, turnEnd(7, 1))
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1)
  fire('session/event', session, turnEnd(7, 1))
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1, 'already-announced seq never re-pings')
})

test('turn/end: replay of an announced seq cannot swallow a newer pending ping', async () => {
  const { fire, fetch, clock } = build()
  const session = { id: 'root-5', header: {} }
  fire('session/event', session, turnEnd(7, 1))
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1)
  fire('session/event', session, turnEnd(8, 2))   // schedules a pending announce
  fire('session/event', session, turnEnd(7, 1))   // old replay: must NOT cancel it
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 2, 'the newer turn still announces')
  assert.match(fetch.calls[1].body.text, /\(turn 2\)/)
})

test('turn/end: debounce is independent across sessions (trailing per session)', async () => {
  const { fire, fetch, clock } = build()
  fire('session/event', { id: 'a-1', header: { title: 'A' } }, turnEnd(1, 1))
  fire('session/event', { id: 'b-1', header: { title: 'B' } }, turnEnd(2, 3))
  fire('session/event', { id: 'a-1', header: { title: 'A' } }, turnEnd(3, 2)) // A rebounces
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 2, 'both sessions announce exactly once')
  const texts = fetch.calls.map((c) => c.body.text).sort()
  assert.match(texts[0], /A \(turn 2\)/)
  assert.match(texts[1], /B \(turn 3\)/)
})

test('turn/end: a later event extends the trailing deadline', async () => {
  const { fire, fetch, clock } = build()
  const a = { id: 'trail-a', header: { title: 'A' } }
  const b = { id: 'trail-b', header: { title: 'B' } }
  fire('session/event', a, turnEnd(1, 1)) // t=0: A and B complete
  fire('session/event', b, turnEnd(2, 1))
  clock.advance(5)
  fire('session/event', a, turnEnd(3, 2)) // t=5: A's newer turn extends its deadline
  clock.advance(5) // t=10: B's original deadline fires; A must NOT fire yet
  await flush()
  assert.deepEqual(fetch.calls.map((c) => c.body.text), ['✅ Done: B (turn 1)'], 'only B announces at its deadline')
  clock.advance(5) // t=15: A's extended deadline
  await flush()
  assert.deepEqual(fetch.calls.map((c) => c.body.text), ['✅ Done: B (turn 1)', '✅ Done: A (turn 2)'], 'A announces its newer turn after the extension')
})

test('exported apply(): default wiring works end-to-end with global fetch mocked', async () => {
  // The canary exercises the factory-injected apply; this pins the actual
  // exported entry point (real timers, global fetch) once.
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200 }
  }
  try {
    const harness = fakeCtx()
    apply(harness.ctx, { telegram: { botToken: '123:abc', chatId: '42' }, debounceMs: 10 })
    harness.fire('session/event', { id: 'apply-1', header: { title: 'Apply' } }, turnEnd(1, 1))
    await new Promise((resolve) => { setTimeout(resolve, 40) })
    assert.equal(calls.length, 1, 'exported apply armed and delivered')
    assert.equal(calls[0].body.text, '✅ Done: Apply (turn 1)')
    assert.equal(calls[0].url, 'https://api.telegram.org/bot123:abc/sendMessage')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('sender: 503 then 200 retries once and succeeds', async () => {
  const fetch = fakeFetch([{ ok: false, status: 503 }, { ok: true, status: 200 }])
  const { listener, logs } = build({ fetch })
  listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => ({}))
  await flush()
  await flush()
  assert.equal(fetch.calls.length, 2, 'retried once, then delivered')
  assert.ok(!logs.join('\n').includes('failed'), 'no failure logged')
})

test('sender: two consecutive 5xx responses exhaust the retry and drop with a warning', async () => {
  const fetch = fakeFetch([{ ok: false, status: 503 }, { ok: false, status: 500 }])
  const { listener, logs } = build({ fetch })
  listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => ({}))
  await flush()
  await flush()
  assert.equal(fetch.calls.length, 2, 'exactly one retry')
  assert.ok(logs.join('\n').includes('after retry'), 'drop is logged')
})

test('sender: timeout-shaped abort errors follow the retry-then-drop path', async () => {
  const calls = []
  const impl = async () => {
    calls.push(1)
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    throw error
  }
  const { listener, logs } = build({ fetch: { impl, calls } })
  listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => ({}))
  await flush()
  await flush()
  assert.equal(calls.length, 2, 'abort errors retry once like network errors')
  assert.ok(logs.join('\n').includes('aborted due to timeout'), 'the timeout surfaces in the warning')
})

test('approval/asked: instant ping with tool and reason, deduped by seq', async () => {
  const { fire, fetch } = build()
  fire('session/event', { id: 'root-3', header: {} }, { type: 'approval/asked', seq: 20, data: { toolName: 'bash', reason: 'rm -rf build' } })
  fire('session/event', { id: 'root-3', header: {} }, { type: 'approval/asked', seq: 20, data: { toolName: 'bash', reason: 'rm -rf build' } })
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.match(fetch.calls[0].body.text, /⚠️ Approval requested: bash — rm -rf build/)
})

test('agent/error: opt-in only', async () => {
  const off = build()
  assert.equal(off.listener('agent/error'), undefined)

  const on = build({}, { ...CREDS, events: { question: true, approval: true, turnEnd: true, agentError: true } })
  on.fire('agent/error', { error: new Error('boom') })
  await flush()
  assert.equal(on.fetch.calls.length, 1)
  assert.match(on.fetch.calls[0].body.text, /❗ Agent error: boom/)
})

test('inert without credentials: no listeners, one warn line', async () => {
  const { registrations, logs } = build({}, { telegram: {} })
  assert.equal(registrations.size, 0)
  assert.ok(logs.some((line) => line.includes('inert: telegram.botToken/chatId not configured')))
})

test('telegram 4xx: no retry (config error)', async () => {
  const fetch = fakeFetch([{ ok: false, status: 403 }])
  const { listener } = build({ fetch })
  listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => ({}))
  await flush()
  assert.equal(fetch.calls.length, 1)
})

test('config: debounceMs 0 is honored (immediate announce), not replaced by the default', async () => {
  const { fire, fetch, clock } = build({}, { ...CREDS, debounceMs: 0 })
  fire('session/event', { id: 'z-1', header: {} }, turnEnd(1, 1))
  clock.advance(0)
  await flush()
  assert.equal(fetch.calls.length, 1)
})

test('config: invalid debounceMs falls back to the default; negative clamps to 0', async () => {
  const bad = build({}, { ...CREDS, debounceMs: 'soon' })
  bad.fire('session/event', { id: 'z-2', header: {} }, turnEnd(1, 1))
  bad.clock.advance(999)
  await flush()
  assert.equal(bad.fetch.calls.length, 0, 'default 1000 ms debounce not yet elapsed')
  bad.clock.advance(1)
  await flush()
  assert.equal(bad.fetch.calls.length, 1)

  const infinite = build({}, { ...CREDS, debounceMs: Infinity })
  infinite.fire('session/event', { id: 'z-4', header: {} }, turnEnd(1, 1))
  infinite.clock.advance(999)
  await flush()
  assert.equal(infinite.fetch.calls.length, 0, 'Infinity falls back to the default too')

  const neg = build({}, { ...CREDS, debounceMs: -50 })
  neg.fire('session/event', { id: 'z-3', header: {} }, turnEnd(1, 1))
  neg.clock.advance(0)
  await flush()
  assert.equal(neg.fetch.calls.length, 1, 'negative clamps to 0 = immediate')
})

test('config: JS-coercion traps fall back to the default, never to 0 or 1', async () => {
  // Number(null)===0, Number('')===0, Number(true)===1, Number([])===0 —
  // none of these may become "immediate" or "1 ms" debounce.
  for (const trap of [null, true, false, '', [], ['1000'], {}, { ms: 5 }]) {
    const h = build({}, { ...CREDS, debounceMs: trap })
    h.fire('session/event', { id: `trap-${String(Array.isArray(trap) ? trap.join('') : JSON.stringify(trap))}`.slice(0, 40), header: {} }, turnEnd(1, 1))
    h.clock.advance(999)
    await flush()
    assert.equal(h.fetch.calls.length, 0, `trap ${JSON.stringify(trap)} must fall back to the 1000 ms default`)
    h.clock.advance(1)
    await flush()
    assert.equal(h.fetch.calls.length, 1, `trap ${JSON.stringify(trap)} eventually announces via the default`)
    h.dispose()
  }

  const excerptTrap = build({}, { ...CREDS, excerptChars: null })
  excerptTrap.fire('session/event', { id: 'trap-excerpt', header: {} }, { type: 'approval/asked', seq: 1, data: { toolName: 't'.repeat(200) } })
  await flush()
  const toolExcerpt = /Approval requested: (\S+)/.exec(excerptTrap.fetch.calls[0].body.text)?.[1] ?? ''
  assert.equal(toolExcerpt.length, 80, 'excerptChars: null falls back to the 80 default')
})

test('config: excerptChars clamps to [20, 2048]', async () => {
  const tiny = build({}, { ...CREDS, excerptChars: 5 })
  tiny.fire('session/event', { id: 'c-1', header: {} }, { type: 'approval/asked', seq: 1, data: { toolName: 'x'.repeat(100) } })
  await flush()
  const toolExcerpt = /Approval requested: (\S+)/.exec(tiny.fetch.calls[0].body.text)?.[1] ?? ''
  assert.equal(toolExcerpt.length, 20, 'below-min clamps up to 20')

  const huge = build({}, { ...CREDS, excerptChars: 999_999 })
  huge.listener('user-questions/request').fn({ questions: [{ question: 'y'.repeat(5000) }] }, () => ({}))
  await flush()
  const qExcerpt = /Question asked: (\S+)/.exec(huge.fetch.calls[0].body.text)?.[1] ?? ''
  assert.equal(qExcerpt.length, 2048, 'above-max clamps down to 2048')
})

test('sender: assembled messages are capped at Telegram\u2019s 4,096-char hard limit', async () => {
  // excerptChars maxes at 2048, so an approval with maximal tool + reason
  // excerpts assembles past 4,096 — the sender must cap the final text.
  const { fire, fetch } = build({}, { ...CREDS, excerptChars: 2048 })
  fire('session/event', { id: 'cap-1', header: {} }, {
    type: 'approval/asked',
    seq: 1,
    data: { toolName: 't'.repeat(2048), reason: 'r'.repeat(2048) },
  })
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.equal(fetch.calls[0].body.text.length, 4096)
  assert.ok(fetch.calls[0].body.text.endsWith('…'))
})

test('sender: HTTP 429 is labeled rate-limited and dropped without retry', async () => {
  const fetch = fakeFetch([{ ok: false, status: 429 }])
  const { listener, logs } = build({ fetch })
  listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => ({}))
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.ok(logs.join('\n').includes('rate-limited'))
})

test('sender: unread response bodies are cancelled (undici resource hygiene)', async () => {
  const cancelled = []
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, body: { cancel: async () => { cancelled.push(calls.length) } } }
  }
  const { listener } = build({ fetch: { impl, calls } })
  listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => ({}))
  await flush()
  assert.deepEqual(cancelled, [1], 'body.cancel() ran exactly once for the send')
})

test('logging: bot token never appears in warn output (URL-echoing errors are redacted)', async () => {
  const calls = []
  const impl = async () => { throw new Error('fetch failed: https://api.telegram.org/bot123:abc/sendMessage') }
  const { listener, logs } = build({ fetch: { impl, calls } })
  listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => ({}))
  await flush()
  await flush()
  const joined = logs.join('\n')
  assert.ok(joined.includes('***'), 'redaction marker present')
  assert.ok(!joined.includes('123:abc'), 'raw token never logged')
})

test('armed line masks the chat id and omits the bot token entirely', () => {
  const { logs } = build()
  const armed = logs.find((line) => line.includes('armed:'))
  assert.ok(armed, 'armed line present')
  assert.ok(!armed.includes('123:abc'), 'no token in the armed line')
  assert.ok(!/bot /.test(armed), 'no bot suffix at all')
})

test('disposal: pending announce timers are cancelled and no further sends happen', async () => {
  const { fire, fetch, clock, dispose } = build()
  fire('session/event', { id: 'd-1', header: {} }, turnEnd(1, 1))
  dispose()
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 0, 'timer cancelled by disposal')

  fire('session/event', { id: 'd-1', header: {} }, turnEnd(2, 2))
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 0, 'listener removed; nothing new is sent')
})

test('disposal: an in-flight send does not retry after disposal', async () => {
  const calls = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (calls.length === 1) { await gate; throw new Error('network down after disposal') }
    throw new Error('must not be called twice')
  }
  const { listener, dispose } = build({ fetch: { impl, calls } })
  listener('user-questions/request').fn({ questions: [{ question: 'x' }] }, () => ({}))
  await flush() // first attempt in flight, awaiting the gate
  dispose()
  release()
  await flush()
  await flush()
  assert.equal(calls.length, 1, 'no retry after disposal')
})

test('envelope-shape session/event also pings', async () => {
  const { fire, fetch, clock } = build()
  fire('session/event', { session: { id: 'root-9', header: { title: 'Env Shape' } }, event: turnEnd(30, 1) })
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.match(fetch.calls[0].body.text, /Done: Env Shape/)
})

test('turn/end labels use tracked session/title events', async () => {
  const { fire, fetch, clock } = build()
  fire('session/event', { id: 'session-abc123def456', header: {} }, { type: 'session/title', seq: 40, data: { title: 'Fix login bug' } })
  fire('session/event', { id: 'session-abc123def456', header: {} }, turnEnd(41, 2))
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.match(fetch.calls[0].body.text, /✅ Done: Fix login bug \(turn 2\)/)
})

test('title-less fallback strips the session- prefix from ids', async () => {
  const { fire, fetch, clock } = build()
  fire('session/event', { id: 'session-abc123def456', header: {} }, turnEnd(50, 4))
  clock.advance(10)
  await flush()
  assert.equal(fetch.calls.length, 1)
  assert.match(fetch.calls[0].body.text, /✅ Done: #abc123de \(turn 4\)/)
})
