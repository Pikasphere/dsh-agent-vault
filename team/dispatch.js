/**
 * Team dispatch: wake a member for a queued attempt, relay a member's report to
 * the lead.
 *
 * P1 of docs/agent-teams.md. The queue is derived from team state — a task that
 * is `assigned` with a queued attempt is a pending dispatch, a report without
 * `relayedAt` is a pending relay — so a restart re-runs whatever was not done.
 * Delivery is at-least-once: the message id is deterministic per attempt (or
 * report), and an already-delivered id is skipped when the host exposes inbox
 * or history. When the host has no usable inbox API, the attempt stays queued
 * and the member keeps the manual `team_task_claim` path.
 *
 * @module team/dispatch
 */

const SOURCE = { kind: 'dsh-agent-vault', form: 'relay' }
const RETRY_MS = 2000
const SKIP_MS = 60_000
const MAX_BACKOFF_MS = 60_000
/** A single wake or relay must not hold the queue forever: a hanging host
 *  service keeps `running` set, and every later kick only flips `again`. */
const STEP_TIMEOUT_MS = 30_000

/** Reject `promise` after `ms`, so one stuck step cannot stall the drain loop. */
export function withTimeout(promise, ms, what) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

function message(id, text) {
  return deepFreeze(structuredClone({
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: SOURCE,
  }))
}

function dispatchText(row) {
  return [
    `[Team task] ${row.title}`,
    `project: ${row.project}  task: ${row.task}  attempt: ${row.attempt}  lead: ${row.lead}`,
    '',
    row.brief,
    '',
    `Work on it, then report with team_task_report (project=${row.project}, task=${row.task}). ` +
    'Use state=ready when done, waiting when you need input, blocked/failed when you cannot finish, dropped when the task should not be done. ' +
    'Keep the summary short and name the files you produced.',
  ].join('\n')
}

/** Prefix for an attempt the host stopped in the middle of and requeued. */
const RECOVERY_NOTE = '[Recovery] The host stopped mid-attempt. Before you continue, inspect what you already did ' +
  '(files, git history, outside effects) and do not repeat it; then finish the task under the same mandate.'

function wakeText(row) {
  return row.recovered === true ? `${RECOVERY_NOTE}\n\n${dispatchText(row)}` : dispatchText(row)
}

function relayText(row) {
  const report = row.report
  const lines = [
    `[Team report] ${row.member} reported ${report.state} on "${row.title}" (${row.task}).`,
    report.summary,
  ]
  if (report.question !== undefined && report.question !== '') lines.push(`Question: ${report.question}`)
  if (Array.isArray(report.files) && report.files.length > 0) lines.push(`Files: ${report.files.join(', ')}`)
  if (Array.isArray(report.knowledge) && report.knowledge.length > 0) lines.push(`Knowledge: ${report.knowledge.join(', ')}`)
  lines.push(`Close or reassign it with team_task_close / team_task_assign (project=${row.project}).`)
  return lines.join('\n')
}

/**
 * @param {object} options
 * @param {object} options.ctx - Cordis context (sessions, agents, persistence).
 * @param {object} options.store - The vault store (session ↔ agent bindings).
 * @param {object} options.team - The team store.
 * @param {function(string): void} [options.log] - Diagnostic sink.
 */
export function createTeamDispatch(options = {}) {
  const { ctx, store, team } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  const retryAt = new Map()
  const failures = new Map()

  let timer
  let running
  let again = false
  let started = false

  function service(name) {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  function backoff(key) {
    const count = (failures.get(key) ?? 0) + 1
    failures.set(key, count)
    return Math.min(RETRY_MS * 2 ** (count - 1), MAX_BACKOFF_MS)
  }

  function later(key) {
    retryAt.set(key, Date.now() + backoff(key))
  }

  function boundSessionOf(agentId) {
    let sessionId = ''
    try {
      for (const row of store.listBindings()) {
        if (row.agentId === agentId) sessionId = row.sessionId
      }
    } catch {
      return ''
    }
    return sessionId
  }

  async function resolveAgent(sessionId) {
    const controller = service('sessionController')
    if (!controller || typeof controller.resolveAgent !== 'function') return undefined
    try {
      const result = await controller.resolveAgent(sessionId)
      return result && typeof result === 'object' && !('error' in result) ? result.agent : undefined
    } catch {
      return undefined
    }
  }

  /** The member's bound session, or a fresh session bound to it. */
  async function ensureSession(agentId) {
    const existing = boundSessionOf(agentId)
    if (existing !== '') {
      const agent = await resolveAgent(existing)
      if (agent) return { agent, sessionId: existing }
    }
    const controller = service('sessionController')
    if (!controller || typeof controller.create !== 'function') return undefined
    try {
      const created = await controller.create({})
      const sessionId = String(created?.sessionId ?? '')
      if (sessionId === '') return undefined
      store.setBinding({ sessionId, agentId })
      const agent = await resolveAgent(sessionId)
      return agent ? { agent, sessionId } : undefined
    } catch (error) {
      log(`could not create a session for ${agentId}: ${String(error?.message ?? error)}`)
      return undefined
    }
  }

  function inboxHolds(agent, id) {
    const inbox = agent?.inbox
    if (inbox === undefined || inbox === null) return false
    for (const list of [inbox.nextTurn, inbox.nextStep]) {
      if (Array.isArray(list) && list.some(item => item?.id === id)) return true
    }
    return false
  }

  /** Whether the session history already carries the message, so a retry does not deliver twice. */
  async function historyHolds(sessionId, id) {
    const persistence = service('sessionPersistence')
    if (!persistence || typeof persistence.open !== 'function') return false
    try {
      if (typeof persistence.flush === 'function') await persistence.flush()
      const handle = await persistence.open(sessionId, 'read')
      try {
        for (let offset = 0; ;) {
          const read = await handle.read(offset, 256)
          const events = Array.isArray(read?.events) ? read.events : []
          if (events.length === 0) break
          for (const event of events) {
            if (event?.type === 'user/message' && event.data?.id === id) return true
          }
          offset += events.length
        }
      } finally {
        if (typeof handle?.close === 'function') await handle.close()
      }
    } catch {
      return false
    }
    return false
  }

  async function flush() {
    const persistence = service('sessionPersistence')
    if (persistence && typeof persistence.flush === 'function') await persistence.flush()
  }

  async function wake(row) {
    const target = await ensureSession(row.member)
    if (!target) return { skipped: `no session for ${row.member}` }
    if (typeof target.agent.followup !== 'function') return { skipped: 'the host has no agent inbox API' }
    const id = `vault-team:dispatch:${row.attempt}`
    if (!inboxHolds(target.agent, id) && !(await historyHolds(target.sessionId, id))) {
      target.agent.followup(message(id, wakeText(row)))
      await flush()
    }
    await team.claimTask({ project: row.project, task: row.task, agent: row.member, sessionId: target.sessionId })
    return { delivered: true }
  }

  /**
   * Deliver one message to an agent's bound session, creating and binding a
   * session when the agent has none. The deterministic id makes a repeated
   * delivery a no-op. Used by the discussion-room mention dispatch.
   */
  async function deliver(agentId, delivery) {
    const target = await ensureSession(agentId)
    if (!target) return { skipped: `no session for ${agentId}` }
    if (typeof target.agent.followup !== 'function') return { skipped: 'the host has no agent inbox API' }
    const id = String(delivery?.id ?? '')
    const text = String(delivery?.text ?? '')
    if (id === '' || text === '') return { skipped: 'delivery needs an id and text' }
    if (!inboxHolds(target.agent, id) && !(await historyHolds(target.sessionId, id))) {
      target.agent.followup(message(id, text))
      await flush()
    }
    return { delivered: true, sessionId: target.sessionId }
  }

  async function relay(row) {
    const target = await ensureSession(row.lead)
    if (!target) return { skipped: `no session for lead ${row.lead}` }
    if (typeof target.agent.followup !== 'function') return { skipped: 'the host has no agent inbox API' }
    const id = `vault-team:relay:${row.attempt}:${row.report?.at ?? ''}`
    if (!inboxHolds(target.agent, id) && !(await historyHolds(target.sessionId, id))) {
      target.agent.followup(message(id, relayText(row)))
      await flush()
    }
    await team.markRelayed({ project: row.project, task: row.task, attempt: row.attempt, target: row.lead })
    return { delivered: true }
  }

  function pending() {
    try {
      return team.pendingDispatches().length + team.pendingRelays().length
    } catch {
      return 0
    }
  }

  function schedule(delay) {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      drain().catch(error => log(`team dispatch failed: ${String(error?.message ?? error)}`))
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function drain() {
    if (running !== undefined) {
      again = true
      return running
    }
    running = (async () => {
      // Yield once before doing any work: a drain with nothing pending would
      // otherwise run to completion synchronously, its `finally` would clear
      // `running`, and the assignment below would then publish an already
      // resolved promise — every later kick would see "already running" and
      // silently drop the queue.
      await Promise.resolve()
      try {
        for (let round = 0; round < 100; round += 1) {
          const dispatches = team.pendingDispatches()
          const relays = team.pendingRelays()
          if (dispatches.length === 0 && relays.length === 0) break
          let progressed = false
          const now = Date.now()
          for (const row of dispatches) {
            const key = `d:${row.attempt}`
            if ((retryAt.get(key) ?? 0) > now) continue
            // Capacity is a concurrency limit, not a rejection: a task over the
            // limit stays assigned with a queued attempt until a slot frees.
            // No retryAt here — the row is simply not ready in this round, and
            // the queue schedules another pass when nothing progressed.
            if (typeof team.slots === 'function') {
              const slots = team.slots(row.project)
              if (slots.running >= slots.capacity) continue
            }
            try {
              const result = await withTimeout(wake(row), STEP_TIMEOUT_MS, 'dispatch wake')
              if (result?.delivered) {
                retryAt.delete(key)
                failures.delete(key)
                progressed = true
              } else {
                retryAt.set(key, now + SKIP_MS)
                log(`team dispatch skipped ${row.attempt}: ${result?.skipped ?? 'unknown'}`)
              }
            } catch (error) {
              later(key)
              log(`team dispatch failed ${row.attempt}: ${String(error?.message ?? error)}`)
            }
          }
          for (const row of relays) {
            const key = `r:${row.attempt}:${row.report?.at ?? ''}`
            if ((retryAt.get(key) ?? 0) > now) continue
            try {
              const result = await withTimeout(relay(row), STEP_TIMEOUT_MS, 'report relay')
              if (result?.delivered) {
                retryAt.delete(key)
                failures.delete(key)
                progressed = true
              } else {
                retryAt.set(key, now + SKIP_MS)
                log(`team relay skipped ${row.attempt}: ${result?.skipped ?? 'unknown'}`)
              }
            } catch (error) {
              later(key)
              log(`team relay failed ${row.attempt}: ${String(error?.message ?? error)}`)
            }
          }
          if (!progressed) break
        }
      } finally {
        running = undefined
      }
      if (again) {
        again = false
        schedule(0)
      } else if (pending() > 0) {
        schedule(RETRY_MS)
      }
    })()
    return running
  }

  /** Run the queue soon; safe to call after any mutation that creates work. */
  function kick() {
    if (running !== undefined) {
      again = true
      return
    }
    schedule(0)
  }

  function start() {
    if (started) return
    started = true
    // One catch-up pass after the host settles; it found the pending work if the
    // plugin stopped between a save and its delivery.
    schedule(1000)
  }

  return { start, kick, drain, pending, deliver }
}
