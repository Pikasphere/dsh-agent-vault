/**
 * Throwaway helper: list note ids + titles for authoring eval cases.
 *   node eval/dump-notes.mjs [--dir <memoryDir>] [--agent <agentId>]
 */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const load = name => import(`file://${path.join(here, '..', name).replace(/\\/g, '/')}`)
const { createStore } = await load('store.js')
const { createJournals } = await load('journal.js')

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? '' : String(argv[at + 1] ?? '')
}
const memoryDir = flag('dir') || process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), '.dsh', 'agent-memory')
const agentId = flag('agent') || 'demo-agent'

const store = createStore({ rootDir: memoryDir })
const journals = createJournals({ rootDir: store.root })
for (const note of journals.notes(agentId)) {
  console.log(`${note.id}\t${note.title}\t${note.text.replace(/\s+/g, ' ').slice(0, 180)}`)
}
