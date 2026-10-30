import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const MAX_TOKENS = 512;
const CLS = '[CLS]';
const SEP = '[SEP]';
const UNK = '[UNK]';
const PAD = '[PAD]';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;

function isSpace(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\v' || ch === '\u00a0';
}

function isAlnum(ch) {
  return /[0-9a-zA-Z\u00c0-\u024f]/.test(ch);
}

/** BertTokenizer 的 basic 分词：空白与标点断开，CJK 逐字，保留大小写（本模型 do_lower_case=false）。 */
export function basicTokenize(text) {
  const words = [];
  let buf = '';
  const flush = () => {
    if (buf) { words.push(buf); buf = ''; }
  };
  for (const ch of String(text)) {
    if (isSpace(ch)) { flush(); continue; }
    if (CJK.test(ch)) { flush(); words.push(ch); continue; }
    if (isAlnum(ch)) { buf += ch; continue; }
    flush();
    words.push(ch);
  }
  flush();
  return words;
}

/** 贪心最长匹配的 WordPiece，匹配不到返回 null（调用方换成 [UNK]）。 */
export function wordPiece(token, vocab) {
  if (vocab.has(token)) return [vocab.get(token)];
  const pieces = [];
  let start = 0;
  while (start < token.length) {
    let end = token.length;
    let hit = null;
    while (start < end) {
      const sub = token.slice(start, end);
      const candidate = start > 0 ? `##${sub}` : sub;
      if (vocab.has(candidate)) { hit = candidate; break; }
      end -= 1;
    }
    if (!hit) return null;
    pieces.push(vocab.get(hit));
    start = end;
  }
  return pieces;
}

export function loadVocab(modelDir) {
  const file = path.join(modelDir, 'vocab.txt');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const vocab = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const token = lines[i].replace(/\r$/, '');
    if (token) vocab.set(token, i);
  }
  return vocab;
}

export function encode(text, vocab, limit = MAX_TOKENS) {
  const ids = [vocab.get(CLS)];
  const budget = Math.max(1, limit - 2);
  let used = 0;
  for (const word of basicTokenize(text)) {
    if (used >= budget) break;
    const pieces = wordPiece(word, vocab) ?? [vocab.get(UNK)];
    for (const id of pieces) {
      if (used >= budget) break;
      ids.push(id);
      used += 1;
    }
  }
  ids.push(vocab.get(SEP));
  return ids;
}

function l2Normalize(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/**
 * 本地 BGE 小模型 embedder。模型目录需含 vocab.txt 与 onnx/*.onnx（默认 model_quantized.onnx）。
 * 只做一件事：把文本变成归一化后的 512 维向量（CLS pooling）。
 */
export const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

export function createEmbedder({ modelDir, modelFile = 'onnx/model_quantized.onnx', threads = 2, batchSize = 8, queryPrefix = QUERY_PREFIX } = {}) {
  if (!modelDir) throw new Error('model-dir-required');
  const modelPath = path.join(modelDir, modelFile);
  if (!fs.existsSync(modelPath)) throw new Error(`model-missing: ${modelPath}`);
  const vocab = loadVocab(modelDir);
  const ort = require('onnxruntime-node');
  let session = null;
  let dim = 0;

  async function load() {
    if (session) return session;
    session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: threads, interOpNumThreads: 1 });
    return session;
  }

  async function embedBatch(texts) {
    const s = await load();
    const rows = texts.map((text) => encode(text, vocab));
    const width = Math.max(...rows.map((ids) => ids.length));
    const count = rows.length;
    const ids = new BigInt64Array(count * width);
    const mask = new BigInt64Array(count * width);
    const types = new BigInt64Array(count * width);
    const padId = BigInt(vocab.get(PAD) ?? 0);
    for (let r = 0; r < count; r += 1) {
      const row = rows[r];
      for (let c = 0; c < width; c += 1) {
        const at = r * width + c;
        if (c < row.length) {
          ids[at] = BigInt(row[c]);
          mask[at] = 1n;
        } else {
          ids[at] = padId;
          mask[at] = 0n;
        }
      }
    }
    const feeds = {
      input_ids: new ort.Tensor('int64', ids, [count, width]),
      attention_mask: new ort.Tensor('int64', mask, [count, width]),
      token_type_ids: new ort.Tensor('int64', types, [count, width]),
    };
    const output = await s.run(feeds);
    const hidden = output.last_hidden_state ?? output[s.outputNames[0]];
    if (!hidden) throw new Error('no-hidden-state');
    dim = hidden.dims[2];
    const [batch, seqLen, hiddenDim] = hidden.dims;
    const data = hidden.data;
    const vectors = [];
    for (let r = 0; r < batch; r += 1) {
      const start = r * seqLen * hiddenDim;
      const cls = new Float32Array(hiddenDim);
      for (let i = 0; i < hiddenDim; i += 1) cls[i] = data[start + i];
      vectors.push(l2Normalize(cls));
    }
    return vectors;
  }

  return {
    modelPath,
    get dim() { return dim; },
    load,
    async embed(texts) {
      const list = Array.isArray(texts) ? texts : [texts];
      const out = [];
      for (let i = 0; i < list.length; i += batchSize) {
        out.push(...await embedBatch(list.slice(i, i + batchSize)));
      }
      return out;
    },
    /**
     * BGE is trained with an instruction on the *query* side only; documents are
     * embedded plain. Keep the two paths separate so a prefix can never leak
     * into the vector store.
     */
    async embedOne(text) {
      const [vector] = await embedBatch([`${queryPrefix}${text}`]);
      return vector;
    },
    async embedQuery(text) {
      return this.embedOne(text);
    },
    async embedDocument(text) {
      const [vector] = await embedBatch([text]);
      return vector;
    },
  };
}

export function cosine(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}
