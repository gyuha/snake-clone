/** PRD §10.4: 배포할 정적 자산의 version/hash/size manifest를 검증한다. */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve('apps/web/public');
const manifest = JSON.parse(await readFile(path.join(root, 'assets-manifest.json'), 'utf8'));
if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(manifest.version) || !Array.isArray(manifest.assets) || manifest.assets.length === 0) {
  throw new Error('assets manifest requires a version and at least one asset');
}
const serviceWorker = await readFile(path.join(root, 'sw.js'), 'utf8');
if (!serviceWorker.includes(`serpent-arena-shell-${manifest.version}`)) {
  throw new Error('service worker cache key must include the assets manifest version');
}
for (const asset of manifest.assets) {
  if (!asset || typeof asset.path !== 'string' || !asset.path.startsWith('/') || typeof asset.bytes !== 'number' || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
    throw new Error('invalid asset manifest entry');
  }
  const file = path.resolve(root, `.${asset.path}`);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error(`asset path escapes public root: ${asset.path}`);
  const [contents, metadata] = await Promise.all([readFile(file), stat(file)]);
  const hash = createHash('sha256').update(contents).digest('hex');
  if (metadata.size !== asset.bytes || hash !== asset.sha256) throw new Error(`asset manifest mismatch: ${asset.path}`);
}
console.log(`[assets] manifest ${manifest.version} verified (${manifest.assets.length} assets)`);
