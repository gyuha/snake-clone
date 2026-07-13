import { execFileSync } from 'node:child_process';

const allowed = new Set(['0BSD', 'Apache-2', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'BlueOak-1.0.0', 'CC-BY-4.0', 'ISC', 'MIT', 'Python-2.0']);
const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], { encoding: 'utf8' });
const grouped = JSON.parse(raw);
const unknown = Object.keys(grouped).filter((license) => !allowed.has(license));
if (unknown.length > 0) {
  process.stderr.write(`[dependency-policy] unapproved licenses: ${unknown.join(', ')}\n`);
  process.exit(1);
}
const packages = Object.values(grouped).flat();
if (packages.length === 0) {
  process.stderr.write('[dependency-policy] no installed packages found; run pnpm install first\n');
  process.exit(1);
}
process.stdout.write(`[dependency-policy] ${packages.length} package records use approved licenses\n`);
