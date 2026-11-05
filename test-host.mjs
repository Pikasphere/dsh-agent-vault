/**
 * Offline harness: load the Host half with a mock Cordis context and exercise
 * registration plus the HTTP surface, without touching the installed profile.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, name).replace(/\\/g, '/')}`)

const { apply } = await load('index.js')

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-host-'))
const registered = { tools: [], sections: [], contexts: [], routes: [], effects: [], handlers: [] }

function scope(deps) {
  return {
    effect(fn, label) {
      const disposer = fn()
      registered.effects.push({ label, disposer })
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        registered.sections.push(section)
        return () => {}
      },
      context(entry) {
        registered.contexts.push(entry)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        registered.routes.push(route)
        return () => {}
      },
    },
  }
}

const ctx = {
  effect(fn, label) {
    return scope([]).effect(fn, label)
  },
  inject(deps, callback) {
    callback(scope(deps))
  },
  get() {
    return undefined
  },
  on(event, handler) {
    registered.handlers.push({ event, handler })
    return () => {}
  },
}

// the reveal op would otherwise pop a file manager on the developer's desktop
const revealed = []
apply(ctx, {
  memoryDir: path.join(scratch, 'mem'),
  knowledgeDir: path.join(scratch, 'kb'),
  reveal: dir => (revealed.push(dir), true),
})

// ── registration ────────────────────────────────────────────────────────────
const names = registered.tools.map(tool => tool.name).sort()
assert.deepEqual(names, [
  'agent_alias',
  'agent_journal',
  'agent_knowledge_read',
  'agent_knowledge_search',
  'agent_knowledge_write',
  'agent_memory_save',
  'agent_recall',
  'agent_room',
])
for (const tool of registered.tools) {
  assert.equal(typeof tool.description, 'string')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
  assert.ok(tool.output.render({}, { ok: true })[0].text.includes('ok'))
}
assert.equal(registered.sections.length, 1)
assert.equal(registered.routes.length, 1)
assert.equal(registered.routes[0].path, '/api/agent-memory')
assert.equal(registered.routes[0].kind, 'prefix')
console.log('registration ok:', names.join(', '))

// ── prompt section ──────────────────────────────────────────────────────────
const section = registered.sections[0]
const emptyPrompt = section.text()
assert.ok(emptyPrompt.includes('agent_knowledge_search'))
assert.ok(emptyPrompt.includes('No agent is selected'))
console.log('prompt (no selection) ok')

// ── HTTP surface ────────────────────────────────────────────────────────────
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    url,
    headers: { host: '127.0.0.1:64267' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeRes() {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) {
      out.status = status
      out.headers = headers ?? {}
    },
    end(body) {
      out.body = body ?? ''
    },
  }
}

async function call(method, route, body) {
  const res = fakeRes()
  await registered.routes[0].handler(fakeReq(method, `/api/agent-memory${route}`, body), res)
  const payload = res.out.body === '' ? undefined : JSON.parse(res.out.body)
  return { status: res.out.status, payload }
}

const initial = await call('GET', '/state')
assert.equal(initial.status, 200)
assert.equal(initial.payload.state.vaults.length, 0)
// The client's automatic switch polls /state first and only runs when the
// host advertises `arm`; dropping it here silently disabled the feature.
assert.equal(initial.payload.state.capabilities.arm, true)
assert.equal(initial.payload.state.capabilities.startPrompt, true)
console.log('GET /state ok')

const created = await call('POST', '/op', { op: 'vault.create', args: { name: '重构助手' } })
assert.equal(created.status, 200)
const id = created.payload.value.id
assert.match(id, /^agent-[a-z0-9]+$/)
assert.equal(created.payload.state.vaults.length, 1)
assert.equal(created.payload.state.vaults[0].name, '重构助手')
console.log('vault.create ok', id)

const saved = await call('POST', '/op', { op: 'memory.save', args: { id, content: '目标：拆分存储层。已完成：记忆。下一步：界面。' } })
assert.equal(saved.status, 200)
assert.ok(saved.payload.state.vaults[0].memoryChars > 0)

await call('POST', '/op', { op: 'vault.activate', args: { id } })
const active = (await call('GET', '/state')).payload.state
assert.equal(active.activeVault, id)
const prompt = section.text()
assert.ok(prompt.includes('重构助手'))
assert.ok(prompt.includes('拆分存储层'))
assert.ok(prompt.includes('<agent_memory'))
console.log('memory + prompt injection ok')

const written = await call('POST', '/op', {
  op: 'knowledge.save',
  args: { id, title: '沙箱 ACL', content: '先授予目录遍历权限。', tags: 'acl,windows' },
})
assert.equal(written.status, 200)
const entry = written.payload.value.entry

const searched = await call('POST', '/op', { op: 'knowledge.search', args: { id, query: 'acl' } })
assert.equal(searched.payload.value.entries.length, 1)
const read = await call('POST', '/op', { op: 'knowledge.read', args: { id, entry } })
assert.ok(read.payload.value.content.includes('目录遍历'))
console.log('knowledge save/search/read ok')

// recall over the same store: the memory audit log and the knowledge base
const recalled = await call('POST', '/op', { op: 'memory.recall', args: { id, query: '存储层' } })
assert.equal(recalled.status, 200)
assert.ok(recalled.payload.value.total >= 1, JSON.stringify(recalled.payload))
assert.ok(recalled.payload.value.results.some(item => item.src === 'log'))
const knowledgeOnly = await call('POST', '/op', {
  op: 'memory.recall',
  args: { id, query: 'acl', source: 'knowledge' },
})
assert.ok(knowledgeOnly.payload.value.results.every(item => item.src === 'knowledge'))
const rebuilt = await call('POST', '/op', { op: 'memory.reindex', args: {} })
assert.ok(rebuilt.payload.value.total >= 2)
const indexState = await call('POST', '/op', { op: 'memory.index', args: {} })
assert.equal(indexState.payload.value.builtAt, rebuilt.payload.value.builtAt)
const opened = await call('POST', '/op', {
  op: 'memory.open',
  args: { id, src: 'knowledge', entry: knowledgeOnly.payload.value.results[0].id },
})
assert.equal(opened.payload.value.entry.src, 'knowledge')
assert.ok(opened.payload.value.entry.text.length > 0)
// session list is scoped to the agent (none here) and exclusion toggles reject unknown ids
const noSessions = await call('POST', '/op', { op: 'memory.sessions', args: { id } })
assert.deepEqual(noSessions.payload.value.sessions, [])
const rejected = await call('POST', '/op', { op: 'memory.transcript', args: { id, sessionId: 'session-unknown', include: false } })
assert.equal(rejected.status, 404)
// alias table: readable and writable from both the panel and the tool
const aliasEmpty = await call('POST', '/op', { op: 'memory.aliases', args: {} })
assert.deepEqual(aliasEmpty.payload.value.table, {})
const aliasWritten = await call('POST', '/op', { op: 'memory.alias', args: { key: 'widget', targets: ['lane'] } })
assert.deepEqual(aliasWritten.payload.value.table, { widget: ['lane'] })
const aliasListed = await call('POST', '/op', { op: 'memory.aliases', args: {} })
assert.deepEqual(aliasListed.payload.value.table.widget, ['lane'])
const aliasBad = await call('POST', '/op', { op: 'memory.alias', args: { key: '  ' } })
assert.equal(aliasBad.status, 400)
const aliasGone = await call('POST', '/op', { op: 'memory.alias', args: { key: 'widget', remove: true } })
assert.equal(aliasGone.payload.value.removed, true)
const badSeq = await call('POST', '/op', { op: 'memory.message', args: { id, sessionId: 'session-unknown', seq: 1 } })
assert.equal(badSeq.status, 404)
const missingSeq = await call('POST', '/op', { op: 'memory.message', args: { id, sessionId: 'session-unknown' } })
assert.equal(missingSeq.status, 400)
// the recall tab persists its ranking mode through recall.save; unknown values are ignored
const lexicalMode = await call('POST', '/op', { op: 'recall.save', args: { recall: { mode: 'lexical' } } })
assert.equal(lexicalMode.status, 200)
assert.equal(lexicalMode.payload.value.mode, 'lexical')
const keptMode = await call('POST', '/op', { op: 'recall.save', args: { recall: { mode: 'sideways' } } })
assert.equal(keptMode.payload.value.mode, 'lexical')
const hybridMode = await call('POST', '/op', { op: 'recall.save', args: { recall: { mode: 'hybrid', minCosine: 2 } } })
assert.equal(hybridMode.payload.value.mode, 'hybrid')
const settingsBack = await call('POST', '/op', { op: 'state', args: {} })
assert.equal(settingsBack.payload.value.recall.minCosine, 1)
const lexicalSearch = await call('POST', '/op', {
  op: 'memory.recall',
  args: { id, query: '存储层', mode: 'lexical' },
})
assert.equal(lexicalSearch.payload.value.mode, 'lexical')
console.log('recall + reindex ok')

// the library is shared: a second agent sees the first agent's entry
const second = await call('POST', '/op', { op: 'vault.create', args: { name: 'Second agent' } })
const secondId = second.payload.value.id
const seenByOther = await call('POST', '/op', { op: 'knowledge.read', args: { entry } })
assert.equal(seenByOther.payload.value.agent, id)
const contributed = await call('POST', '/op', {
  op: 'knowledge.save',
  args: { id: secondId, title: '来自第二个智能体', content: '共享库测试。' },
})
assert.equal(contributed.payload.value.agent, secondId)
const all = await call('POST', '/op', { op: 'knowledge.list', args: {} })
assert.ok(all.payload.value.total >= 2)
console.log('shared knowledge ok')

// ── tools against the same store ────────────────────────────────────────────
const exec = { agent: { id: 'session-test-1234' } }
const memoryTool = registered.tools.find(tool => tool.name === 'agent_memory_save')
const memoryResult = await memoryTool.execute({ content: '交接：界面待验证。' }, exec)
assert.equal(memoryResult.ok, true)
assert.equal(memoryResult.id, id)
assert.ok(memoryResult.chars > 0)

const tooLong = await memoryTool.execute({ content: 'x'.repeat(4200) }, exec)
assert.equal(tooLong.ok, false)
assert.equal(tooLong.error, 'memory-too-long')

const aliasTool = registered.tools.find(tool => tool.name === 'agent_alias')
const aliasSetTool = await aliasTool.execute({ action: 'set', key: '鲸鱼', targets: ['whale'] }, exec)
assert.equal(aliasSetTool.ok, true)
assert.deepEqual(aliasSetTool.targets, ['whale'])
const aliasListTool = await aliasTool.execute({}, exec)
assert.deepEqual(aliasListTool.table['鲸鱼'], ['whale'])
const aliasDelTool = await aliasTool.execute({ action: 'delete', key: '鲸鱼' }, exec)
assert.equal(aliasDelTool.removed, true)

const kbTool = registered.tools.find(tool => tool.name === 'agent_knowledge_write')
const kbResult = await kbTool.execute({ title: '打包', content: 'local dir 安装是链接。', tags: ['bundle'] }, exec)
assert.equal(kbResult.ok, true)

const searchTool = registered.tools.find(tool => tool.name === 'agent_knowledge_search')
const found = await searchTool.execute({ query: 'bundle' }, exec)
assert.equal(found.ok, true)
assert.equal(found.entries.length, 1)
assert.equal(found.entries[0].id, kbResult.entry)

const readTool = registered.tools.find(tool => tool.name === 'agent_knowledge_read')
const full = await readTool.execute({ entry: kbResult.entry }, exec)
assert.equal(full.ok, true)
assert.ok(full.content.includes('链接'))
console.log('tools ok')


// archive + session-creation mocks: these services are pended on at call time
const archiveCalls = []
const unarchiveCalls = []
const createCalls = []
const archiveService = {
  archive: (sessionId, options) => {
    archiveCalls.push({ sessionId, options })
    return Promise.resolve({ archived: true })
  },
  unarchive: sessionId => {
    unarchiveCalls.push(sessionId)
    return Promise.resolve({ archived: false })
  },
  levelOf: () => '',
}
const realGet = ctx.get
ctx.get = name => {
  if (name === 'archive') return archiveService
  if (name === 'workspaceRegistry') {
    return {
      list: () => [
        { id: 'w-work', title: 'Work', path: 'E:\\work' },
        { id: 'w-other', title: 'Other', path: 'E:\\other' },
      ],
      archiveSession: (sessionId, options) => {
        archiveCalls.push({ sessionId, options })
        return Promise.resolve({ archived: true })
      },
      unarchiveSession: sessionId => {
        unarchiveCalls.push(sessionId)
        return Promise.resolve({ archived: false })
      },
    }
  }
  if (name === 'sessionController') {
    return {
      list: () =>
        Promise.resolve({
          items: [
            { sessionId: 'session-test-1234', cwd: 'E:\\work', updatedAt: 1000, running: true },
            { sessionId: 'session-elsewhere', cwd: 'E:\\other', updatedAt: 900, running: false },
          ],
        }),
      create: request => {
        createCalls.push(request)
        return Promise.resolve({ sessionId: 'session-created' })
      },
    }
  }
  if (name === 'workingDirectory') return { get: () => 'E:\\work' }
  if (name === 'workspace') {
    return {
      list: () => [
        { id: 'w-work', title: 'Work', path: 'E:\\work' },
        { id: 'w-other', title: 'Other', path: 'E:\\other' },
      ],
    }
  }
  return realGet(name)
}
await call('POST', '/op', { op: 'binding.set', args: { sessionId: 'session-test-1234', agentId: id } })

// ── manual archive levels ───────────────────────────────────────────────────
// Weak is plugin-level: the session stays a normal DSH session (openable).
assert.equal(archiveCalls.length, 0)
await call('POST', '/op', { op: 'archive.set', args: { sessionId: 'session-test-1234', level: 'weak' } })
const archivedRow = (await call('POST', '/op', { op: 'agent.sessions', args: { id } })).payload.value.sessions.find(
  item => item.sessionId === 'session-test-1234',
)
assert.equal(archivedRow.archive, 'weak')

const promoted = await call('POST', '/op', { op: 'archive.set', args: { sessionId: 'session-test-1234', level: 'strong' } })
assert.equal(promoted.payload.value.level, 'strong')
assert.deepEqual(archiveCalls[0], { sessionId: 'session-test-1234', options: { stopActivity: true } })
const strongRow = (await call('POST', '/op', { op: 'bound.list', args: {} })).payload.value.agents
  .flatMap(agent => agent.sessions)
  .find(item => item.sessionId === 'session-test-1234')
assert.equal(strongRow.archive, 'strong')

// strong → weak really unarchives; weak → '' is just a level reset
const downgraded = await call('POST', '/op', { op: 'archive.set', args: { sessionId: 'session-test-1234', level: 'weak' } })
assert.equal(downgraded.payload.value.level, 'weak')
assert.ok(unarchiveCalls.includes('session-test-1234'))

const cleared = await call('POST', '/op', { op: 'archive.set', args: { sessionId: 'session-test-1234', level: '' } })
assert.equal(cleared.payload.value.level, '')
assert.equal(
  (await call('POST', '/op', { op: 'agent.sessions', args: { id } })).payload.value.sessions.find(
    item => item.sessionId === 'session-test-1234',
  ).archive,
  '',
)
const badLevel = await call('POST', '/op', { op: 'archive.set', args: { sessionId: 'session-test-1234', level: 'gone' } })
assert.equal(badLevel.status, 400)
assert.equal(badLevel.payload.error.code, 'bad-level')
console.log('archive levels ok')

// ── workspace / sessions / new-session ops ──────────────────────────────────
const workspaces = await call('POST', '/op', { op: 'workspace.list', args: {} })
assert.equal(workspaces.payload.value.workspaces.length, 2)
assert.equal(workspaces.payload.value.workspaces[0].id, 'w-work')

const agentSessionList = await call('POST', '/op', { op: 'agent.sessions', args: { id } })
const row = agentSessionList.payload.value.sessions.find(item => item.sessionId === 'session-test-1234')
assert.equal(row.workspaceId, 'w-work')
assert.equal(row.workspaceTitle, 'Work')
assert.equal(row.running, true)
assert.equal(row.visible, true)

const newSessionResult = await call('POST', '/op', { op: 'agent.newSession', args: { id, workspaceId: 'w-work' } })
assert.equal(newSessionResult.payload.value.sessionId, 'session-created')
assert.deepEqual(createCalls[0], { workspaceId: 'w-work' })
const boundAfterCreate = await call('POST', '/op', { op: 'binding.list', args: {} })
assert.ok(boundAfterCreate.payload.value.some(item => item.sessionId === 'session-created' && item.agentId === id))

const boundGroups = await call('POST', '/op', { op: 'bound.list', args: {} })
const demoGroup = boundGroups.payload.value.agents.find(item => item.agentId === id)
assert.ok(demoGroup !== undefined)
assert.ok(demoGroup.sessions.some(item => item.sessionId === 'session-created'))

assert.equal((await call('GET', '/state')).payload.state.hideBoundSessions, true)
const hidden = await call('POST', '/op', { op: 'settings.save', args: { hideBoundSessions: false } })
assert.equal(hidden.payload.state.hideBoundSessions, false)

// the 对话入索引 switch used to be dropped on the floor by this op
const noTranscripts = await call('POST', '/op', { op: 'settings.save', args: { transcripts: false } })
assert.equal(noTranscripts.payload.state.transcripts, false)
const withTranscripts = await call('POST', '/op', { op: 'settings.save', args: { transcripts: true } })
assert.equal(withTranscripts.payload.state.transcripts, true)
console.log('workspace + sessions ops ok')

// ── folders ─────────────────────────────────────────────────────────────────
const rootState = (await call('GET', '/state')).payload.state
assert.equal(rootState.pluginDir, here)

const revealedRoot = await call('POST', '/op', { op: 'fs.reveal', args: { target: 'root' } })
assert.equal(revealedRoot.payload.value.ok, true)
assert.equal(revealedRoot.payload.value.path, path.join(scratch, 'mem'))
assert.equal(revealed.at(-1), path.join(scratch, 'mem'))

const revealedKnowledge = await call('POST', '/op', { op: 'fs.reveal', args: { target: 'knowledge' } })
assert.equal(revealedKnowledge.payload.value.path, path.join(scratch, 'kb'))

const revealedPlugin = await call('POST', '/op', { op: 'fs.reveal', args: { target: 'plugin' } })
assert.equal(revealedPlugin.payload.value.path, here)

// a path from the page must never reach the spawner
const nasty = await call('POST', '/op', { op: 'fs.reveal', args: { target: '../../Windows' } })
assert.equal(nasty.status, 400)
assert.equal(nasty.payload.error.code, 'bad-request')
assert.equal(revealed.length, 3)
console.log('fs.reveal ok')

// ── errors ──────────────────────────────────────────────────────────────────
const bad = await call('POST', '/op', { op: 'nope' })
assert.equal(bad.status, 400)
assert.equal(bad.payload.error.code, 'bad-op')

const missing = await call('GET', '/nowhere')
assert.equal(missing.status, 404)

const forbiddenRes = fakeRes()
await registered.routes[0].handler(
  { method: 'GET', url: '/api/agent-memory/state', headers: { host: 'evil.example.com' } },
  forbiddenRes,
)
assert.equal(forbiddenRes.out.status, 403)
console.log('errors + trust fence ok')

// ── discussion rooms + private journal over HTTP ────────────────────────────
const room = await call('POST', '/op', { op: 'room.create', args: { name: '测试室' } })
const roomId = room.payload.value.id
assert.match(roomId, /^r-[a-z0-9]{4,12}$/)
await call('POST', '/op', { op: 'room.members', args: { id: roomId, members: [id, secondId] } })
await call('POST', '/op', { op: 'room.say', args: { id: roomId, text: '你好' } })
const transcript = await call('POST', '/op', { op: 'room.read', args: { id: roomId } })
assert.equal(transcript.payload.value.total, 1)
assert.equal(transcript.payload.value.messages[0].from.kind, 'user')
const roomList = await call('POST', '/op', { op: 'room.list', args: {} })
assert.equal(roomList.payload.value.rooms.length, 1)
assert.deepEqual(roomList.payload.value.rooms[0].members, [id, secondId])

await call('POST', '/op', { op: 'journal.write', args: { id, title: '日志一', text: '只有这个智能体能看到的细节' } })
const journal = await call('POST', '/op', { op: 'journal.list', args: { id } })
assert.equal(journal.payload.value.total, 1)
assert.equal(journal.payload.value.entries[0].title, '日志一')
const otherJournal = await call('POST', '/op', { op: 'journal.list', args: { id: secondId } })
assert.equal(otherJournal.payload.value.total, 0)
// checkpoints are opt-in: hidden by default, listed with meta on request
await call('POST', '/op', {
  op: 'journal.write',
  args: { id, kind: 'checkpoint', title: '交棒检查点', text: '交接上下文', meta: { tokens: 1, threshold: 1, sessionId: 'session-x' } },
})
const notesOnly = await call('POST', '/op', { op: 'journal.list', args: { id } })
assert.equal(notesOnly.payload.value.entries.some(entry => entry.kind === 'checkpoint'), false)
const cpList = await call('POST', '/op', { op: 'journal.list', args: { id, includeCheckpoints: true } })
assert.equal(cpList.payload.value.entries[0].kind, 'checkpoint')
assert.equal(cpList.payload.value.entries[0].meta.sessionId, 'session-x')
console.log('rooms + journal ok')

// ── teardown ────────────────────────────────────────────────────────────────
for (const effect of registered.effects) {
  if (typeof effect.disposer === 'function') effect.disposer()
}
fs.rmSync(scratch, { recursive: true, force: true })
console.log('ALL HOST TESTS PASSED')
