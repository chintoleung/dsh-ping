// dsh-ping real-DSH compatibility canary.
//
// Boots actual DSH components (cordis Context, AgentLoop, UserQuestionService,
// ApprovalService, SessionTitleService, dsh-agent-loop-testkit) with an
// offline model adapter and drives the plugin through real event semantics:
// completion pings, subagent-origin skip, approval-before-decision, the
// global/prepended question observer, downstream failure propagation, error
// opt-in, and unload/reload lifecycle.
//
// Requires a DSH installation tree to resolve host packages from; skipped
// unless DSH_COMPAT_ROOT is set so the default suite stays dependency-free.
// Canonical runner: npm run test:dsh -- <version|latest|next> (see
// scripts/dsh-compat.mjs), which installs the requested DSH release into a
// temp dir and points this file at it.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setImmediate as yieldToHost } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import * as pingPlugin from '../src/index.mjs'

const directory = process.env.DSH_COMPAT_ROOT

if (!directory) {
  test('dsh compatibility canary (skipped: DSH_COMPAT_ROOT not set)', { skip: true }, () => {})
} else {
  await runCanary(directory)
}

async function runCanary(directory) {
  // Catch accidental use of real fetch, even if the plugin swallows its error.
  // This is a fetch guard, not an OS-level network sandbox.
  const originalFetch = globalThis.fetch
  let unexpectedFetches = 0

  globalThis.fetch = async () => {
    unexpectedFetches += 1
    throw new Error('Real fetch is disabled in the compatibility canary')
  }

  after(() => {
    globalThis.fetch = originalFetch
    assert.equal(unexpectedFetches, 0, 'Unexpected use of real fetch')
  })

  const requireHost = createRequire(join(directory, 'package.json'))
  const importHost = (name) => import(pathToFileURL(requireHost.resolve(name)).href)

  const [
    { Context },
    { LlmAdapter, createUserMessage },
    { SessionId },
    { mountAgentLoopTestDependencies },
    { AgentLoop },
    { UserQuestionService },
    { ApprovalService },
    { SessionTitleService },
  ] = await Promise.all([
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-agent-loop-testkit',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-user-questions',
    '@deepseek-ai/dsh-user-approval',
    '@deepseek-ai/dsh-session-title',
  ].map(importHost))

  class OfflineModel extends LlmAdapter {
    calls = 0
    error = null
    beforeReply = async () => {}

    async *stream(options) {
      options.signal?.throwIfAborted()
      this.calls += 1
      await this.beforeReply()
      if (this.error) throw this.error

      yield { index: 0, type: 'block-start', blockType: 'text' }
      yield { index: 0, type: 'text-delta', text: 'compat-ok' }
      yield {
        index: 0,
        type: 'block-end',
        block: { type: 'text', text: 'compat-ok' },
      }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  const TOKEN = '123:compat-test-only'
  const CHAT = '42'
  const question = (agent) => ({
    agent,
    questions: [{ id: 'q1', question: 'Continue the compatibility check?' }],
  })

  const check = (name, body) => test(name, { timeout: 15_000 }, body)

  async function host(t) {
    const ctx = new Context()
    const attempts = []
    const pending = new Set()
    const transport = { fail: false, gate: null, onAttempt: () => {} }

    t.after(async () => {
      transport.gate?.resolve()
      await ctx.fiber.dispose()

      // Assertions stay outside fetch: the plugin intentionally catches
      // errors thrown inside its delivery path.
      for (const attempt of attempts) {
        assert.equal(
          attempt.url,
          `https://api.telegram.org/bot${TOKEN}/sendMessage`,
        )
        assert.equal(attempt.method, 'POST')
        assert.equal(attempt.body.chat_id, CHAT)
        assert.equal(typeof attempt.body.text, 'string')
        assert.equal(attempt.body.parse_mode, undefined)
      }
    })

    await mountAgentLoopTestDependencies(ctx)

    const model = new OfflineModel()
    ctx.llm.registerAdapter(['dsh-ping-compat'], model)

    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(SessionTitleService, {
      fallbackMaxWords: 8,
      fallbackMaxBytes: 80,
      maxTitleBytes: 200,
    })

    // cordis gates service properties behind inject declarations; expose
    // ctx.userQuestions to the harness through a minimal accessor plugin.
    let userQuestions
    await ctx.plugin({
      name: 'dsh-ping-compat-accessor',
      inject: ['userQuestions'],
      apply(accessorCtx) { userQuestions = accessorCtx.userQuestions },
    })

    const apply = pingPlugin.createPingPlugin({
      fetchImpl: async (url, init) => {
        attempts.push({
          url: String(url),
          method: init.method,
          body: JSON.parse(init.body),
        })
        transport.onAttempt()
        if (transport.gate) await transport.gate.promise
        if (transport.fail) throw new Error('Synthetic Telegram outage')

        return new Response('{"ok":true,"result":{"message_id":1}}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },

      // Control only the plugin's debounce timers, not DSH's timers.
      setTimeoutImpl: (callback) => {
        pending.add(callback)
        return callback
      },
      clearTimeoutImpl: (callback) => pending.delete(callback),
    })

    return {
      ctx,
      model,
      attempts,
      pending,
      transport,
      userQuestions,
      texts: () => attempts.map((attempt) => attempt.body.text),

      async mount(events = {}, owner = ctx) {
        const fiber = owner.plugin({ ...pingPlugin, apply }, {
          telegram: { botToken: TOKEN, chatId: CHAT },
          debounceMs: 1000,
          events,
        })
        await fiber

        // Do not return a potentially thenable Fiber from an async function.
        return { dispose: () => fiber.dispose() }
      },

      async create(id, options = {}) {
        const handle = await ctx.agents.create({
          ...options,
          sessionId: SessionId(`session-${id}`),
          agentOptions: {
            provider: 'dsh-ping-compat',
            model: 'offline',
          },
        })
        return handle.agent
      },

      async drive(agent) {
        const before = model.calls
        agent.followup(createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'Compatibility check' }],
        }))
        await agent.whenIdle()
        assert.equal(model.calls, before + 1, 'The real loop must call the model')
      },

      async flush() {
        await yieldToHost()
        for (const callback of [...pending]) {
          pending.delete(callback)
          callback()
        }
        await yieldToHost()
      },
    }
  }

  check('real completion + title notify; subagent completion does not', async (t) => {
    const h = await host(t)
    await h.mount()

    const root = await h.create('root')
    h.ctx.sessionTitle.rename(root.session, 'Compatibility canary')
    await h.drive(root)

    assert.equal(h.attempts.length, 0, 'Completion must be deferred')
    assert.equal(h.pending.size, 1)
    await h.flush()

    assert.deepEqual(h.texts(), [
      '✅ Done: Compatibility canary (turn 1)',
    ])

    const child = await h.create('child', {
      parentAgent: root,
      meta: {
        origin: 'subagent',
        parentSession: root.id,
        delegationDepth: 1,
      },
    })

    assert.ok(!h.ctx.agents.roots().includes(child))
    await h.drive(child)
    await h.flush()
    assert.equal(h.attempts.length, 1, 'Child completion must not notify')
  })

  check('real approval request notifies without changing its decision', async (t) => {
    const h = await host(t)
    await h.mount({ turnEnd: false })
    const agent = await h.create('approval')

    agent.ctx.on('approval/request', () => 'rejected')

    let decision
    h.model.beforeReply = async () => {
      decision = await h.ctx.approval.request({
        agent,
        toolName: 'compat-tool',
        reason: 'Compatibility check only',
      })
    }

    await h.drive(agent)
    await h.flush()

    assert.equal(decision, 'rejected')
    assert.equal(h.attempts.length, 1)
    assert.match(
      h.texts()[0],
      /Approval .*compat-tool.*Compatibility check only/,
    )
  })

  check('question observer is global, prepended, and does not await delivery', async (t) => {
    const h = await host(t)
    const asker = await h.create('asker')
    const other = await h.create('other')
    const order = []
    const answer = { answers: [{ id: 'q1', selected: ['yes'] }] }
    let foreignCalls = 0

    // Register before the terminal answerer so a routing regression is visible.
    other.ctx.on('user-questions/request', (_request, next) => {
      foreignCalls += 1
      return next()
    })
    asker.ctx.on('user-questions/request', () => {
      order.push('answerer')
      return answer
    })

    h.transport.gate = Promise.withResolvers()
    h.transport.onAttempt = () => order.push('ping')

    // Deliberately mount under the WRONG agent scope. Only global:true
    // should let this observer see the asker's request.
    await h.mount({}, other.ctx)

    const result = await h.userQuestions.ask(question(asker))

    assert.equal(result, answer)
    assert.equal(foreignCalls, 0)
    assert.deepEqual(order, ['ping', 'answerer'])
    assert.match(h.texts()[0], /Question .*Continue the compatibility check/)

    h.transport.gate.resolve()
    await h.flush()
  })

  check('downstream failures survive a Telegram outage unchanged', async (t) => {
    const h = await host(t)
    await h.mount()
    const agent = await h.create('rejections')
    h.transport.fail = true

    for (const mode of ['throw', 'reject', 'no-provider']) {
      const sentinel = new Error(`downstream ${mode}`)
      let observed
      const before = h.attempts.length

      const remove = agent.ctx.on(
        'user-questions/request',
        (_request, next) => {
          if (mode === 'throw') throw sentinel
          if (mode === 'reject') return Promise.reject(sentinel)

          // Capture the actual error produced by DSH's fallback.
          return next().catch((error) => {
            observed = error
            throw error
          })
        },
      )

      try {
        await assert.rejects(
          () => h.userQuestions.ask(question(agent)),
          (error) => {
            assert.equal(error, mode === 'no-provider' ? observed : sentinel)
            if (mode === 'no-provider') assert.equal(error.code, 'NO_PROVIDER')
            return true
          },
        )

        await h.flush()
        assert.equal(h.attempts.length - before, 2, 'One retry, then drop')
      } finally {
        remove()
      }
    }
  })

  for (const enabled of [false, true]) {
    check(`real agent error: notification enabled=${enabled}`, async (t) => {
      const h = await host(t)
      await h.mount({ agentError: enabled })
      const agent = await h.create('failure')
      const errors = []

      h.ctx.on('agent/error', (payload) => errors.push(payload))
      h.model.error = new Error('compat-provider-failure')

      await h.drive(agent)
      await h.flush()

      assert.ok(errors.length > 0, 'DSH must actually report an agent error')
      assert.equal(h.attempts.length, enabled ? 1 : 0)
      if (enabled) {
        assert.match(h.texts()[0], /Agent error:.*compat-provider-failure/)
      }
      assert.ok(!h.texts().some((text) => text.startsWith('✅')))
    })
  }

  check('unload clears pending work and listeners; reload does not duplicate', async (t) => {
    const h = await host(t)
    const loaded = await h.mount()
    const agent = await h.create('lifecycle')

    await h.drive(agent)
    assert.equal(h.pending.size, 1)

    await loaded.dispose()
    assert.equal(h.pending.size, 0)
    await h.flush()
    assert.equal(h.attempts.length, 0)

    await assert.rejects(
      () => h.userQuestions.ask(question(agent)),
      (error) => error.code === 'NO_PROVIDER',
    )
    await h.drive(agent)
    await h.flush()
    assert.equal(h.attempts.length, 0, 'Disposed listeners must stay removed')

    await h.mount()
    h.ctx.sessionTitle.rename(agent.session, 'Reloaded')
    await h.drive(agent)
    await h.flush()

    assert.equal(h.attempts.length, 1)
    assert.match(h.texts()[0], /^✅ Done: Reloaded /)

    await assert.rejects(
      () => h.userQuestions.ask(question(agent)),
      (error) => error.code === 'NO_PROVIDER',
    )
    await h.flush()
    assert.equal(h.attempts.length, 2, 'Exactly one reloaded question observer')
  })

  check('a runtime-root session with parent lineage still notifies', async (t) => {
    const h = await host(t)
    await h.mount()

    const parent = await h.create('lineage-parent')
    const root = await h.create('lineage-root', {
      // No parentAgent and no subagent origin: a runtime root with fork
      // lineage — the exact case the origin-based skip must NOT silence.
      meta: { parentSession: parent.id },
    })

    assert.ok(h.ctx.agents.roots().includes(root))
    h.ctx.sessionTitle.rename(root.session, 'Lineage root')

    await h.drive(root)
    await h.flush()

    assert.deepEqual(h.texts(), ['✅ Done: Lineage root (turn 1)'])
  })
}
