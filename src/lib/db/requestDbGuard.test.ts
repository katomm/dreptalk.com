import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard: request code must get its D1 handle from requestDb() or runtimeEnv(),
// never by reading DB straight off the cloudflare:workers env. A direct read
// always hits the primary and silently skips the read replica for anonymous
// visitors (see lib/db/requestDb). The middleware is the one place that needs
// the raw binding, for the session activity write that stays on the primary.

const SRC = path.join(import.meta.dirname, '..', '..');
const ALLOWED = new Set(['middleware.ts', 'lib/db/requestDb.ts']);
const IMPORTS_ENV = /import \{[^}]*\benv\b[^}]*\} from 'cloudflare:workers'/;
const READS_DB = /\benv\??\.DB\b|\benv\[['"]DB['"]\]|\{[^}]*\bDB\b[^}]*\}\s*=\s*env\b/;

describe('D1 handle guard', () => {
  it('no request code reads DB off the cloudflare:workers env', () => {
    const offenders = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((rel) => /\.(ts|tsx|astro)$/.test(rel) && !/\.test\.tsx?$|workers\.ts$|__tests__|^lib\/test-/.test(rel))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => {
        const text = readFileSync(path.join(SRC, rel), 'utf8');
        return IMPORTS_ENV.test(text) && READS_DB.test(text);
      });
    expect(offenders).toEqual([]);
  });
});
