/** Room mention dispatch: @member wakes that agent's conversation with the room context. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createRooms } = await import(`file://${path.join(here, 'rooms.js').replace(/\\/g, '/')}`)
const { createRoomDispatch } = await import(`file://${path.join(here, 'team', 'room-dispatch.js').replace(/\\/g, '/')}`)

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-room-dispatch-'))
const rooms = createRooms({ rootDir: path.join(scratch, 'mem') })
const agents = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'beta', name: 'Beta' },
  { id: 'alphabet', name: 'Alphabet' },
  { id: 'gamma', name: 'Gamma' },
]
const store = { state: () => ({ vaults: agents }) }
const delivered = []
const dispatch = {
  deliver: async (agentId, delivery) => {
    delivered.push({ agentId, ...delivery })
    return { delivered: true, sessionId: `sess-${agentId}` }
  },
}
const roomDispatch = createRoomDispatch({ rooms, store, dispatch })

const room = rooms.create({ name: '架构评审' })
for (const member of ['alpha', 'beta', 'alphabet']) rooms.join({ id: room.id, member })
rooms.say({ id: room.id, text: '先定存储层', from: { kind: 'agent', id: 'alpha', name: 'Alpha' } })

// ── a person's message mentioning members wakes exactly those members ──────
const spoke = await roomDispatch.say({
  id: room.id,
  text: '请 @Alpha 和 @beta 看一下；@gamma 不是成员，不要叫它',
  from: { kind: 'user', id: 'user', name: '我' },
})
assert.deepEqual(spoke.dispatched, ['alpha', 'beta'])
assert.deepEqual(spoke.failed, [])
assert.equal(delivered.length, 2)
assert.equal(delivered[0].id, `vault-room:${room.id}:${spoke.message.id}:alpha`)
assert.equal(delivered[1].id, `vault-room:${room.id}:${spoke.message.id}:beta`)
assert.match(delivered[0].text, /\[Room "架构评审"/)
assert.match(delivered[0].text, /\[Recent transcript\]/, 'the earlier room message travels with the task')
assert.match(delivered[0].text, /Alpha: 先定存储层/)

// the stored message records the reach, so a reload shows it
const stored = rooms.read({ id: room.id }).messages.find(item => item.id === spoke.message.id)
assert.deepEqual(stored.dispatched, ['alpha', 'beta'])
assert.equal(stored.text.includes('@gamma'), true, 'non-members stay in the text but are not woken')

// ── mention parsing: longest name wins, quotes dedupe ───────────────────────
assert.deepEqual(
  roomDispatch.mentions(rooms.requireRoom(room.id), '给 @Alphabet 和 @alpha 的活').map(row => row.id),
  ['alphabet', 'alpha'],
)
assert.deepEqual(roomDispatch.mentions(rooms.requireRoom(room.id), '@alpha @Alpha @beta').map(row => row.id), ['alpha', 'beta'])

// ── an agent speaking never wakes another agent (no mention ping-pong) ─────
const before = delivered.length
const agentSpoke = await roomDispatch.say({
  id: room.id,
  text: '@beta 你觉得呢',
  from: { kind: 'agent', id: 'alpha', name: 'Alpha' },
})
assert.deepEqual(agentSpoke.dispatched, [])
assert.equal(delivered.length, before)

// ── a host without the inbox API reports failure instead of lying ──────────
const degraded = createRoomDispatch({ rooms, store, dispatch: undefined })
const degradedSay = await degraded.say({
  id: room.id,
  text: '@beta 检查一下',
  from: { kind: 'user', id: 'user', name: '我' },
})
assert.equal(degradedSay.unsupported, true)
assert.deepEqual(degradedSay.dispatched, [])
assert.deepEqual(degradedSay.failed, ['beta'])

fs.rmSync(scratch, { recursive: true, force: true })

// ── a team's room: an unaddressed message goes to the lead ────────────────
const teamRoom = rooms.create({ name: '团队讨论室' })
for (const member of ['alpha', 'beta', 'gamma']) rooms.join({ id: teamRoom.id, member })
delivered.length = 0
const leadDispatch = createRoomDispatch({
  rooms,
  store,
  dispatch,
  team: {
    listProjects: () => [
      { id: 'p-1', name: 'Alpha 队', lead: 'alpha', members: ['beta'], roomId: teamRoom.id, status: 'active' },
      { id: 'p-old', name: '旧队', lead: 'gamma', members: [], roomId: teamRoom.id, status: 'archived' },
    ],
  },
})
const handed = await leadDispatch.say({
  id: teamRoom.id,
  text: '把登录页拆一下，周末前做完',
  from: { kind: 'user', id: 'user', name: '我' },
})
assert.deepEqual(handed.dispatched, ['alpha'], 'the active project lead receives it')
assert.equal(handed.failed.length, 0)
assert.match(delivered[0].text, /You are the lead of team "Alpha 队"/)
assert.match(delivered[0].text, /team_task_create \(project=p-1/)
assert.match(delivered[0].text, /members are: alpha, beta/)

// mentioning someone still routes only to them, not to the lead
delivered.length = 0
const mentioned = await leadDispatch.say({
  id: teamRoom.id,
  text: '@beta 看一下',
  from: { kind: 'user', id: 'user', name: '我' },
})
assert.deepEqual(mentioned.dispatched, ['beta'])

// an agent's own message never wakes anyone, lead or member
delivered.length = 0
await leadDispatch.say({
  id: teamRoom.id,
  text: '收到，拆分中',
  from: { kind: 'agent', id: 'alpha', name: 'Alpha' },
})
assert.deepEqual(delivered, [])

console.log('ALL ROOM DISPATCH TESTS PASSED')
