import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'soul.md');
const targetPath = resolve(root, 'src/soul.js');
const source = await readFile(sourcePath, 'utf8');
const generated = [
  '// This file is generated from soul.md. Do not edit it directly.',
  `export default ${JSON.stringify(source)};`,
  '',
].join('\n');

await writeFile(targetPath, generated, 'utf8');
