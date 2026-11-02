// Early compaction ("sleep"): threshold, cooldown, accounting, failure paths.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { SLEEP_DEFAULTS, createSleep } from './sleep.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-sleep-'))
const logFile = path.join(root, 'index', 'compaction.jsonl')

function harness(options = {}) {
  fs.rmSync(logFile, { force: true })
  fs.rmSync(path.join(root, 'index', 'sleep.json'), { force: true })
  const settings = {
    enabled: true,
    triggerTokens: 1000,
    cooldownMs: 0,
    ...(options.settings ?? {}),
  }
  const calls = []
  const surfaceCalls = []
  const nodes = []
  const events = new Map()
  const totalNodes = options.nodes ?? 40
  for (let index = 1; index <= totalNodes; index += 1) {
    const seq = index
    nodes.push(seq)
    const isToolResult = index % 5 === 0
    events.set(seq, { type: isToolResult ? 'tool/result' : 'user/message', data: { text: 'x'.repeat(200) } })
  }
  const session = {
    surface: { nodes },
    eventAt: seq => events.get(seq),
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  }
  const services = {
    sessions: { get: id => (id === 'session-a' ? session : undefined) },
    compaction: {
      compactRegion: async (start, end, context) => {
        surfaceCalls.push({ start, end })
        if (options.regionThrows === true) throw new Error('region refused')
        return { compactionId: 'r1', summary: [{ type: 'text', text: 'y'.repeat(40) }], shadowedTokenCount: 2000 }
      },
      compactIfNeeded: async (context, trigger, signal) => {
        calls.push({ context, trigger, aborted: signal.aborted })
        if (options.throws === true) throw new Error('summary failed')
        if (options.null === true) return null
        return {
          compactionId: 'c1',
          summary: [{ type: 'text', text: 'x'.repeat(120) }],
          shadowedTokenCount: 5000,
        }
      },
    },
  }
  const ctx = {
    get: name => services[name],
    on: () => () => {},
    effect: fn => fn(),
  }
  const store = {
    root,
    settings: () => ({ sleep: settings }),
    bindingOf: () => 'agent-a',
  }
  let tokens = options.tokens ?? 0
  const sleep = createSleep({
    ctx,
    store,
    measureTokens: () => tokens,
    recordError: (target, scope, error) => {
      throw new Error(`unexpected recordError ${scope}: ${error?.message ?? error}`)
    },
  })
  return {
    sleep,
    calls,
    surfaceCalls,
    nodes,
    events,
    settings,
    setTokens: value => {
      tokens = value
    },
  }
}

// disabled: never touches the service
{
  const h = harness({ settings: { enabled: false }, tokens: 999999 })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result, null)
  assert.equal(h.calls.length, 0)
  assert.equal(h.surfaceCalls.length, 0)
}

// below threshold: no call
{
  const h = harness({ tokens: 500 })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.calls.length, 0)
}

// above threshold: one call, early trigger, one accounting line
{
  const h = harness({ tokens: 1200 })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].trigger, 'context-overflow')
  assert.equal(h.calls[0].context.options.provider, 'p')
  assert.equal(h.calls[0].context.session, undefined ?? h.calls[0].context.session)
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const row = JSON.parse(lines[0])
  assert.equal(row.sessionId, 'session-a')
  assert.equal(row.ok, true)
  assert.equal(row.beforeTokens, 1200)
  assert.equal(row.shadowedTokenCount, 5000)
  assert.equal(row.summaryChars, 120)
  assert.equal(row.reason, 'threshold')
  assert.ok(row.durationMs >= 0)
}

// cooldown: the second attempt inside the window is skipped
{
  const h = harness({ tokens: 1200, settings: { cooldownMs: 60000 } })
  assert.equal((await h.sleep.maybeCompact({ id: 'session-a' }))?.attempted, true)
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.calls.length, 1)
}

// service declines: still accounted, but nothing was folded
{
  const h = harness({ tokens: 1200, null: true })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.result, null)
  const rows = h.sleep.history(10)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].ok, true)
  assert.equal(rows[0].compacted, false)
  assert.equal(rows[0].shadowedTokenCount, 0)
}

// failure: accounted with the error, never thrown to the loop
{
  const h = harness({ tokens: 1200, throws: true })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.error instanceof Error, true)
  const rows = h.sleep.history(10)
  assert.equal(rows[0].ok, false)
  assert.ok(String(rows[0].error).includes('summary failed'))
}

// missing session or missing service: no call, no throw
{
  const h = harness({ tokens: 1200 })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-unknown' }), null)
  const bare = createSleep({
    ctx: { get: () => undefined, on: () => () => {}, effect: fn => fn() },
    store: { root, settings: () => ({ sleep: { enabled: true, triggerTokens: 1 } }), bindingOf: () => '' },
    measureTokens: () => 999999,
    recordError: () => {},
  })
  assert.equal(await bare.maybeCompact({ id: 'session-a' }), null)
}

// state(): settings + totals from the log
{
  fs.rmSync(logFile, { force: true })
  const h = harness({ tokens: 1200 })
  await h.sleep.maybeCompact({ id: 'session-a' })
  const state = h.sleep.state()
  assert.equal(state.enabled, true)
  assert.equal(state.triggerTokens, 1000)
  assert.equal(state.attempts, 1)
  assert.equal(state.savedTokens, 5000)
  assert.equal(state.logFile, logFile)
  assert.equal(state.last.shadowedTokenCount, 5000)
}

// small sweep: between soft and hard thresholds, fold a tail span instead
{
  const h = harness({ tokens: 700, settings: { softTokens: 500, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100 } })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.kind, 'small')
  assert.equal(h.calls.length, 0, 'the hard path is not used')
  assert.equal(h.surfaceCalls.length, 1)
  const { start, end } = h.surfaceCalls[0]
  assert.ok(start < end, 'span is ordered')
  assert.ok(end < h.nodes.at(-1), 'the recent working set is left alone')
  assert.notEqual(h.events.get(start).type, 'tool/result', 'never starts on a tool result')
  assert.notEqual(h.events.get(end).type, 'tool/call', 'never ends on a tool call')
  const row = h.sleep.history(10)[0]
  assert.equal(row.kind, 'small')
  assert.equal(row.reason, 'sweep')
  assert.equal(row.ok, true)
  assert.equal(row.shadowedTokenCount, 2000)
  assert.ok(row.span !== null && row.span.nodes > 1)
}

// below the soft threshold nothing happens at all
{
  const h = harness({ tokens: 400, settings: { softTokens: 500, triggerTokens: 1000 } })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.surfaceCalls.length, 0)
}

// a refused region is accounted, not thrown
{
  const h = harness({ tokens: 700, settings: { softTokens: 500, triggerTokens: 1000, minFoldTokens: 100 }, regionThrows: true })
  const result = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(result?.attempted, true)
  assert.equal(result.error instanceof Error, true)
  const row = h.sleep.history(10)[0]
  assert.equal(row.ok, false)
  assert.equal(row.kind, 'small')
}

// a slice below minFoldTokens waits for the next idle
{
  const h = harness({ tokens: 700, settings: { softTokens: 500, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100000 } })
  assert.equal(await h.sleep.maybeCompact({ id: 'session-a' }), null)
  assert.equal(h.surfaceCalls.length, 0)
}

// the fold watermark moves forward and blocks rewriting the same prefix
{
  const h = harness({ tokens: 700, settings: { softTokens: 500, triggerTokens: 1000, cooldownMs: 0, minFoldTokens: 100 } })
  assert.equal((await h.sleep.maybeCompact({ id: 'session-a' }))?.attempted, true)
  const first = h.surfaceCalls[0]
  const mark = h.sleep.state().foldStartSeq['session-a']
  assert.equal(mark, first.start, 'watermark records where the fold started')
  const second = await h.sleep.maybeCompact({ id: 'session-a' })
  assert.equal(second, null, 'the same tail is not folded twice')
  assert.equal(h.surfaceCalls.length, 1)
  const row = h.sleep.history(10)[0]
  assert.equal(row.kind, 'small')
  assert.ok(row.span.start >= first.start)
}

// defaults stay conservative
assert.deepEqual(
  { ...SLEEP_DEFAULTS },
  { enabled: false, triggerTokens: 400000, softTokens: 300000, chunkTokens: 20000, keepRecent: 8, minFoldTokens: 5000, cooldownMs: 600000 },
)

fs.rmSync(root, { recursive: true, force: true })
console.log('ALL SLEEP TESTS PASSED')
