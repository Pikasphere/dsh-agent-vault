/**
 * Lexical ranking for recall.
 *
 * Pure functions over plain entry objects (`{id, at, title, text, tags, src}`),
 * so they can be unit-tested without a filesystem and reused by any source.
 *
 * The scoring rule has three parts, each with a reason:
 *   - weighted hits: a title match or a tag match says more than an occurrence
 *     buried in a long body, and body occurrences saturate so one repetitive
 *     note cannot dominate;
 *   - coverage: `matched / tokens` squared. A note that covers two of three
 *     query terms is worth roughly two-thirds of one that covers all three —
 *     the squaring makes a partial match fall off faster than linearly;
 *   - time decay: half-life of 30 days. A fresh note that half-matches beats a
 *     stale note that matches perfectly, which is the behaviour the journal
 *     sections were designed around.
 *
 * Chinese has no word boundaries, so CJK runs are indexed as character bigrams
 * and matched by substring; that needs no dictionary and degrades gracefully.
 * ASCII words are matched whole, keeping identifiers such as `dsh-agent-vault`
 * or `j-ab12` intact.
 *
 * @module rank
 */

/** Identifier-ish ASCII words; the hyphen is part of the word on purpose. */
const ASCII_WORD = /[a-z0-9][a-z0-9_.-]*/g
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

export const WEIGHT = { title: 6, tags: 4, bodyCap: 40 }
export const HALF_LIFE_DAYS = 30

/** Filler that would otherwise match almost everything in this corpus. */
export const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'were', 'was', 'are', 'not',
  'but', 'you', 'can', 'all', 'has', 'had', 'have', 'one', 'two', 'out', 'its', 'our',
  '的', '了', '是', '在', '和', '与', '也', '就', '都', '而', '及', '或', '对', '中',
  '上', '下', '一个', '可以', '这个', '那个', '我们', '你们', '他们', '然后', '因为',
  '所以', '但是', '如果', '就是', '已经', '还是', '不是', '没有', '需要', '现在',
])

function countOf(haystack, needle) {
  let hits = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    hits += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return hits
}

/**
 * Lowercase tokens, de-duplicated, in query order.
 *
 * ASCII words shorter than two characters are dropped (`a`, `x`); CJK runs are
 * also indexed as single characters when the run is one character long, so a
 * query of `图` still finds something.
 */
export function tokenize(text) {
  const raw = String(text ?? '').toLowerCase()
  const tokens = []
  const seen = new Set()
  const push = token => {
    if (token.length < 2 || STOP.has(token) || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }
  for (const match of raw.matchAll(ASCII_WORD)) push(match[0])
  for (const match of raw.matchAll(CJK_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      push(run)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) push(run.slice(index, index + 2))
  }
  return tokens
}

/** Weighted hit count for one entry; 0 means "does not match at all". */
export function scoreEntry(entry, tokens) {
  if (tokens.length === 0) return 0
  const title = String(entry?.title ?? '').toLowerCase()
  const tagText = (Array.isArray(entry?.tags) ? entry.tags.join(' ') : String(entry?.tags ?? '')).toLowerCase()
  const body = String(entry?.text ?? entry?.body ?? '').toLowerCase()
  let hit = 0
  let matched = 0
  for (const token of tokens) {
    let local = 0
    if (title.includes(token)) local += WEIGHT.title
    if (tagText !== '' && tagText.includes(token)) local += WEIGHT.tags
    if (body !== '') local += Math.min(countOf(body, token), WEIGHT.bodyCap)
    if (local > 0) matched += 1
    hit += local
  }
  if (hit === 0) return 0
  const coverage = matched / tokens.length
  return hit * coverage * coverage
}

/** 0..1 by age; an unparseable timestamp is treated as half-old, not as fresh. */
export function decay(at, now = Date.now(), halfLifeDays = HALF_LIFE_DAYS) {
  const time = Date.parse(String(at ?? ''))
  if (!Number.isFinite(time)) return 0.5
  const days = Math.max(0, now - time) / 86400000
  return Math.pow(0.5, days / halfLifeDays)
}

/**
 * Score and order every matching entry. The caller slices; keeping the whole
 * list here lets a caller report `total` and a baseline test assert order.
 */
export function rank(entries, query, options = {}) {
  const now = Number(options.now) || Date.now()
  const boost = options.boost ?? (() => 1)
  const tokens = tokenize(query)
  const rows = []
  for (const entry of entries) {
    const src = String(entry?.src ?? '')
    if (boost(src) === 0) continue
    const raw = tokens.length === 0 ? 0 : scoreEntry(entry, tokens)
    if (tokens.length > 0 && raw === 0) continue
    const score = tokens.length === 0 ? 0 : raw * decay(entry?.at, now) * boost(src)
    // A sub-microscopic score is noise; dropping it keeps results honest.
    if (score < 1e-6) continue
    rows.push({ entry, score })
  }
  rows.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    const a = Date.parse(String(left.entry?.at ?? ''))
    const b = Date.parse(String(right.entry?.at ?? ''))
    return (Number.isFinite(b) ? b : 0) - (Number.isFinite(a) ? a : 0)
  })
  return rows
}

export function round(score, digits = 4) {
  const factor = Math.pow(10, digits)
  return Math.round(score * factor) / factor
}

/** One-line preview of a body, for tool output. */
export function preview(text, size = 160) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= size ? flat : `${flat.slice(0, size - 1)}…`
}
