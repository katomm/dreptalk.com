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

const roots = (process.argv.length > 2 ? process.argv.slice(2) : ['dist/server', 'dist/client/_astro']).map((d) => resolve(d));

function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return /\.m?js$/.test(name) ? [path] : [];
  });
}

// `import ... from "./x"`, `export ... from "./x"` and bare `import "./x"`, but
// not `import("./x")`. Minified client chunks drop the spaces
// (`import{a as b}from"./x.js"`), so no whitespace is required around `from`.
// Only relative specifiers point at other chunks.
const STATIC_IMPORT = /(?:^|[\s;}])(?:import|export)\s*(?:[^'"();]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;

function cyclesIn(root) {
  const files = jsFiles(root);
  const known = new Set(files);
  const edges = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const targets = new Set();
    for (const match of source.matchAll(STATIC_IMPORT)) targets.add(resolve(dirname(file), match[1]));
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
  if (cycles.length > 0) {
    console.error(`${label}: chunks import each other (${cycles.length} cycle(s)):`);
    for (const cycle of cycles) console.error(`  ${cycle.map((f) => relative(root, f)).join(' -> ')}`);
  } else {
    console.log(`${label}: no import cycles between ${files.length} chunks.`);
  }
  return cycles.length;
}

let failed = 0;
for (const root of roots) failed += cyclesIn(root);
if (failed > 0) process.exit(1);
