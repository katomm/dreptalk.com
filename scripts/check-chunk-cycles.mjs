// Fails when two build chunks import each other, directly or through others.
//
// A static import cycle between chunks makes module initialization depend on
// which chunk a page happens to load first. That is how /ga/new/ once crashed at
// startup ("dual is not a function"): the bundler split the Evolution SDK across
// two chunks that imported each other, on the server at startup and in the
// browser on hydration. Only static imports and re-exports count, a dynamic
// import() runs after initialization and cannot cause this.
//
// Usage: node scripts/check-chunk-cycles.mjs [dir ...]
//        (default: dist/server and dist/client/_astro, each checked on its own)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
// The minimal entry keeps the v2 record shape (n, d) this script reads. The main
// entry of es-module-lexer 3 returns records with other field names, and reading
// n/d from those finds no imports at all, which would pass every build.
import { init, parse } from 'es-module-lexer/minimal';

const roots = (process.argv.length > 2 ? process.argv.slice(2) : ['dist/server', 'dist/client/_astro']).map((d) => resolve(d));

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return /\.m?js$/.test(name) ? [path] : [];
  });
}

// Module references come from a real ES module lexer, not a pattern: a pattern
// miscounts import-like text inside strings or comments and misses legal forms
// such as string-named bindings. Only static imports and re-exports (d === -1)
// count, and only relative specifiers point at other chunks.
await init();
function staticRelativeImports(source) {
  const [imports] = parse(source);
  return imports.filter((i) => i.d === -1 && i.n && /^\.{1,2}\//.test(i.n)).map((i) => i.n);
}

// Self-test before trusting the lexer: a static import and a re-export must come
// back as static relative edges and a dynamic import must not. If the record
// shape ever changes again, this fails loudly instead of every build passing.
const probe = staticRelativeImports("import a from './a.js'; export { b } from '../b.js'; import('./c.js');");
if (probe.join(',') !== './a.js,../b.js') {
  console.error(`check-chunk-cycles: import lexer self-test failed (got [${probe.join(', ')}]).`);
  process.exit(1);
}

function cyclesIn(root) {
  const files = jsFiles(root);
  const known = new Set(files);
  const edges = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const targets = new Set();
    for (const spec of staticRelativeImports(source)) targets.add(resolve(dirname(file), spec));
    edges.set(file, [...targets].filter((t) => known.has(t)));
  }

  // Depth-first search with an explicit path, so a found cycle can be printed.
  const state = new Map();
  const cycles = [];
  function visit(file, path) {
    state.set(file, 'active');
    path.push(file);
    for (const next of edges.get(file) ?? []) {
      if (state.get(next) === 'active') cycles.push(path.slice(path.indexOf(next)).concat(next));
      else if (!state.has(next)) visit(next, path);
    }
    path.pop();
    state.set(file, 'done');
  }
  for (const file of files) if (!state.has(file)) visit(file, []);

  const label = relative(process.cwd(), root) || root;
  const edgeCount = [...edges.values()].reduce((n, e) => n + e.length, 0);
  if (cycles.length > 0) {
    console.error(`${label}: chunks import each other (${cycles.length} cycle(s)):`);
    for (const cycle of cycles) console.error(`  ${cycle.map((f) => relative(root, f)).join(' -> ')}`);
  } else {
    console.log(`${label}: no import cycles between ${files.length} chunks (${edgeCount} imports checked).`);
  }
  return cycles.length;
}

let failed = 0;
for (const root of roots) failed += cyclesIn(root);
if (failed > 0) process.exit(1);
