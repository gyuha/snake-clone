/** PRD §15.2: 첫 화면에서 정적으로 로드되는 JS gzip 예산을 검증한다. */
import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const assets = path.resolve('apps/web/dist/assets');
const limit = 500 * 1024;
const files = await readdir(assets);
const entry = files.find((file) => /^index-[A-Za-z0-9_-]+\.js$/.test(file));
if (!entry) throw new Error('web build entry asset not found; run pnpm build first');

const visited = new Set();
async function collect(file) {
  if (visited.has(file)) return 0;
  visited.add(file);
  const source = await readFile(path.join(assets, file));
  const text = source.toString('utf8');
  let total = gzipSync(source).byteLength;
  // Vite의 정적 ESM import만 따른다. dynamic import와 modulepreload map은 첫 화면 예산에서 제외한다.
  for (const match of text.matchAll(/\bfrom"\.\/([^"/]+\.js)"/g)) total += await collect(match[1]);
  return total;
}

const bytes = await collect(entry);
console.log(`[web-budget] initial static JS gzip ${(bytes / 1024).toFixed(1)}KB / ${(limit / 1024).toFixed(0)}KB (${[...visited].join(', ')})`);
if (bytes > limit) throw new Error(`initial static JS gzip budget exceeded: ${bytes} > ${limit}`);
