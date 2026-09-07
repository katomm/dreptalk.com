import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gitBlobHash } from './packBlob.js';
import { readEditionDir } from './editionFiles.js';

const CONTENT = path.join(import.meta.dirname, '../../content/review');

describe('gitBlobHash', () => {
  it('matches git hash-object for a known input', () => {
    // `printf 'hello\n' | git hash-object --stdin` is ce013625030ba8dba906f756967f9e9ca394464a
    expect(gitBlobHash(Buffer.from('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('every published edition pins its pack file', () => {
  for (const e of readEditionDir(CONTENT)) {
    it(e.slug, () => {
      const pack = readFileSync(e.file.replace(/\.md$/, '.pack.json'));
      expect(gitBlobHash(pack)).toBe(e.frontmatter.packBlob);
    });
  }
});
