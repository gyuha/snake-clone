import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], { encoding: 'utf8' });
const grouped = JSON.parse(raw);
const components = Object.entries(grouped)
  .flatMap(([license, packages]) => packages.map((pkg) => ({
    type: 'library', name: pkg.name, version: pkg.versions.join(','),
    licenses: [{ license: { id: license } }], author: pkg.author || undefined, homepage: pkg.homepage || undefined,
  })))
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
const document = {
  bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${crypto.randomUUID()}`, version: 1,
  metadata: { timestamp: new Date().toISOString(), component: { type: 'application', name: 'serpent-arena', version: '0.1.0' } }, components,
};
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/sbom.cdx.json', `${JSON.stringify(document, null, 2)}\n`);
process.stdout.write(`[sbom] wrote artifacts/sbom.cdx.json (${components.length} components)\n`);
