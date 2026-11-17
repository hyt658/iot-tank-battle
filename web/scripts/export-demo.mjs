import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build output is bundled into a portable, offline HTML for teammates to open.
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
let html = await readFile(resolve(dist, 'index.html'), 'utf8');
for (const match of [...html.matchAll(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g)]) {
  const code = await readFile(resolve(dist, match[1]), 'utf8');
  html = html.replace(match[0], () => `<script type="module">${code.replace(/<\/script/gi, '<\\/script')}</script>`);
}
for (const match of [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
  const css = await readFile(resolve(dist, match[1]), 'utf8');
  html = html.replace(match[0], () => `<style>${css}</style>`);
}
await writeFile(resolve(dist, 'tank-arena.html'), html, 'utf8');
console.log('Exported dist/tank-arena.html (offline, self-contained)');
