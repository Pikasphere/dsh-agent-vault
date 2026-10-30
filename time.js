// Relative-time lint for memory writes.
//
// A note that says "今天" is unreadable a month later. Every entry carries an
// `at` timestamp, but the prose does not, and the reader — a human in the panel,
// or the agent itself months on — has nothing to resolve the word against.
//
// The host has no model, so it cannot rewrite the text. What it can do is notice
// the problem and say so in the tool result the model is about to read, while
// the write still succeeds: refusing a write loses information, a hint can
// still be acted on at the next step.

/** Words that point at a day relative to the moment of writing. */
export const RELATIVE_WORDS = [
  '今天',
  '昨天',
  '明天',
  '前天',
  '后天',
  '大前天',
  '大后天',
  '今早',
  '今晚',
  '昨晚',
  '上周',
  '这周',
  '本周',
  '下周',
  '上上周',
  '下下周',
  '上个月',
  '这月',
  '下个月',
  '今年',
  '去年',
  '明年',
]

// Any of these already anchors the sentence in time. ISO dates are the form we
// ask for; "10月30日" without a year is weaker but still usually resolvable
// against the entry date, so it counts as anchored.
const ANCHOR = /(\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}[日号])/

/** The relative words present in `text`, in list order, de-duplicated, capped. */
export function relativeWords(text, max = 3) {
  const body = String(text ?? '')
  if (body === '') return []
  const found = []
  for (const word of RELATIVE_WORDS) {
    if (body.includes(word) && !found.includes(word)) found.push(word)
    if (found.length >= max) break
  }
  return found
}

/** Local calendar date, the anchor we ask the model to write. */
export function todayStamp(now = Date.now()) {
  const date = new Date(now)
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * A hint for the tool result, or null when the text needs no repair.
 *
 * Deliberately narrow: only day-relative words, and only when nothing in the
 * text already pins a date. "最近"、"目前" are not flagged — they are often the
 * honest level of precision.
 */
export function timeHint(text, now = Date.now()) {
  const body = String(text ?? '')
  if (body === '' || ANCHOR.test(body)) return null
  const words = relativeWords(body)
  if (words.length === 0) return null
  const stamp = todayStamp(now)
  return (
    `注：正文含相对时间（${words.join('、')}）但没有绝对日期，几周后读者无法还原。` +
    `建议写上具体日期，如「${stamp} 下午」，再追加一条即可（本条已保存）。`
  )
}

/** Attach the hint to a write result only when one is warranted. */
export function withTimeHint(result, text, now = Date.now()) {
  const hint = timeHint(text, now)
  return hint === null ? result : { ...result, timeHint: hint }
}
