// Split a concatenated-zstd buffer (DSH session files append one frame per record) into frames.
// Node's zstdDecompressSync only decodes the first frame, so we walk the frame/block headers.

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function frameEnd(buf, start) {
  if (start + 4 > buf.length) return -1
  if (!buf.subarray(start, start + 4).equals(MAGIC)) return -1
  let at = start + 4
  if (at >= buf.length) return -1
  const fhd = buf[at]
  at += 1
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!singleSegment) {
    at += 1 // window descriptor
  }
  at += dictFlag === 1 ? 1 : dictFlag === 2 ? 2 : dictFlag === 3 ? 4 : 0
  // Frame_Content_Size: flag 0 = absent, except that single-segment frames always carry 1 byte.
  at += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  for (;;) {
    if (at + 3 > buf.length) return -1
    const header = buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16)
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >>> 3
    at += 3
    if (type === 1) at += 1
    else if (type === 2) at += size
    else if (type === 0) at += size
    else return -1
    if (last) break
  }
  if (checksum) at += 4
  return at > buf.length ? -1 : at
}

/** Decompress every frame in `buf` to one Buffer (records concatenated in order). */
export function decompressFrames(buf, decompress) {
  const parts = []
  let at = 0
  while (at < buf.length) {
    if (buf.length - at < 4 || !buf.subarray(at, at + 4).equals(MAGIC)) break
    const end = frameEnd(buf, at)
    if (end < 0 || end <= at) break
    const chunk = decompress(buf.subarray(at, end))
    if (chunk.length > 0) parts.push(chunk)
    at = end
  }
  return Buffer.concat(parts)
}
