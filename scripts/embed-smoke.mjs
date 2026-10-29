#!/usr/bin/env node
/**
 * 冒烟测试：加载本地 BGE 小模型，嵌几句话，看相似度与耗时。
 * 用法：node scripts/embed-smoke.mjs [模型目录]
 * 模型默认在 <agent-memory>/models/bge-small-zh-v1.5，可用第一个参数覆盖。
 */
import os from 'node:os';
import path from 'node:path';
import { createEmbedder, cosine } from '../embed.js';

const modelDir = process.argv[2] || path.join(os.homedir(), '.dsh', 'agent-memory', 'models', 'bge-small-zh-v1.5');

const t0 = Date.now();
const embedder = createEmbedder({ modelDir });
await embedder.load();
const loadMs = Date.now() - t0;

const docs = [
  '归档插件现在支持右键菜单，可以把会话归档、取消归档或转化为强归档。',
  '右键选中会话后可以直接把它收进 vault，也可以新建一个对话。',
  '桌宠的 106 段动画在仓库里缺失，小鲸鱼形态不受影响。',
];

const t1 = Date.now();
const vectors = await embedder.embed(docs);
const embedMs = Date.now() - t1;

const queries = [
  '存档了没',
  '那个鲸鱼摆件',
];

console.log(`model      ${embedder.modelPath}`);
console.log(`load       ${loadMs} ms`);
console.log(`dim        ${embedder.dim}`);
console.log(`embed      ${embedMs} ms / ${docs.length} 条`);

for (const query of queries) {
  const qv = await embedder.embedOne(query);
  const scored = vectors
    .map((vector, index) => ({ index, score: cosine(qv, vector) }))
    .sort((a, b) => b.score - a.score);
  console.log(`\nquery 「${query}」`);
  for (const row of scored) console.log(`  ${row.score.toFixed(4)}  ${docs[row.index].slice(0, 28)}…`);
}

const related = cosine(vectors[0], vectors[1]);
const unrelated = cosine(vectors[0], vectors[2]);
console.log(`\nrelated pair ${related.toFixed(4)}  unrelated pair ${unrelated.toFixed(4)}`);
if (!(related > unrelated + 0.05)) {
  console.error('FAIL: 语义区分度不足');
  process.exit(1);
}
console.log('OK');
