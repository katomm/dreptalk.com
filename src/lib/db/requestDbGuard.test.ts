import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard: request code must get its D1 handle from requestDb() or runtimeEnv(),
// never by reading DB straight off the cloudflare:workers env. A direct read
// always hits the primary and silently skips the read replica for anonymous
// visitors (see lib/db/requestDb). The middleware is the one place that needs
// the raw binding: it opens the request handle and keeps the session activity
// write on the primary.

const SRC = path.join(import.meta.dirname, '..', '..');
const ROOTS = ['pages', 'components', 'layouts', 'lib'];
const ALLOWED = new Set(['middleware.ts', 'lib/db/requestDb.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx|astro)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/workers\.ts$/.test(name) ? [full] : [];
  });
}

describe('D1 handle guard', () => {
  it('no request code reads DB off the cloudflare:workers env', () => {
    const offenders = [...ROOTS.flatMap((root) => sourceFiles(path.join(SRC, root))), path.join(SRC, 'middleware.ts')]
      .map((file) => path.relative(SRC, file))
      .filter((rel) => !ALLOWED.has(rel) && !rel.startsWith('lib/test-'))
      .filter((rel) => {
        const text = readFileSync(path.join(SRC, rel), 'utf8');
        const binding = text.match(/import \{([^}]*)\} from 'cloudflare:workers'/)?.[1];
        const local = binding
          ?.split(',')
          .map((part) => part.trim())
          .find((part) => part === 'env' || part.startsWith('env as '));
        if (!local) return false;
        const name = local === 'env' ? 'env' : local.slice('env as '.length).trim();
        return new RegExp(`\\b${name}\\??\\.DB\\b`).test(text);
      });
    expect(offenders).toEqual([]);
  });
});
