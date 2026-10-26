/**
 * Agent memory and knowledge — Host half.
 *
 * Contributes three things:
 *   1. four model tools: save a short memory, and search / read / write the
 *      detailed knowledge base (the agent decides those reads on its own);
 *   2. one prompt section that tells every agent the knowledge base exists and
 *      carries the *user-selected* memory into the session;
 *   3. one same-origin JSON surface (`/api/agent-memory`) for the manager page,
 *      because the page must work in every Web composition, not only the ones
 *      with a typed Remote binding.
 *
 * The memory itself is read only when the user selects an agent in the page —
 * no tool exposes reading memory, by design.
 *
 * @module index
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore, defaultRoot, MemoryError } from './store.js'
import { createJournals } from './journal.js'
import { createRooms } from './rooms.js'
import { createHandoff, DEFAULT_NEXT_TTL_MS } from './handoff.js'
import { createArchives, ARCHIVE_LEVELS } from './archive.js'

const API_BASE = '/api/agent-memory'
const MAX_BODY_BYTES = 1024 * 1024
const SECTION_NAME = 'agent-memory'
const SECTION_ORDER = 120

export function apply(ctx, config = {}) {
  const store = createStore({
    rootDir: typeof config.memoryDir === 'string' && config.memoryDir.trim() !== '' ? config.memoryDir : defaultRoot(),
    knowledgeDir: typeof config.knowledgeDir === 'string' ? config.knowledgeDir : '',
    memoryLimit: config.memoryLimit,
    entryLimit: config.entryLimit,
    resolveTitle: sessionId => sessionTitleOf(ctx, sessionId),
  })

  const rooms = createRooms({ rootDir: store.root })
  const journals = createJournals({ rootDir: store.root })
  const handoff = createHandoff({ rootDir: store.root })
  const archives = createArchives({ rootDir: store.root })
  const hints = new Map()

  try {
    registerPrompt(ctx, store)
    registerTools(ctx, store, rooms, journals)
    registerHandoff(ctx, store, journals, handoff, archives, hints)
    registerApi(ctx, store, rooms, journals, handoff, archives, hints)
  } catch (error) {
    recordError(store, 'apply', error)
  }
}

/** Never let diagnostics replace the failure they describe. */
function recordError(store, kind, error) {
  try {
    console.error(`[agent-memory] ${kind}: ${String(error?.stack ?? error?.message ?? error)}`)
  } catch {
    /* no console in some hosts */
  }
  try {
    const text = `${new Date().toISOString()} [${kind}] ${String(error?.stack ?? error?.message ?? error)}\n`
    fs.appendFileSync(path.join(store.root, 'plugin-error.log'), text, 'utf8')
  } catch {
    /* best effort */
  }
}

/**
 * The user-facing title of one conversation, for a binding list where a raw
 * session id means nothing. A live session answers through `sessionTitle`;
 * a closed one still has its folded title in the projection cache.
 */
function sessionTitleOf(ctx, sessionId) {
  const key = String(sessionId ?? '')
  if (key === '') return ''
  try {
    const sessions = ctx.get('sessions')
    const titles = ctx.get('sessionTitle')
    const session = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(key) : undefined
    if (session !== undefined && titles !== undefined && typeof titles.get === 'function') {
      const snapshot = titles.get(session)
      if (snapshot !== undefined && typeof snapshot.title === 'string' && snapshot.title !== '') return snapshot.title
    }
  } catch {
    /* fall through to the cache */
  }
  try {
    const file = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', `${key}.json`)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const value = data?.record?.rows?.title?.val
    if (typeof value === 'string') return value
    if (value !== null && typeof value === 'object' && typeof value.title === 'string') return value.title
  } catch {
    /* unknown or never-persisted conversation */
  }
  return ''
}

// ── prompt ───────────────────────────────────────────────────────────────────

function buildPrompt(store, sessionId) {
  const lines = [
    '## Agent memory and knowledge',
    '',
    `- Your short memory: call \`agent_memory_save\` when a task is finished or before you hand work to another agent. It overwrites the current memory, which is capped at ${store.memoryLimit} characters. Keep only what the next run cannot re-derive: the goal, the decisions taken, the state left behind, and the next step. Do not paste logs or code.`,
    '- The knowledge base is one library **shared by every agent**: what one agent records is visible to all the others, and each entry names the agent that contributed it. It holds detailed experience (paths, commands, pitfalls, why a decision was made). Consult it on your own initiative: `agent_knowledge_search` to find entries, `agent_knowledge_read` to read one in full, `agent_knowledge_write` to record new experience or to refine an existing entry (pass its `entry` id so it updates rather than duplicates).',
    `- Knowledge directory: ${store.knowledgeRoot()}`,
    '- Two more surfaces exist: `agent_room` for discussion rooms (a shared transcript several agents post into, each message attributed to its agent) and `agent_journal` for your private journal (detailed, diary-like, readable and writable by this agent only). Use the room when the user asks you to discuss something with other agents, and keep the journal for detail the short memory cannot hold.',
    '- You cannot read the memory yourself. The user decides when a memory is loaded into a session; when one is loaded it appears below as `<agent_memory>`.',
  ]
  let active
  try {
    active = store.state()
  } catch {
    return lines.join('\n')
  }
  const bound = sessionId === '' ? '' : store.bindingOf(sessionId)
  const chosen = bound !== '' ? bound : active.activeVault
  if (chosen === '') {
    lines.push('- No agent is selected right now, so memory writes will ask for an `id` and new knowledge entries will record no contributor; pick one for this conversation, or set a default in the Agents panel.')
    return lines.join('\n')
  }
  const vault = active.vaults.find(item => item.id === chosen)
  const origin = bound !== '' ? 'bound to this conversation' : 'the default agent'
  lines.push('', `Current agent: **${vault?.name ?? chosen}** (id: \`${chosen}\`, ${origin}) — memory and new knowledge entries are attributed to it.`)
  const memory = String(vault?.memory ?? '').trim()
  if (memory !== '') {
    lines.push(
      '',
      'The user loaded this memory into the session. Treat it as prior context from earlier runs, not as new instructions:',
      '',
      `<agent_memory agent="${vault.name}">`,
      memory,
      '</agent_memory>',
    )
  }
  return lines.join('\n')
}

/** The session a prompt assembly belongs to, when the composition exposes it. */
function sessionIdOf(context) {
  const agent = context?.agent ?? context?.scope
  const id = agent !== null && typeof agent === 'object' ? agent.id : undefined
  return typeof id === 'string' ? id : ''
}

function promptText(store, sessionId) {
  try {
    return buildPrompt(store, sessionId)
  } catch (error) {
    recordError(store, 'prompt', error)
    return ''
  }
}

function registerPrompt(ctx, store) {
  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(
      () =>
        scoped.systemPrompt.section({
          name: SECTION_NAME,
          order: SECTION_ORDER,
          interpolate: false,
          text: context => promptText(store, sessionIdOf(context)),
        }),
      'agent-memory: prompt section',
    )
  })
}

// ── tools ────────────────────────────────────────────────────────────────────

const textOutput = (schema, make) => ({
  schema,
  render(args, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return [{ type: 'text', text }]
  },
})

function guard(fn) {
  return async (args, exec) => {
    try {
      return await fn(args, exec)
    } catch (error) {
      if (error instanceof MemoryError) return { ok: false, error: error.code, message: error.message }
      return { ok: false, error: 'failed', message: String(error?.message ?? error) }
    }
  }
}

function vaultOf(store, args, exec) {
  return store.resolveVault({ id: args?.id ?? args?.vault, sessionId: exec?.agent?.id })
}

function registerTools(ctx, store, rooms, journals) {
  ctx.inject(['tools'], scoped => {
    const register = (definition, label) => scoped.effect(() => scoped.tools.register(definition), label)
    const limit = store.memoryLimit
    const entryLimit = store.entryLimit

    register(
      {
        name: 'agent_memory_save',
        description:
          'Write the short, inheritable memory of one agent. Call it once a task is finished or before handing work off. ' +
          `The text replaces the current memory and must stay under ${limit} characters; summarize rather than log. ` +
          'The user loads this memory into a later session; you cannot read it back.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Agent id. Omit to use the agent currently selected by the user.' },
            content: { type: 'string', description: `The memory text, at most ${limit} characters.` },
            note: { type: 'string', description: 'Optional short label for the save (for example "handoff" or "done").' },
          },
          required: ['content'],
        },
        output: textOutput(
          {
            type: 'object',
            properties: { id: { type: 'string' }, chars: { type: 'number' }, updatedAt: { type: 'string' } },
          },
          () => 'saved',
        ),
        execute: guard(async (args, exec) => {
          const agent = vaultOf(store, args, exec)
          const result = store.writeMemory({
            id: agent.id,
            content: args?.content,
            note: args?.note ?? (exec?.agent?.id ? `session ${String(exec.agent.id).slice(-8)}` : ''),
          })
          return { ok: true, ...result, limit: limit }
        }),
      },
      'agent-memory: memory tool',
    )

    register(
      {
        name: 'agent_knowledge_search',
        description:
          'Search the shared knowledge base for detailed experience — every agent reads and writes the same library. ' +
          'Use it before a task that may depend on earlier work. An empty query lists the most recently updated entries.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Space-separated keywords. Empty lists recent entries.' },
            limit: { type: 'number', description: 'Maximum entries to return (1-25, default 8).' },
            id: { type: 'string', description: 'Optional: only entries contributed by this agent id.' },
          },
        },
        output: textOutput({ type: 'object', properties: { entries: { type: 'array', items: { type: 'object' } } } }, () => 'search'),
        execute: guard(async args => {
          if (String(args?.query ?? '').trim() === '') {
            const listed = store.listKnowledge({ id: args?.id })
            const max = Math.min(Math.max(Number(args?.limit) || 8, 1), 25)
            return { ok: true, total: listed.total, entries: listed.entries.slice(0, max), shared: true }
          }
          return { ok: true, ...store.searchKnowledge({ id: args?.id, query: args?.query, limit: args?.limit }) }
        }),
      },
      'agent-memory: knowledge search tool',
    )

    register(
      {
        name: 'agent_knowledge_read',
        description: 'Read one knowledge entry in full from the shared library. Get its id from agent_knowledge_search.',
        parameters: {
          type: 'object',
          properties: {
            entry: { type: 'string', description: 'Knowledge entry id.' },
          },
          required: ['entry'],
        },
        output: textOutput({ type: 'object', properties: { content: { type: 'string' } } }, () => 'entry'),
        execute: guard(async args => ({ ok: true, ...store.readKnowledge({ entry: args?.entry }) })),
      },
      'agent-memory: knowledge read tool',
    )

    register(
      {
        name: 'agent_knowledge_write',
        description:
          'Record or refine one entry in the shared knowledge base: what was tried, what worked, exact paths or commands, and why. ' +
          'Pass `entry` with an id returned by agent_knowledge_search to refine that entry instead of adding a duplicate.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Agent id recorded as the contributor. Omit to use the agent currently selected by the user.' },
            entry: { type: 'string', description: 'Existing entry id to update. Omit to create a new entry.' },
            title: { type: 'string', description: 'Short title; defaults to the first line of the content.' },
            content: { type: 'string', description: `Markdown body, at most ${entryLimit} characters.` },
            tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for later search.' },
          },
          required: ['content'],
        },
        output: textOutput({ type: 'object', properties: { entry: { type: 'string' } } }, () => 'entry'),
        execute: guard(async (args, exec) => {
          const bound = exec?.agent?.id ? store.bindingOf(exec.agent.id) : ''
          const contributor =
            typeof args?.id === 'string' && args.id !== ''
              ? args.id
              : bound !== ''
                ? bound
                : store.settings().activeVault
          return {
            ok: true,
            ...store.saveKnowledge({
              id: contributor,
              entry: args?.entry,
              title: args?.title,
              content: args?.content,
              tags: args?.tags,
              source: exec?.agent?.id ? `session ${String(exec.agent.id).slice(-8)}` : '',
            }),
          }
        }),
      },
      'agent-memory: knowledge write tool',
    )

    registerRoomTools(register, store, rooms)
    registerJournalTools(register, store, journals)
  })
}

// ── discussion rooms + private journal ──────────────────────────────────────

function registerRoomTools(register, store, rooms) {
  const speakerOf = exec => {
    const bound = exec?.agent?.id ? store.bindingOf(exec.agent.id) : ''
    if (bound === '') return undefined
    const name = store.state().vaults.find(item => item.id === bound)?.name ?? bound
    return { kind: 'agent', id: bound, name }
  }
  const requireSpeaker = exec => {
    const speaker = speakerOf(exec)
    if (speaker === undefined) {
      throw new MemoryError('no-agent', 'this conversation has no agent bound; bind one in the New Session row first')
    }
    return speaker
  }

  register(
    {
      name: 'agent_room',
      description:
        'A discussion room is a shared transcript that several agents join. action="list" shows the rooms you can see, ' +
        '"read" returns the recent transcript, "say" posts your message, and "join"/"leave" change your own membership. ' +
        'Anything you say is attributed to the agent bound to this conversation.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'read', 'say', 'join', 'leave'], description: 'What to do.' },
          room: { type: 'string', description: 'Room id, from action="list".' },
          text: { type: 'string', description: 'Message body, for action="say".' },
          limit: { type: 'number', description: 'How many recent messages action="read" returns (1-200, default 30).' },
        },
        required: ['action'],
      },
      output: textOutput({ type: 'object', properties: { rooms: { type: 'array', items: { type: 'object' } } } }),
      execute: guard(async (args, exec) => {
        const action = String(args?.action ?? 'list')
        if (action === 'list') return { ok: true, rooms: rooms.list() }
        const id = args?.room
        if (action === 'read') return { ok: true, ...rooms.read({ id, limit: args?.limit }) }
        if (action === 'say') return { ok: true, message: rooms.say({ id, text: args?.text, from: requireSpeaker(exec) }) }
        if (action === 'join') return { ok: true, room: rooms.join({ id, member: requireSpeaker(exec).id }) }
        if (action === 'leave') return { ok: true, room: rooms.leave({ id, member: requireSpeaker(exec).id }) }
        throw new MemoryError('bad-action', `unknown action: ${action}`)
      }),
    },
    'agent-memory: room tool',
  )
}

function registerJournalTools(register, store, journals) {
  const requireAgent = exec => {
    const bound = exec?.agent?.id ? store.bindingOf(exec.agent.id) : ''
    if (bound === '') {
      throw new MemoryError('no-agent', 'this conversation has no agent bound; bind one in the New Session row first')
    }
    return bound
  }

  register(
    {
      name: 'agent_journal',
      description:
        'Your private journal: the detailed, diary-like record of this one agent. No other agent can read or extend it, and nothing is injected ' +
        'automatically — you decide when to consult it. action="list" shows recent entries, "search" filters them, "read" returns one entry, ' +
        '"write" appends a new one. Use it for detail a short memory cannot hold.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'search', 'read', 'write'], description: 'What to do.' },
          entry: { type: 'string', description: 'Entry id, for action="read".' },
          query: { type: 'string', description: 'Keywords, for action="search".' },
          title: { type: 'string', description: 'Short title, for action="write".' },
          text: { type: 'string', description: 'Entry body, for action="write".' },
          limit: { type: 'number', description: 'How many entries list/search return (1-100, default 20).' },
        },
        required: ['action'],
      },
      output: textOutput({ type: 'object', properties: { entries: { type: 'array', items: { type: 'object' } } } }),
      execute: guard(async (args, exec) => {
        const id = requireAgent(exec)
        const action = String(args?.action ?? 'list')
        if (action === 'list') return { ok: true, ...journals.list({ id, limit: args?.limit }) }
        if (action === 'search') return { ok: true, ...journals.list({ id, query: args?.query, limit: args?.limit }) }
        if (action === 'read') return { ok: true, ...journals.read({ id, entry: args?.entry }) }
        if (action === 'write') return { ok: true, ...journals.write({ id, title: args?.title, text: args?.text }) }
        throw new MemoryError('bad-action', `unknown action: ${action}`)
      }),
    },
    'agent-memory: journal tool',
  )
}

// ── handoff: pressure → checkpoint ──────────────────────────────────────────

function measureTokens(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions')
    const meter = ctx.get('tokenMeter')
    if (sessions === undefined || meter === undefined) return 0
    const session = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (session === undefined) return 0
    const measurement = meter.measure(session)
    return Number(measurement?.totalTokens) || 0
  } catch {
    return 0
  }
}

function handoffHint(tokens, threshold) {
  return [
    `[交接提醒] 当前上下文约 ${tokens.toLocaleString('en-US')} tokens，已到阈值 ${threshold.toLocaleString('en-US')}。`,
    '在这一步先完成两件事，然后继续手上的工作：',
    '1) `agent_memory_save`：写一段不超过 400 字的记忆（下一步做什么、关键决策、遗留问题）',
    '2) `agent_journal` 的 `write`：追加一条详细日志（这次做了什么、为什么、踩了什么坑）',
    '两件都完成后会自动生成一份交棒检查点，本会话仍可继续使用。',
  ].join('\n')
}

function sessionOf(ctx, sessionId) {
  try {
    const sessions = ctx.get('sessions')
    return sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(String(sessionId)) : undefined
  } catch {
    return undefined
  }
}

function sessionCwd(ctx, sessionId) {
  try {
    const session = sessionOf(ctx, sessionId)
    const workingDirectory = ctx.get('workingDirectory')
    if (session === undefined || workingDirectory === undefined) return undefined
    const cwd = typeof workingDirectory.get === 'function' ? workingDirectory.get(session) : undefined
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * The Agent preset a Session actually runs. DSH keeps this in the
 * `agentPreset` projection (a live preset switch appends an event without
 * touching the immutable header), so read the projection first and only fall
 * back to the header on older hosts.
 */
function agentPresetOf(ctx, sessionId) {
  try {
    const session = sessionOf(ctx, sessionId)
    if (session === undefined) return ''
    const projections = ctx.get('sessionProjections')
    if (projections !== undefined && typeof projections.stateOf === 'function') {
      const value = projections.stateOf(session, 'agentPreset')
      if (typeof value === 'string' && value !== '') return value
    }
    const headerPreset = session.header?.agentPreset
    return typeof headerPreset === 'string' ? headerPreset : ''
  } catch {
    return ''
  }
}

function approvalOf(ctx, sessionId) {
  try {
    const session = sessionOf(ctx, sessionId)
    const approval = ctx.get('approval')
    if (session === undefined || approval === undefined || typeof approval.overrideOf !== 'function') return undefined
    const policy = approval.overrideOf(session)
    return policy === 'ask' || policy === 'never' ? policy : undefined
  } catch {
    return undefined
  }
}

/** The model a Session actually runs on: its last request header, else the default. */
function modelOf(ctx, sessionId) {
  try {
    const session = sessionOf(ctx, sessionId)
    const header = session !== undefined && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    const config = header?.config ?? (typeof session?.requestContext === 'function' ? session.requestContext() : undefined)
    if (config !== undefined && config !== null && typeof config.provider === 'string' && typeof config.model === 'string') {
      return {
        provider: config.provider,
        model: config.model,
        ...(typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
      }
    }
    const defaults = ctx.get('agentDefaultModel')
    const selection = defaults !== undefined && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
    if (selection !== undefined && selection !== null && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== ''
          ? { reasoningEffort: selection.reasoningEffort }
          : {}),
      }
    }
  } catch {
    /* fall through */
  }
  return undefined
}

function normalizePath(value) {
  return String(value ?? '')
    .replace(/[\\/]+/g, '\\')
    .replace(/\\$/, '')
    .toLowerCase()
}

function listWorkspaces(ctx) {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return []
    return registry
      .list()
      .map(item => ({
        id: String(item.id ?? ''),
        title: String(item.title ?? ''),
        path: String(item.path ?? ''),
        sessionCount: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
      }))
      .filter(item => item.id !== '')
  } catch {
    return []
  }
}

function workspaceIdOf(ctx, cwd) {
  const target = normalizePath(cwd)
  if (target === '') return ''
  const match = listWorkspaces(ctx).find(item => normalizePath(item.path) === target)
  return match?.id ?? ''
}

/** Bound sessions of one agent, enriched with the Session summary and Workspace. */
async function sessionSummaries(ctx) {
  try {
    const controller = ctx.get('sessionController')
    if (controller !== undefined && typeof controller.list === 'function') {
      const value = await controller.list({}, new AbortController().signal)
      return Array.isArray(value?.items) ? value.items : []
    }
  } catch {
    /* fall through */
  }
  return []
}

async function agentSessions(ctx, store, archives, agentId) {
  const bound = store.listBindings().filter(item => item.agentId === agentId)
  const summaries = await sessionSummaries(ctx)
  const byId = new Map(summaries.map(item => [String(item.sessionId), item]))
  const workspaces = listWorkspaces(ctx)
  const byPath = new Map(workspaces.map(item => [normalizePath(item.path), item]))
  const sessions = bound
    .map(item => {
      const summary = byId.get(item.sessionId)
      const archiveEntry = archives.entryOf(item.sessionId)
      const cwd =
        typeof summary?.cwd === 'string'
          ? summary.cwd
          : typeof archiveEntry?.cwd === 'string'
            ? archiveEntry.cwd
            : ''
      const workspace = cwd === '' ? undefined : byPath.get(normalizePath(cwd))
      const title =
        item.title ||
        sessionTitleOf(ctx, item.sessionId) ||
        (typeof archiveEntry?.title === 'string' ? archiveEntry.title : '')
      return {
        sessionId: item.sessionId,
        title,
        cwd,
        workspaceId: workspace?.id ?? '',
        workspaceTitle: workspace?.title ?? '',
        updatedAt: Number(summary?.updatedAt) || 0,
        running: summary?.running === true,
        visible: summary !== undefined,
        archive: archives.levelOf(item.sessionId),
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions }
}

/** Every bound session grouped by agent, for the sidebar section. */
async function allBoundSessions(ctx, store, archives) {
  const summaries = await sessionSummaries(ctx)
  const byId = new Map(summaries.map(item => [String(item.sessionId), item]))
  const workspaces = listWorkspaces(ctx)
  const byPath = new Map(workspaces.map(item => [normalizePath(item.path), item]))
  const names = new Map(store.state().vaults.map(item => [item.id, item.name]))
  const grouped = new Map()
  for (const item of store.listBindings()) {
    const name = names.get(item.agentId)
    if (name === undefined) continue
    const summary = byId.get(item.sessionId)
    const archiveEntry = archives.entryOf(item.sessionId)
    const cwd =
      typeof summary?.cwd === 'string'
        ? summary.cwd
        : typeof archiveEntry?.cwd === 'string'
          ? archiveEntry.cwd
          : ''
    const workspace = cwd === '' ? undefined : byPath.get(normalizePath(cwd))
    const session = {
      sessionId: item.sessionId,
      title:
        item.title ||
        sessionTitleOf(ctx, item.sessionId) ||
        (typeof archiveEntry?.title === 'string' ? archiveEntry.title : ''),
      workspaceTitle: workspace?.title ?? '',
      updatedAt: Number(summary?.updatedAt) || 0,
      running: summary?.running === true,
      archive: archives.levelOf(item.sessionId),
    }
    if (!grouped.has(item.agentId)) grouped.set(item.agentId, { agentId: item.agentId, name, sessions: [] })
    grouped.get(item.agentId).sessions.push(session)
  }
  const agents = [...grouped.values()].map(group => ({
    ...group,
    sessions: group.sessions.sort((a, b) => b.updatedAt - a.updatedAt),
  }))
  agents.sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))
  return { agents }
}

function writeCheckpoint(ctx, store, journals, handoff, input) {
  try {
    const state = store.state()
    const vault = state.vaults.find(item => item.id === input.agentId)
    const entries = journals.list({ id: input.agentId, limit: 5 }).entries
    const text = handoff.buildCheckpointText({
      agentId: input.agentId,
      agentName: vault?.name ?? input.agentId,
      sessionId: input.sessionId,
      tokens: input.tokens,
      threshold: input.threshold,
      memory: vault?.memory ?? '',
      entries,
    })
    const written = journals.write({
      id: input.agentId,
      kind: 'checkpoint',
      title: `交棒检查点 · ${Math.round(input.tokens / 1000)}k tokens`,
      text,
      meta: { tokens: input.tokens, threshold: input.threshold, sessionId: input.sessionId, memoryChars: vault?.memoryChars ?? 0 },
    })
    const exported = handoff.exportCheckpoint({ text, sessionId: input.sessionId })
    handoff.patchState(input.sessionId, { settledAt: new Date().toISOString(), checkpoint: written.id, exported })
    // A fresh session in the same directory picks this agent up automatically
    // (see the agent/created listener) until the intent expires.
    handoff.armNext(input.sessionId, {
      agentId: input.agentId,
      cwd: sessionCwd(ctx, input.sessionId),
      approval: approvalOf(ctx, input.sessionId),
      model: modelOf(ctx, input.sessionId),
    })
  } catch (error) {
    recordError(store, 'handoff/checkpoint', error)
  }
}

/**
 * Send the startup instruction into a fresh session. Admission is durable: the
 * Agent inbox owns the message even before the browser finishes opening the
 * conversation. The request id is stable per session, and the Host dedupes by
 * it, so the deferred retry cannot post the message twice.
 */
async function sendStartupPrompt(ctx, store, sessionId, text) {
  const controller = ctx.get('sessionController')
  if (controller === undefined || typeof controller.prompt !== 'function') return
  const admit = () =>
    controller.prompt(
      {
        requestId: `handoff-start-${sessionId}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      new AbortController().signal,
    )
  try {
    await admit()
  } catch (error) {
    // Creation can still be settling; one deferred retry usually lands.
    setTimeout(() => {
      admit().catch(retryError => recordError(store, 'handoff/startup-prompt', retryError))
    }, 500)
  }
}

/**
 * Handoff status for every bound session, live or cold.
 *
 * The auto switch must work for a session the user merely opened — or for one
 * that settled earlier and is not open at all — so the row set comes from the
 * bindings joined with persisted session summaries, not from `agents.list()`
 * (which only carries Agents that were resumed into this process).
 */
async function handoffStatus(ctx, store, handoff) {
  const config = handoff.config()
  const summaries = await sessionSummaries(ctx)
  const summaryById = new Map(summaries.map(item => [String(item.sessionId), item]))
  const live = ctx.get('agents')
  const liveIds = new Set(
    (live !== undefined && typeof live.list === 'function' ? live.list() : []).map(agent => String(agent.id)),
  )
  const ids = new Set(store.listBindings().map(item => item.sessionId))
  for (const id of liveIds) if (store.bindingOf(id) !== '') ids.add(id)
  const sessions = [...ids].map(sessionId => {
    const summary = summaryById.get(sessionId)
    const tokens = measureTokens(ctx, sessionId)
    const state = handoff.stateOf(sessionId)
    const bound = store.bindingOf(sessionId)
    const stage = state?.settledAt
      ? 'settled'
      : state?.requestedAt
        ? 'requested'
        : tokens >= config.triggerTokens
          ? 'due'
          : 'watching'
    const cwd = sessionCwd(ctx, sessionId) ?? (typeof summary?.cwd === 'string' ? summary.cwd : undefined)
    // An expired intent is not "armed": the client would open a new session
    // and then `takeNext` would drop the intent, leaving it unbound.
    const next = state?.next
    const armed =
      next !== undefined &&
      next !== null &&
      Number.isFinite(Date.parse(next.at)) &&
      Date.parse(next.at) >= Date.now() - DEFAULT_NEXT_TTL_MS
    return {
      sessionId,
      title: sessionTitleOf(ctx, sessionId),
      tokens,
      agentId: bound,
      stage,
      workspaceId: workspaceIdOf(ctx, cwd),
      agentPreset: agentPresetOf(ctx, sessionId),
      running: summary?.running === true,
      requestedAt: state?.requestedAt,
      settledAt: state?.settledAt,
      checkpoint: state?.checkpoint,
      exported: state?.exported,
      armed,
      armedAt: armed ? next.at : undefined,
    }
  })
  return { config, capabilities: { arm: true, startPrompt: true }, sessions }
}

function registerHandoff(ctx, store, journals, handoff, archives, hints) {
  ctx.effect(
    () =>
      ctx.on('agent/pre-step', async (payload, next) => {
        try {
          const sessionId = String(payload?.agent?.id ?? '')
          // Archived conversations are read-only: reject the step before it
          // reaches the model. Weak archives stay openable in DSH; this gate is
          // what actually stops them from continuing.
          if (sessionId !== '' && archives.levelOf(sessionId) !== '') {
            hints.delete(sessionId)
            return { kind: 'reject' }
          }
          const config = handoff.config()
          if (!config.enabled || sessionId === '') {
            if (sessionId !== '') hints.delete(sessionId)
            return await next()
          }
          const tokens = measureTokens(ctx, sessionId)
          if (tokens < config.triggerTokens) {
            hints.delete(sessionId)
            return await next()
          }
          const agentId = store.bindingOf(sessionId)
          if (agentId === '') {
            hints.delete(sessionId)
            return await next()
          }
          const result = handoff.evaluate({
            sessionId,
            tokens,
            memoryAt: store.memoryUpdatedAt(agentId),
            journalAt: journals.latestAt(agentId),
          })
          if (result.stage === 'requested') hints.set(sessionId, handoffHint(tokens, result.threshold))
          else hints.delete(sessionId)
          if (result.stage === 'ready') {
            writeCheckpoint(ctx, store, journals, handoff, {
              sessionId,
              agentId,
              tokens,
              threshold: result.threshold,
            })
          }
        } catch (error) {
          recordError(store, 'handoff/pre-step', error)
        }
        return await next()
      }),
    'agent-memory: handoff step',
  )

  // The next fresh session in the same directory inherits the checkpoint's
  // agent (and its approval policy). `startup`/`clear` are the only sources
  // that mean "a new session"; resume must not consume the intent.
  ctx.effect(
    () =>
      ctx.on('agent/created', async payload => {
        try {
          const source = String(payload?.source ?? '')
          if (source !== 'startup' && source !== 'clear') return
          const agent = payload?.agent
          if (agent === undefined || agent === null) return
          const sessionId = String(agent.id ?? '')
          if (sessionId === '') return
          const session = sessionOf(ctx, sessionId)
          if (session?.header?.origin === 'subagent') return
          const bound = store.bindingOf(sessionId)
          if (bound !== '') return
          const taken = handoff.takeNext({ cwd: sessionCwd(ctx, sessionId), excludeSessionId: sessionId })
          if (taken === null) return
          store.setBinding({ sessionId, agentId: taken.agentId })
          let modelPending = false
          if (taken.approval !== undefined) {
            const approval = ctx.get('approval')
            if (approval !== undefined && typeof approval.setPolicy === 'function') approval.setPolicy(agent, taken.approval)
          }
          if (taken.model !== undefined && taken.model !== null) {
            const controller = ctx.get('sessionController')
            if (controller !== undefined && typeof controller.selectModel === 'function') {
              const applyModel = () => controller.selectModel({ sessionId, ...taken.model })
              try {
                await applyModel()
              } catch (error) {
                modelPending = true
                // Creation can still be settling; one deferred retry usually lands.
                setTimeout(() => {
                  applyModel().catch(retryError => recordError(store, 'handoff/select-model', retryError))
                }, 500)
              }
            }
          }
          // The conversation we just left is now superseded: park it as a weak
          // archive. Weak stays a normal (viewable) session in DSH and is made
          // read-only by the pre-step gate below; strong additionally uses the
          // native DSH archive.
          if (typeof taken.sessionId === 'string' && taken.sessionId !== '' && taken.sessionId !== sessionId) {
            try {
              archives.setLevel(taken.sessionId, 'weak', {
                cwd: sessionCwd(ctx, taken.sessionId),
                title: sessionTitleOf(ctx, taken.sessionId),
              })
            } catch (error) {
              recordError(store, 'handoff/archive', error)
            }
          }
          // Auto-switch only: the client attaches the startup instruction to
          // the intent right before it opens the conversation. Send it after
          // the inheritance above so the first turn uses the inherited model.
          const startupPrompt = typeof taken.startupPrompt === 'string' ? taken.startupPrompt.trim() : ''
          if (startupPrompt !== '') {
            if (modelPending) {
              setTimeout(() => {
                void sendStartupPrompt(ctx, store, sessionId, startupPrompt)
              }, 500)
            } else {
              await sendStartupPrompt(ctx, store, sessionId, startupPrompt)
            }
          }
        } catch (error) {
          recordError(store, 'handoff/next-session', error)
        }
      }),
    'agent-memory: handoff next session',
  )

  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(
      () =>
        scoped.systemPrompt.context({
          name: 'agent-handoff',
          order: SECTION_ORDER + 1,
          interpolate: false,
          text: context => hints.get(sessionIdOf(context)) ?? '',
        }),
      'agent-memory: handoff hint',
    )
  })
}

// ── HTTP surface for the manager page ────────────────────────────────────────

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new MemoryError('body-too-large', 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new MemoryError('bad-json', 'invalid JSON body')
  }
}

function loopbackName(host) {
  const name = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '::1'
}

/** Structural fallback for compositions that mount no `connection` service. */
function structuralRejection(req) {
  const host = String(req.headers?.host ?? '')
  if (!loopbackName(host)) return 403
  const origin = req.headers?.origin ?? req.headers?.referer
  if (typeof origin === 'string' && origin !== '' && !origin.startsWith('dsh-app://')) {
    try {
      if (new URL(origin).host !== host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/**
 * Never weaker than the kernel's own `/api` admission: a longer prefix wins
 * dispatch, so these routes run before that check unless they repeat it.
 */
function rejectionFor(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined) return structuralRejection(req)
  try {
    if (typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req)
    }
    if (typeof connection.admit === 'function') {
      const admission = connection.admit(req)
      return admission && typeof admission === 'object' ? admission.rejection : undefined
    }
  } catch {
    return 503
  }
  return structuralRejection(req)
}

async function handleOp(ctx, store, rooms, journals, handoff, archives, op, args) {
  switch (op) {
    case 'state':
      return store.state()
    case 'vault.create':
      return store.createAgent({ name: args.name, description: args.description })
    case 'vault.update':
      return store.updateAgent({ id: args.id, name: args.name, description: args.description })
    case 'vault.delete':
      return store.deleteAgent({ id: args.id, deleteKnowledge: args.deleteKnowledge === true })
    case 'vault.activate':
      store.saveSettings({ activeVault: typeof args.id === 'string' ? args.id : '' })
      return store.state()
    case 'binding.set':
      return store.setBinding({ sessionId: args.sessionId, agentId: args.agentId })
    case 'binding.list':
      return store.listBindings()
    case 'memory.save':
      return store.writeMemory({ id: args.id, content: args.content, note: 'panel' })
    case 'knowledge.list':
      return store.listKnowledge({ id: args.id })
    case 'knowledge.search':
      return store.searchKnowledge({ id: args.id, query: args.query, limit: args.limit })
    case 'knowledge.read':
      return store.readKnowledge({ entry: args.entry })
    case 'knowledge.save':
      return store.saveKnowledge({
        id: args.id,
        entry: args.entry,
        title: args.title,
        content: args.content,
        tags: args.tags,
        source: 'panel',
      })
    case 'knowledge.delete':
      return store.deleteKnowledge({ entry: args.entry })
    case 'room.list':
      return { rooms: rooms.list() }
    case 'room.create':
      return rooms.create({ name: args.name })
    case 'room.rename':
      return rooms.rename({ id: args.id, name: args.name })
    case 'room.delete':
      return rooms.remove({ id: args.id })
    case 'room.members':
      return rooms.setMembers({ id: args.id, members: args.members })
    case 'room.read':
      return rooms.read({ id: args.id, limit: args.limit })
    case 'room.say':
      return rooms.say({ id: args.id, text: args.text, from: { kind: 'user', id: 'user', name: '我' } })
    case 'room.clear':
      return rooms.clear({ id: args.id })
    case 'journal.list':
      return journals.list({ id: args.id, query: args.query, limit: args.limit })
    case 'journal.read':
      return journals.read({ id: args.id, entry: args.entry })
    case 'journal.write':
      return journals.write({ id: args.id, title: args.title, text: args.text })
    case 'journal.delete':
      return journals.remove({ id: args.id, entry: args.entry })
    case 'handoff.status':
      return handoffStatus(ctx, store, handoff)
    case 'handoff.save':
      return handoff.saveConfig({
        enabled: args.enabled,
        triggerTokens: args.triggerTokens,
        remindEverySteps: args.remindEverySteps,
        exportDir: args.exportDir,
        autoSwitch: args.autoSwitch,
        startupPrompt: args.startupPrompt,
      })
    case 'handoff.reset':
      handoff.clearState(args.sessionId)
      return { reset: args.sessionId }
    case 'handoff.arm': {
      const sessionId = String(args.sessionId ?? '')
      const agentId = store.bindingOf(sessionId)
      if (agentId === '') throw new MemoryError('no-agent', 'bind an agent to this session first')
      const cwd = sessionCwd(ctx, sessionId)
      const config = handoff.config()
      // Only the automatic switch asks for the startup instruction; a manual
      // "continue" or an ordinary new session must not start talking on its own.
      const startupPrompt =
        args.autoStart === true && config.startupPrompt.trim() !== '' ? config.startupPrompt.trim() : ''
      const next = handoff.armNext(sessionId, {
        agentId,
        cwd,
        approval: approvalOf(ctx, sessionId),
        model: modelOf(ctx, sessionId),
        ...(startupPrompt === '' ? {} : { startupPrompt }),
      })
      return {
        sessionId,
        agentId,
        workspaceId: workspaceIdOf(ctx, cwd),
        agentPreset: agentPresetOf(ctx, sessionId),
        startupPrompt,
        next,
      }
    }
    case 'workspace.list':
      return { workspaces: listWorkspaces(ctx) }
    case 'agent.sessions':
      return agentSessions(ctx, store, archives, String(args.id ?? ''))
    case 'bound.list':
      return allBoundSessions(ctx, store, archives)
    case 'archive.set': {
      const sessionId = String(args.sessionId ?? '')
      if (sessionId === '') throw new MemoryError('bad-session', 'session id required')
      const level = String(args.level ?? '')
      if (level !== '' && !ARCHIVE_LEVELS.includes(level)) {
        throw new MemoryError('bad-level', `unknown archive level: ${level}`)
      }
      const meta = { cwd: sessionCwd(ctx, sessionId), title: sessionTitleOf(ctx, sessionId) }
      const registry = ctx.get('workspaceRegistry')
      // Weak is a plugin-level read-only park: the session stays a normal DSH
      // session so it can be opened for reading. Strong leans on the native
      // DSH archive, which really hides it and refuses turns.
      if (level === 'weak' || level === '') {
        if (registry !== undefined && typeof registry.unarchiveSession === 'function') {
          await registry.unarchiveSession(sessionId)
        }
        archives.setLevel(sessionId, level, meta)
        return { sessionId, level }
      }
      if (registry !== undefined && typeof registry.archiveSession === 'function') {
        await registry.archiveSession(sessionId, { stopActivity: true })
      }
      archives.setLevel(sessionId, level, meta)
      return { sessionId, level }
    }
    case 'agent.newSession': {
      const agentId = String(args.id ?? '')
      if (!store.state().vaults.some(item => item.id === agentId)) {
        throw new MemoryError('no-vault', `unknown agent: ${agentId || '(empty)'}`)
      }
      const workspaceId = String(args.workspaceId ?? '')
      const workspace = workspaceId === '' ? undefined : listWorkspaces(ctx).find(item => item.id === workspaceId)
      const controller = ctx.get('sessionController')
      if (controller === undefined || typeof controller.create !== 'function') {
        throw new MemoryError('no-sessions', 'this composition cannot create sessions')
      }
      const created = await controller.create({
        ...(workspace === undefined ? {} : { workspaceId: workspace.id }),
      })
      const sessionId = String(created?.sessionId ?? '')
      if (sessionId === '') throw new MemoryError('no-session', 'session creation returned no id')
      store.setBinding({ sessionId, agentId })
      return { agentId, sessionId, workspaceId: workspace?.id ?? '', workspaceTitle: workspace?.title ?? '' }
    }
    case 'settings.save':
      store.saveSettings({ knowledgeDir: args.knowledgeDir, hideBoundSessions: args.hideBoundSessions })
      return store.state()
    default:
      throw new MemoryError('bad-op', `unknown operation: ${String(op)}`)
  }
}

function registerApi(ctx, store, rooms, journals, handoff, archives, hints) {
  /**
   * Store state plus the capabilities this host build exposes to the panel.
   * `arm` gates the client's automatic switch, so it must be declared here as
   * well as on `handoff.status` — the poll reads `/state` first.
   */
  const publicState = () => ({
    ...store.state(),
    capabilities: { sessions: true, bound: true, archive: true, arm: true, startPrompt: true },
  })
  // `webServer` is published after plugins load in the Web composition, so this
  // must pend on the service instead of reading it once at apply time.
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    const handler = async (req, res) => {
      const rejection = rejectionFor(ctx, req)
      if (rejection !== undefined) {
        json(res, rejection, {
          error: { code: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'unavailable' : 'forbidden' },
        })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const route = url.pathname.replace(/^\/api\/agent-memory/, '').replace(/\/+$/, '') || '/'
      const method = String(req.method ?? 'GET').toUpperCase()
      try {
        if (method === 'GET' && (route === '/' || route === '/state')) {
          return json(res, 200, { ok: true, state: publicState() })
        }
        if (method === 'POST' && route === '/op') {
          const body = await readJson(req)
          const op = String(body?.op ?? '')
          const args = body?.args && typeof body.args === 'object' ? body.args : {}
          const value = await handleOp(ctx, store, rooms, journals, handoff, archives, op, args)
          return json(res, 200, { ok: true, value, state: publicState() })
        }
        return json(res, 404, { error: { code: 'not-found', message: `no route ${method} ${route}` } })
      } catch (error) {
        const code = error instanceof MemoryError ? error.code : 'failed'
        const status =
          code === 'body-too-large' ? 413 : code === 'bad-json' ? 400 : code === 'failed' ? 500 : 400
        return json(res, status, { error: { code, message: String(error?.message ?? error) } })
      }
    }
    scoped.effect(() => server.register({ kind: 'prefix', path: API_BASE, handler }), 'agent-memory: api routes')
  })
}
