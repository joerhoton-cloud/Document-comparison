// Collapses dist-single/ into one self-contained HTML file: dist-single/doccompare.html
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', 'dist-single');
let html = readFileSync(join(dir, 'index.html'), 'utf8');
const read = (href) => readFileSync(join(dir, href.replace(/^\//, '')), 'utf8');

const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => read(m[1])).join('\n');
const js = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)]
  .map((m) => read(m[1]))
  .join('\n')
  .replace(/<\/script/gi, '<\\/script');
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];

const out = `${title}
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
${js}
</script>
`;
writeFileSync(join(dir, 'doccompare.html'), out);
console.log(`dist-single/doccompare.html  ${(out.length / 1024 / 1024).toFixed(2)} MB`);
