/** Relative-time lint: the rule ships in tool descriptions, the hint in results. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { timeHint, relativeWords, todayStamp, withTimeHint, RELATIVE_WORDS } = await import(
  `file://${path.join(here, 'time.js').replace(/\\/g, '/')}`
)

const now = Date.UTC(2026, 9, 30, 4, 0, 0) // 2026-10-30 in the writer's zone

// ── detection ───────────────────────────────────────────────────────────────
assert.deepEqual(relativeWords('今天下午把 vectors.js 的分块改完了'), ['今天'])
assert.deepEqual(relativeWords('昨天和上周都在调 minCosine'), ['昨天', '上周'])
assert.deepEqual(relativeWords('Nothing relative here at all'), [])
assert.deepEqual(relativeWords(''), [])
assert.deepEqual(relativeWords(null), [])
// de-duplicated, capped
assert.deepEqual(relativeWords('今天 今天 昨天 明天 后天 大后天', 3), ['今天', '昨天', '明天'])

// ── hint or silence ─────────────────────────────────────────────────────────
const hint = timeHint('今天下午把分块嵌入接完了', now)
assert.ok(hint !== null)
assert.match(hint, /今天/)
assert.match(hint, new RegExp(todayStamp(now)))
assert.match(hint, /已保存/) // never implies the write failed

// an anchored date needs no repair
assert.equal(timeHint('2026-10-30 下午把分块嵌入接完了', now), null)
assert.equal(timeHint('10月30日 下午把分块嵌入接完了', now), null)
assert.equal(timeHint('在 2026/10/30 改了分块', now), null)

// no relative word, no hint
assert.equal(timeHint('把 vectors.js 的 chunkChars 改成 420', now), null)
assert.equal(timeHint('', now), null)
assert.equal(timeHint(null, now), null)

// deliberately not flagged: honest vagueness
assert.equal(timeHint('最近这套检索基本到头了', now), null)
assert.equal(timeHint('目前用的是 bge-small-zh-v1.5', now), null)

// ── attaching to a result ───────────────────────────────────────────────────
const saved = { ok: true, id: 'j-ab12', chars: 12 }
assert.deepEqual(withTimeHint(saved, '把接口拆开了', now), saved) // no field added
const hinted = withTimeHint(saved, '昨天把接口拆开了', now)
assert.equal(hinted.ok, true)
assert.equal(hinted.id, 'j-ab12')
assert.ok(typeof hinted.timeHint === 'string')
assert.notEqual(hinted, saved) // never mutates the caller's object

// ── the word table itself ───────────────────────────────────────────────────
assert.ok(RELATIVE_WORDS.includes('今天') && RELATIVE_WORDS.includes('下个月'))
// no bare single characters, which would flag half the corpus
assert.ok(RELATIVE_WORDS.every(word => word.length >= 2))

// ── todayStamp ──────────────────────────────────────────────────────────────
assert.match(todayStamp(now), /^\d{4}-\d{2}-\d{2}$/)

// ── the tools carry the rule ────────────────────────────────────────────────
const index = fs.readFileSync(path.join(here, 'index.js'), 'utf8')
assert.match(index, /const TIME_RULE =/)
assert.match(index, /YYYY-MM-DD/)
// every write tool references the shared constant
assert.equal((index.match(/\$\{TIME_RULE\}/g) ?? []).length, 3)
// and every write path runs its text through the lint
assert.equal((index.match(/withTimeHint\(/g) ?? []).length, 3)

console.log('ALL TIME TESTS PASSED')
