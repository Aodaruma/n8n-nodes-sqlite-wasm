import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const sourceDir = path.join(repoRoot, 'nodes', 'SQLiteWasm', 'vendor');
const targetDir = path.join(repoRoot, 'dist', 'nodes', 'SQLiteWasm', 'vendor');

await mkdir(path.dirname(targetDir), { recursive: true });
await cp(sourceDir, targetDir, { recursive: true, force: true });
