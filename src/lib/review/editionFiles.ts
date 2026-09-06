// Reads review editions straight from disk (no astro:content), for node tests
// and the fact check. Returns frontmatter, body and the file's slug.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { reviewFrontmatterSchema, type ReviewFrontmatter } from './schema.js';

export interface EditionFile { slug: string; file: string; frontmatter: ReviewFrontmatter; body: string }

export function readEditionFile(file: string): EditionFile {
  const raw = readFileSync(file, 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${file}: no frontmatter`);
  return { slug: path.basename(file, '.md'), file, frontmatter: reviewFrontmatterSchema.parse(parseYaml(m[1])), body: m[2] };
}

export function readEditionDir(dir: string): EditionFile[] {
  return readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => readEditionFile(path.join(dir, f)));
}
