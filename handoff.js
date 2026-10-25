/**
 * Handoff: watch context pressure and turn a long session into a checkpoint.
 *
 * The checkpoint is not a workspace file — it becomes a journal entry of kind
 * `checkpoint`, so it belongs to the agent's private record and is found again
 * with `agent_journal`. A markdown copy is written only when the user sets an
 * export directory.
 *
 * This module owns configuration, per-session stage, and text generation. It
 * never touches the model, the session log, or the journal store directly.
 *
 * @module handoff
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryError } from './store.js'

export const DEFAULT_TRIGGER_TOKENS = 300000
export const DEFAULT_REMIND_EVERY = 2
/** How long a "next session inherits this agent" intent stays valid. */
export const DEFAULT_NEXT_TTL_MS = 30 * 60 * 1000
/**
 * The first message the automatic switch sends into the fresh conversation.
 * The context was just reset, so it points the model at the durable record it
 * already has instead of asking the user to explain the situation again.
 */
export const DEFAULT_STARTUP_PROMPT =
  '这是交接后的新会话（上下文已重置）。先读你最近的日志和交棒检查点（agent_journal），再搜共享知识库里的相关经验，确认上次的进度后继续完成工作；结束前更新记忆和日志。'
const MIN_TOKENS = 20000
const MAX_TOKENS = 2000000
const MAX_STARTUP_PROMPT_CHARS = 2000

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text, 'utf8')
  fs.renameSync(temp, file)
}

function clampTokens(value, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(Math.max(Math.round(number), MIN_TOKENS), MAX_TOKENS)
}

function clampStartupPrompt(value) {
  return String(value ?? '').slice(0, MAX_STARTUP_PROMPT_CHARS)
}

function shortSession(sessionId) {
  return String(sessionId ?? '').replace(/^session-/, '').slice(0, 8)
}

export function createHandoff(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const files = {
    config: path.join(root, 'handoff.json'),
    states: path.join(root, 'handoff-state.json'),
  }

  function config() {
    const raw = readJson(files.config, {})
    return {
      version: 1,
      enabled: raw.enabled !== false,
      triggerTokens: clampTokens(raw.triggerTokens, DEFAULT_TRIGGER_TOKENS),
      remindEverySteps: Math.min(Math.max(Math.round(Number(raw.remindEverySteps) || DEFAULT_REMIND_EVERY), 1), 20),
      exportDir: typeof raw.exportDir === 'string' ? raw.exportDir.trim() : '',
      autoSwitch: raw.autoSwitch === true,
      startupPrompt:
        typeof raw.startupPrompt === 'string' ? clampStartupPrompt(raw.startupPrompt) : DEFAULT_STARTUP_PROMPT,
    }
  }

  function saveConfig(patch = {}) {
    const current = config()
    const next = { ...current }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
    if (typeof patch.triggerTokens !== 'undefined') next.triggerTokens = clampTokens(patch.triggerTokens, current.triggerTokens)
    if (typeof patch.remindEverySteps !== 'undefined') {
      next.remindEverySteps = Math.min(Math.max(Math.round(Number(patch.remindEverySteps) || current.remindEverySteps), 1), 20)
    }
    if (typeof patch.exportDir === 'string') next.exportDir = patch.exportDir.trim()
    if (typeof patch.autoSwitch === 'boolean') next.autoSwitch = patch.autoSwitch
    if (typeof patch.startupPrompt === 'string') next.startupPrompt = clampStartupPrompt(patch.startupPrompt).trim()
    writeAtomic(files.config, `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  function allStates() {
    const raw = readJson(files.states, {})
    return raw && typeof raw.sessions === 'object' && raw.sessions !== null ? raw.sessions : {}
  }

  function saveStates(sessions) {
    writeAtomic(files.states, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`)
  }

  function stateOf(sessionId) {
    return allStates()[String(sessionId ?? '')] ?? null
  }

  function patchState(sessionId, patch) {
    const key = String(sessionId ?? '')
    if (key === '') return null
    const sessions = allStates()
    sessions[key] = { ...(sessions[key] ?? {}), ...patch }
    saveStates(sessions)
    return sessions[key]
  }

  function clearState(sessionId) {
    const key = String(sessionId ?? '')
    const sessions = allStates()
    if (sessions[key] === undefined) return
    delete sessions[key]
    saveStates(sessions)
  }

  /**
   * Record the intent "the next fresh session inherits this agent". The intent
   * is consumed once by `takeNext`, carries the source directory when known so
   * an unrelated workspace is not captured, and expires on its own.
   */
  function armNext(sessionId, intent = {}) {
    const key = String(sessionId ?? '')
    if (key === '') return null
    const next = { ...intent, at: now().toISOString() }
    patchState(key, { next })
    return next
  }

  /** Consume the first live intent that matches `cwd` (or has no cwd). */
  function takeNext(options = {}) {
    const ttl = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : DEFAULT_NEXT_TTL_MS
    const cutoff = now().getTime() - ttl
    const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined
    const skip = String(options.excludeSessionId ?? '')
    const sessions = allStates()
    let found = null
    let dirty = false
    for (const [sessionId, state] of Object.entries(sessions)) {
      const next = state?.next
      if (!next || sessionId === skip) continue
      const at = Date.parse(next.at)
      if (!Number.isFinite(at) || at < cutoff) {
        delete state.next
        dirty = true
        continue
      }
      if (cwd !== undefined && next.cwd !== undefined && next.cwd !== cwd) continue
      if (found === null) found = { sessionId, next }
    }
    if (found === null) {
      if (dirty) saveStates(sessions)
      return null
    }
    delete sessions[found.sessionId].next
    saveStates(sessions)
    return { sessionId: found.sessionId, ...found.next }
  }

  function nextOf(sessionId) {
    return stateOf(sessionId)?.next ?? null
  }

  /**
   * Decide this step's stage from pressure plus what the agent has recorded
   * since the request. `requested` means "remind the model"; `ready` means both
   * a memory and a journal entry landed after the request.
   */
  function evaluate(input = {}) {
    const sessionId = String(input.sessionId ?? '')
    const tokens = Number.isFinite(Number(input.tokens)) ? Number(input.tokens) : 0
    const current = config()
    if (!current.enabled) return { stage: 'off', remind: false, tokens, threshold: current.triggerTokens }
    if (sessionId === '') return { stage: 'off', remind: false, tokens, threshold: current.triggerTokens }

    const state = stateOf(sessionId)
    const threshold = current.triggerTokens
    if (state?.settledAt !== undefined) return { stage: 'settled', remind: false, tokens, threshold, state }
    if (tokens < threshold) {
      if (state?.requestedAt !== undefined && tokens < Math.floor(threshold * 0.9)) clearState(sessionId)
      return { stage: 'watching', remind: false, tokens, threshold, state: state ?? null }
    }
    if (state?.requestedAt === undefined) {
      const requestedAt = now().toISOString()
      patchState(sessionId, { requestedAt, lastTokens: tokens, ticks: 0 })
      return { stage: 'requested', remind: true, tokens, threshold, requestedAt }
    }
    const requestedTime = Date.parse(state.requestedAt)
    const memoryDone = typeof input.memoryAt === 'string' && input.memoryAt !== '' && Date.parse(input.memoryAt) >= requestedTime
    const journalDone = typeof input.journalAt === 'string' && input.journalAt !== '' && Date.parse(input.journalAt) >= requestedTime
    if (memoryDone && journalDone) {
      return { stage: 'ready', remind: false, tokens, threshold, requestedAt: state.requestedAt, state }
    }
    // Repeat the reminder only every `remindEverySteps` steps: the first request
    // already fired, so ticking before the modulo keeps the cadence honest.
    const ticks = Number(state.ticks ?? 0) + 1
    const every = Math.max(1, Number(current.remindEverySteps) || 1)
    patchState(sessionId, { lastTokens: tokens, ticks })
    return {
      stage: 'requested',
      remind: ticks % every === 0,
      ticks,
      tokens,
      threshold,
      requestedAt: state.requestedAt,
      state,
    }
  }

  function buildCheckpointText(input = {}) {
    const at = now().toISOString()
    const lines = [
      '# 交棒检查点',
      '',
      `- 智能体：${input.agentName ?? ''} (${input.agentId ?? ''})`,
      `- 时间：${at}`,
      `- 会话：${input.sessionId ?? ''}`,
      `- 上下文压力：${Number(input.tokens ?? 0).toLocaleString('en-US')} tokens（阈值 ${Number(input.threshold ?? 0).toLocaleString('en-US')}）`,
      '',
      '## 记忆',
      '',
      String(input.memory ?? '').trim() || '(空)',
      '',
      '## 最近的日志',
      '',
    ]
    const entries = Array.isArray(input.entries) ? input.entries.slice(0, 5) : []
    if (entries.length === 0) lines.push('(无)')
    else for (const entry of entries) lines.push(`- ${entry.at ?? ''} · ${entry.title ?? entry.id} (${entry.id})`)
    return lines.join('\n')
  }

  /** Optional markdown copy; an empty export dir means "journal only". */
  function exportCheckpoint(input = {}) {
    const current = config()
    if (current.exportDir === '') return ''
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    const file = path.join(current.exportDir, `checkpoint-${shortSession(input.sessionId)}-${stamp}.md`)
    try {
      writeAtomic(file, String(input.text ?? ''))
      return file
    } catch (error) {
      throw new MemoryError('export-failed', `could not write ${file}: ${String(error?.message ?? error)}`)
    }
  }

  return {
    root,
    files,
    config,
    saveConfig,
    stateOf,
    patchState,
    clearState,
    armNext,
    takeNext,
    nextOf,
    evaluate,
    buildCheckpointText,
    exportCheckpoint,
  }
}
