// SPDX-License-Identifier: MIT
// dsh-ping — notification-only DSH observer plugin.
//
// Mission: ping Telegram when something needs the operator. The web GUI
// (desktop browser or the dsh-mobile gateway tab) remains the ONLY answering
// surface; this plugin never intercepts, never settles, never answers.
//
// Maintenance contract (the entire host-contact surface — see README):
//   1. `session/event` (plain emit, tuple (session, event) or single envelope)
//      - event.type 'turn/end'     → ping when reason.kind === 'completed'
//                                    and the session was not created as a
//                                    subagent (header.origin === 'subagent';
//                                    parentSession alone is fork lineage —
//                                    ordinary forks still ping), debounced
//                                    per session (default 1s, trailing).
//      - event.type 'approval/asked' → ping immediately (toolName/reason).
//   2. `user-questions/request` (agent-scoped waterfall) → PASS-THROUGH
//      observer registered { prepend: true, global: true }: ping, then
//      `return next()`. It must never alter the waterfall's result; a
//      downstream rejection (e.g. NO_PROVIDER) propagates untouched.
//   3. `agent/error` (opt-in, default off) → ping the error message.
//
// Pings report OBSERVED requests, not guaranteed pending state: DSH appends
// approval/asked BEFORE the decision (outcomes include cancelled/rejected/
// unavailable), and the question observer pings before the downstream
// waterfall runs (which may reject with NO_PROVIDER). Wording follows that.
//
// Delivery: one fetch POST to the Telegram Bot API sendMessage (plain text,
// 10s timeout, one retry on network/5xx; 4xx — including 429 — is dropped
// without retry, so messages can be lost during bursts).
// Fire-and-forget: ping failures log a warning and are dropped — a dead
// notification channel must never break the host or the waterfall.
//
// Zero service injections (no `inject`), zero dependencies, zero state on
// disk. DSH breaking-change exposure = the event names above, which dsh-mobile
// and the web GUI consume themselves, so an upstream rename breaks them
// together — a co-signal to watch, not a guarantee.

export const name = 'dsh-ping'

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const DEFAULT_CONFIG = {
  enabled: true,
  debounceMs: 1000,
  excerptChars: 80,
  telegram: {},
  events: { question: true, approval: true, turnEnd: true, agentError: false },
}

/**
 * Finite-number clamp for config values. Accepts numbers and non-blank
 * numeric strings only: null/true/false/''/[] all coerce to numbers in JS
 * (Number(null) === 0 — YAML `debounceMs: null` must NOT mean "immediate"),
 * so anything else falls back to the default. Valid values clamp to
 * [min, max]; an explicit 0 survives.
 */
function finiteNumber(value, fallback, min, max) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function resolveConfig(raw = {}) {
  const cfg = isRecord(raw) ? raw : {}
  const eventsRaw = isRecord(cfg.events) ? cfg.events : {}
  const telegramRaw = isRecord(cfg.telegram) ? cfg.telegram : {}
  return {
    enabled: cfg.enabled !== false,
    // debounceMs: 0 = announce immediately; bounded at 1 h.
    debounceMs: finiteNumber(cfg.debounceMs, DEFAULT_CONFIG.debounceMs, 0, 3_600_000),
    // excerptChars: bounded [20, 2048]; the sender additionally caps the
    // final assembled message at Telegram's 4,096-char hard limit.
    excerptChars: finiteNumber(cfg.excerptChars, DEFAULT_CONFIG.excerptChars, 20, 2048),
    telegram: {
      botToken: typeof telegramRaw.botToken === 'string' ? telegramRaw.botToken.trim() : '',
      chatId: String(telegramRaw.chatId ?? '').trim(),
    },
    events: {
      question: eventsRaw.question !== false,
      approval: eventsRaw.approval !== false,
      turnEnd: eventsRaw.turnEnd !== false,
      agentError: eventsRaw.agentError === true,
    },
  }
}

/** Collapse whitespace and clamp to `maxChars` (single line, ellipsis tail). */
export function excerpt(text, maxChars = DEFAULT_CONFIG.excerptChars) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, Math.max(1, maxChars - 1))}…`
}

/** dsh-mobile parity: turn/end completion payload (reason as string or {kind}). */
export function turnEndInfo(data) {
  if (!isRecord(data)) return { turn: 0, completed: false }
  const reason = data.reason
  const completed = typeof reason === 'string'
    ? reason === 'completed'
    : isRecord(reason) && reason.kind === 'completed'
  const turn = Number(data.turn)
  return { turn: Number.isInteger(turn) && turn > 0 ? turn : 0, completed }
}

/** Hosts pass either (session, event) or a single {session, event} envelope. */
export function normalizeSessionEventArgs(args) {
  if (!Array.isArray(args)) return undefined
  const [first, second] = args
  if (args.length === 2 && isRecord(first) && isRecord(second) && typeof second.type === 'string') {
    return { session: first, event: second }
  }
  if (args.length === 1 && isRecord(first) && isRecord(first.session) && isRecord(first.event) && typeof first.event.type === 'string') {
    return { session: first.session, event: first.event }
  }
  return undefined
}

/** Titles are session LOG events (session/title, data.title) — track them passively. */
function createTitleTracker(cap = 256) {
  const titles = new Map()
  return {
    remember(sessionId, title) {
      if (sessionId === '' || title === '') return
      if (titles.size >= cap && !titles.has(sessionId)) {
        titles.delete(titles.keys().next().value)
      }
      titles.set(sessionId, title)
    },
    of(sessionId) {
      return titles.get(sessionId) ?? ''
    },
  }
}

/** Prefer a tracked title; fall back to #<short id> (ids look like session-<uuid>). */
function sessionLabel(session, knownTitle = '') {
  for (const candidate of [knownTitle, session?.header?.title, session?.title]) {
    const title = excerpt(candidate, 60)
    if (title !== '') return title
  }
  const id = String(session?.id ?? '').replace(/^session-/, '')
  return id === '' ? '(untitled)' : `#${id.slice(0, 8)}`
}

const maskTail = (value) => (String(value).length <= 4 ? '***' : `…${String(value).slice(-4)}`)

/** Bounded novelty filter: true = first sight, false = duplicate. */
function createDedup(cap = 512, ttlMs = 24 * 60 * 60 * 1000, now = Date.now) {
  const seen = new Map()
  return (key) => {
    const at = now()
    const previous = seen.get(key)
    if (previous !== undefined && at - previous <= ttlMs) {
      seen.set(key, at)
      return false
    }
    if (seen.size >= cap) {
      const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1])
      for (let i = 0; i < Math.floor(cap / 2); i += 1) seen.delete(oldest[i][0])
    }
    seen.set(key, at)
    return true
  }
}

/** Telegram sendMessage hard limit: 4,096 characters per message. */
const MAX_MESSAGE_CHARS = 4096

function createTelegramSender({ botToken, chatId, fetchImpl, warn, timeoutMs = 10_000, shouldAbort }) {
  const endpoint = `https://api.telegram.org/bot${botToken}/sendMessage`
  async function sendText(rawText) {
    // Defensive final cap: excerpts are already bounded, but the assembled
    // message (e.g. approval tool + reason excerpts) may still exceed the limit.
    const text = rawText.length > MAX_MESSAGE_CHARS ? `${rawText.slice(0, MAX_MESSAGE_CHARS - 1)}…` : rawText
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (shouldAbort?.()) return false // disposed: no new send, no retry
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        // Undici hygiene: consume or cancel response bodies explicitly
        // instead of relying on garbage collection; we never read them.
        try { await response.body?.cancel?.() } catch { /* cleanup is best-effort */ }
        if (response.ok) return true
        if (response.status >= 400 && response.status < 500) {
          const note = response.status === 429 ? 'rate-limited; dropped without retry' : 'client error, dropped without retry'
          warn(`telegram sendMessage failed: HTTP ${response.status} (${note})`)
          return false
        }
      } catch (error) {
        if (attempt === 2) {
          warn(`telegram sendMessage failed: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      }
    }
    warn('telegram sendMessage failed after retry')
    return false
  }
  return sendText
}

/**
 * Build the plugin apply() with injectable platform pieces (tests pass fakes).
 * @param {{ fetchImpl?, now?, setTimeoutImpl?, clearTimeoutImpl? }} [overrides]
 */
export function createPingPlugin(overrides = {}) {
  const fetchImpl = overrides.fetchImpl ?? globalThis.fetch
  const now = overrides.now ?? Date.now
  const schedule = overrides.setTimeoutImpl ?? setTimeout
  const cancelTimeout = overrides.clearTimeoutImpl ?? clearTimeout
  if (typeof fetchImpl !== 'function') {
    throw new Error('dsh-ping: no fetch implementation available (Node >= 18 required)')
  }

  return function apply(ctx, rawConfig = {}) {
    const config = resolveConfig(rawConfig)
    const { botToken, chatId } = config.telegram
    // cordis logger + stderr: some host shapes never print logger output
    // to a user-visible surface, so warn on both channels.
    const baseWarn = (message) => {
      try { ctx?.logger?.warn?.('[dsh-ping]', message) } catch { /* logging must never be fatal */ }
      try { console.error('[dsh-ping]', message) } catch { /* ditto */ }
    }
    // Redaction at the logging boundary: an exception message can echo the
    // request URL, which embeds the bot token. Every warn goes through here.
    const warn = (message) => baseWarn(botToken !== '' ? String(message).split(botToken).join('***') : String(message))

    if (config.enabled !== true) {
      warn('disabled by config (enabled=false); no listeners registered')
      return
    }
    if (botToken === '' || chatId === '') {
      warn('inert: telegram.botToken/chatId not configured; no listeners registered')
      return
    }

    // Plugin lifetime: once disposed, no new sends, no retries, and all
    // pending announce timers are cancelled (in-flight HTTP may still drain).
    let disposed = false
    const sendText = createTelegramSender({ botToken, chatId, fetchImpl, warn, shouldAbort: () => disposed })
    const ping = (text) => {
      if (disposed) return
      void Promise.resolve(sendText(text)).catch(() => {})
    }
    const dedup = createDedup(512, 24 * 60 * 60 * 1000, now)
    const titles = createTitleTracker(256)
    const pendingTurnEnd = new Map()

    const armed = Object.entries(config.events).filter(([, on]) => on === true).map(([key]) => key).join('/')
    warn(`armed: ${armed} → telegram chat ${maskTail(chatId)}`)

    const dispose = (() => {
      const disposers = []

      // 1) session/event — approval pings (instant) + completed-turn pings (debounced).
      disposers.push(ctx.on('session/event', (...args) => {
        try {
          const normalized = normalizeSessionEventArgs(args)
          if (normalized === undefined) return
          const { session, event } = normalized
          if (event.type === 'session/title') {
            // Titles ride the same stream (session/title, data.title) — tracked
            // passively for labeling; no ping. Cold start: sessions titled before
            // this plugin loaded keep the #<short id> fallback until re-titled.
            titles.remember(String(session?.id ?? ''), excerpt(isRecord(event.data) ? event.data.title : '', 60))
            return
          }
          if (event.type === 'approval/asked' && config.events.approval) {
            const key = `${session?.id ?? '(anon)'}:approval:${event.seq ?? ''}`
            if (!dedup(key)) return
            const data = isRecord(event.data) ? event.data : {}
            const tool = excerpt(data.toolName ?? '', config.excerptChars)
            const reason = excerpt(data.reason ?? '', config.excerptChars)
            const body = [tool !== '' ? tool : 'a tool call', reason !== '' ? `— ${reason}` : '']
              .filter((part) => part !== '').join(' ')
            ping(`⚠️ Approval requested: ${body}`)
            return
          }
          if (event.type === 'turn/end' && config.events.turnEnd) {
            const info = turnEndInfo(event.data)
            if (!info.completed) return
            // DSH: header.origin === 'subagent' classifies subagent children;
            // header.parentSession is ordinary fork lineage and must NOT
            // suppress pings (verified against dsh-user-approval/dsh-session
            // 0.1.7-rc.1 types).
            if (session?.header?.origin === 'subagent') return
            const id = String(session?.id ?? '(anon)')
            // Novelty is decided HERE, before touching any pending timer: a
            // duplicate replay of an old seq must not cancel a newer pending
            // announce (the old code replaced the timer, then the replay's
            // callback deduped itself away — swallowing the newer turn).
            const key = `${id}:turn-end:${event.seq ?? info.turn}`
            if (!dedup(key)) return
            const turnText = info.turn > 0 ? ` (turn ${info.turn})` : ''
            const announce = () => {
              pendingTurnEnd.delete(id)
              try {
                ping(`✅ Done: ${sessionLabel(session, titles.of(id))}${turnText}`)
              } catch (error) {
                // Timer callbacks run outside the listener's try/catch —
                // contain them here: a notification must never break the host.
                warn(`turn/end announce error (ignored): ${error instanceof Error ? error.message : String(error)}`)
              }
            }
            const existing = pendingTurnEnd.get(id)
            if (existing !== undefined) cancelTimeout(existing)
            pendingTurnEnd.set(id, schedule(announce, config.debounceMs))
          }
        } catch (error) {
          warn(`session/event listener error (ignored): ${error instanceof Error ? error.message : String(error)}`)
        }
      }))

      // 2) user-questions/request — pass-through observer. ALWAYS return next():
      //    the waterfall result (including downstream rejections such as
      //    NO_PROVIDER) must propagate to the host untouched.
      disposers.push(ctx.on('user-questions/request', (request, next) => {
        try {
          if (config.events.question) {
            const questions = Array.isArray(request?.questions) ? request.questions : []
            const first = excerpt(questions[0]?.question ?? '', config.excerptChars)
            const more = questions.length > 1 ? ` (+${questions.length - 1} more)` : ''
            ping(`❓ Question asked: ${first === '' ? '(no text)' : first}${more}`)
          }
        } catch (error) {
          warn(`question observer error (ignored): ${error instanceof Error ? error.message : String(error)}`)
        }
        return next()
      }, { prepend: true, global: true }))

      // 3) agent/error — opt-in only.
      if (config.events.agentError) {
        disposers.push(ctx.on('agent/error', (...args) => {
          try {
            const payload = isRecord(args[0]) ? args[0] : {}
            const error = payload.error
            const message = excerpt(
              error instanceof Error ? error.message
                : typeof error === 'string' ? error
                  : payload.message,
              config.excerptChars,
            )
            ping(`❗ Agent error: ${message === '' ? '(no detail)' : message}`)
          } catch { /* never fatal */ }
        }))
      }

      return () => {
        disposed = true
        for (const disposeOne of disposers) {
          try { disposeOne() } catch { /* disposal must never throw */ }
        }
        for (const timer of pendingTurnEnd.values()) cancelTimeout(timer)
        pendingTurnEnd.clear()
      }
    })()

    if (typeof ctx?.effect === 'function') ctx.effect(() => dispose, 'dsh-ping: event listeners')
  }
}

export function apply(ctx, config = {}) {
  createPingPlugin()(ctx, config)
}
