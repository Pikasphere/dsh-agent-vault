/**
 * Discussion rooms: a shared, append-only transcript that several agents join.
 *
 * A room is user-created and user-managed. Members are agent ids; any of them
 * may read the transcript and speak, and a member may join late or leave at any
 * time. Messages keep the speaker so a transcript stays attributable.
 *
 * Layout:
 *   <root>/rooms/<roomId>/room.json        name, members, createdAt
 *   <root>/rooms/<roomId>/messages.jsonl   one JSON message per line
 *
 * @module rooms
 */

import fs from 'node:fs'
import path from 'node:path'

import { MemoryError } from './store.js'

const ROOM_ID = /^r-[a-z0-9]{4,12}$/
const MAX_TEXT = 20000

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

function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

export function createRooms(options = {}) {
  const root = path.resolve(options.rootDir || '.')
  const dir = path.join(root, 'rooms')

  function roomFile(id) {
    return path.join(dir, id, 'room.json')
  }

  function messagesFile(id) {
    return path.join(dir, id, 'messages.jsonl')
  }

  function requireRoom(id) {
    const key = String(id ?? '')
    if (!ROOM_ID.test(key)) throw new MemoryError('bad-room', `invalid room id: ${key || '(empty)'}`)
    const room = readJson(roomFile(key), undefined)
    if (room === undefined) throw new MemoryError('no-room', `unknown room: ${key}`)
    return room
  }

  function readMessages(id) {
    let raw = ''
    try {
      raw = fs.readFileSync(messagesFile(id), 'utf8')
    } catch {
      return []
    }
    const list = []
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim()
      if (text === '') continue
      try {
        list.push(JSON.parse(text))
      } catch {
        /* a torn line is skipped, never fatal */
      }
    }
    return list
  }

  function save(room) {
    writeAtomic(roomFile(room.id), `${JSON.stringify(room, null, 2)}\n`)
  }

  function list() {
    let names = []
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const rooms = []
    for (const entry of names) {
      if (!entry.isDirectory() || !ROOM_ID.test(entry.name)) continue
      const room = readJson(roomFile(entry.name), undefined)
      if (room === undefined) continue
      const messages = readMessages(room.id)
      const last = messages.length > 0 ? messages[messages.length - 1] : undefined
      rooms.push({
        id: room.id,
        name: room.name,
        createdAt: room.createdAt,
        members: Array.isArray(room.members) ? room.members : [],
        count: messages.length,
        lastAt: last?.at ?? '',
        lastPreview: last?.text ? collapse(last.text).slice(0, 90) : '',
      })
    }
    rooms.sort((a, b) => String(b.lastAt || b.createdAt).localeCompare(String(a.lastAt || a.createdAt)))
    return rooms
  }

  function create(input = {}) {
    const name = collapse(input.name).slice(0, 80) || '讨论室'
    let id = `r-${Math.random().toString(36).slice(2, 6)}`
    while (fs.existsSync(path.join(dir, id))) id = `r-${Math.random().toString(36).slice(2, 6)}`
    const room = { id, name, createdAt: new Date().toISOString(), members: [] }
    save(room)
    fs.mkdirSync(path.join(dir, id), { recursive: true })
    return room
  }

  function rename(input = {}) {
    const room = requireRoom(input.id)
    const name = collapse(input.name).slice(0, 80)
    if (name === '') throw new MemoryError('bad-room', 'room name must not be empty')
    const next = { ...room, name }
    save(next)
    return next
  }

  function remove(input = {}) {
    const room = requireRoom(input.id)
    try {
      fs.rmSync(path.join(dir, room.id), { recursive: true, force: true })
    } catch {
      /* already gone */
    }
    return { removed: room.id }
  }

  function setMembers(input = {}) {
    const room = requireRoom(input.id)
    const wanted = Array.isArray(input.members) ? input.members.map(item => String(item ?? '')).filter(Boolean) : []
    const next = { ...room, members: [...new Set(wanted)] }
    save(next)
    return next
  }

  function join(input = {}) {
    const room = requireRoom(input.id)
    const member = String(input.member ?? '')
    if (member === '') throw new MemoryError('bad-member', 'member id required')
    const members = Array.isArray(room.members) ? room.members : []
    if (members.includes(member)) return room
    const next = { ...room, members: [...members, member] }
    save(next)
    return next
  }

  function leave(input = {}) {
    const room = requireRoom(input.id)
    const member = String(input.member ?? '')
    const members = (Array.isArray(room.members) ? room.members : []).filter(item => item !== member)
    const next = { ...room, members }
    save(next)
    return next
  }

  function read(input = {}) {
    const room = requireRoom(input.id)
    const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 200)
    const messages = readMessages(room.id)
    return {
      room: { id: room.id, name: room.name, members: Array.isArray(room.members) ? room.members : [], createdAt: room.createdAt },
      total: messages.length,
      messages: messages.slice(-limit),
    }
  }

  /** Attach derived facts to one stored message (its own fields stay fixed). */
  function annotate(input = {}) {
    const room = requireRoom(input.id)
    const target = String(input.message ?? '')
    const patch = input.patch !== null && typeof input.patch === 'object' ? input.patch : {}
    let raw = ''
    try {
      raw = fs.readFileSync(messagesFile(room.id), 'utf8')
    } catch {
      return undefined
    }
    let changed = false
    const lines = raw
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => {
        try {
          const item = JSON.parse(line)
          if (item.id !== target) return line
          for (const [key, value] of Object.entries(patch)) {
            if (key === 'id' || key === 'at' || key === 'from' || key === 'text') continue
            item[key] = value
          }
          changed = true
          return JSON.stringify(item)
        } catch {
          return line
        }
      })
    if (changed) writeAtomic(messagesFile(room.id), `${lines.join('\n')}\n`)
    return readMessages(room.id).find(item => item.id === target)
  }

  function say(input = {}) {
    const room = requireRoom(input.id)
    const text = String(input.text ?? '').replace(/\r\n/g, '\n').trim()
    if (text === '') throw new MemoryError('empty-message', 'message must not be empty')
    if (text.length > MAX_TEXT) throw new MemoryError('message-too-long', `message is ${text.length} characters; the limit is ${MAX_TEXT}`)
    const from = input.from && typeof input.from === 'object' ? input.from : { kind: 'user', id: 'user', name: '我' }
    const message = {
      id: `m-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      at: new Date().toISOString(),
      from: { kind: String(from.kind ?? 'user'), id: String(from.id ?? ''), name: collapse(from.name) || String(from.id ?? '') },
      text,
    }
    // Callers may attach derived facts (such as the agents a mention reached);
    // the transcript's own fields are never overridable.
    const extra = input.extra !== null && typeof input.extra === 'object' ? input.extra : {}
    for (const [key, value] of Object.entries(extra)) {
      if (key === 'id' || key === 'at' || key === 'from' || key === 'text') continue
      message[key] = value
    }
    fs.appendFileSync(messagesFile(room.id), `${JSON.stringify(message)}\n`, 'utf8')
    return message
  }

  function clear(input = {}) {
    const room = requireRoom(input.id)
    writeAtomic(messagesFile(room.id), '')
    return { cleared: room.id }
  }

  return { root, dir, list, create, rename, remove, setMembers, join, leave, read, say, annotate, clear, requireRoom }
}
