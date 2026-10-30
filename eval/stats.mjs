/**
 * Statistics shared by the eval scripts.
 *
 * A point estimate over a few dozen queries is not a measurement of a
 * parameter: the 95 % interval on MRR with 45 cases over 24 notes is roughly
 * ±0.13. Resampling is therefore **by note**, not by query — the queries are
 * 1–3 phrasings of the same notes, and treating them as independent cases would
 * understate the interval. Seeded, so two runs print the same numbers.
 */

export const BOOT = 4000

export const makeRandom = seed => {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 4294967296
  }
}

/** Mean of `values` resampled in clusters; returns the 2.5 / 97.5 percentiles. */
export function clusterBootstrap(values, clusters, seed = 0x9e3779b9) {
  const rnd = makeRandom(seed ^ values.length)
  const cells = new Map()
  values.forEach((value, index) => {
    const key = clusters[index]
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(value)
  })
  const units = [...cells.values()]
  const draws = []
  for (let round = 0; round < BOOT; round += 1) {
    let sum = 0
    let count = 0
    for (let pick = 0; pick < units.length; pick += 1) {
      const cell = units[Math.floor(rnd() * units.length)]
      for (const value of cell) sum += value
      count += cell.length
    }
    draws.push(sum / count)
  }
  draws.sort((a, b) => a - b)
  return { lo: draws[Math.floor(0.025 * BOOT)], hi: draws[Math.floor(0.975 * BOOT)] }
}

/** Paired interval: resample the per-item *differences*, so shared noise cancels. */
export function pairedInterval(before, after, clusters) {
  const diffs = after.map((value, index) => value - before[index])
  return { band: clusterBootstrap(diffs, clusters), mean: diffs.reduce((sum, value) => sum + value, 0) / diffs.length }
}

export const fade = ({ lo, hi }) => `[${lo.toFixed(3)}, ${hi.toFixed(3)}]`

export const pct = value => `${value.toFixed(1)}%`

/** Rank -> 0/1 indicator, the unit top-1 intervals are built from. */
export const top1Of = result => result.rr.map(value => (value === 1 ? 1 : 0))
