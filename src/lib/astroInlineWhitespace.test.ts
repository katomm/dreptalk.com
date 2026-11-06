import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { transform } from '@astrojs/compiler-rs';
import { describe, expect, it } from 'vitest';

/**
 * Astro 7 defaults `compressHTML` to "jsx": whitespace that contains a newline
 * between text and an inline element (or an expression) is dropped, like in React
 * JSX. A source line that ends in `</a>` followed by a line starting with `or` then
 * renders as "</a>or". This test compiles every .astro file in both modes and fails
 * when "jsx" glues two prose runs that the whitespace-preserving mode separates.
 * The fix at the call site is `{' '}` at the end of the line.
 */

const SRC = join(process.cwd(), 'src');
const INLINE = 'a|strong|em|code|time|abbr|span|b|i|small|kbd|mark|sup|sub';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.astro')) out.push(p);
  }
  return out;
}

const isWs = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
// An explicit `{' '}` is the intended fix, so both outputs treat it as plain whitespace.
const normalize = (code: string) => code.replaceAll('${" "}', ' ').replaceAll("${' '}", ' ');

interface Boundary {
  left: string;
  right: string;
}

/** Walk both outputs in lockstep and collect spots where `kept` has whitespace and `jsx` has none. */
function lostWhitespace(kept: string, jsx: string): Boundary[] | { bailAt: string } {
  const out: Boundary[] = [];
  let i = 0;
  let j = 0;
  while (i < kept.length && j < jsx.length) {
    if (isWs(kept[i])) {
      if (isWs(jsx[j])) {
        while (isWs(kept[i])) i++;
        while (isWs(jsx[j])) j++;
        continue;
      }
      const start = i;
      while (isWs(kept[i])) i++;
      out.push({ left: kept.slice(Math.max(0, start - 40), start), right: kept.slice(i, i + 40) });
      continue;
    }
    if (isWs(jsx[j])) {
      j++;
      continue;
    }
    if (kept[i] !== jsx[j]) return { bailAt: kept.slice(Math.max(0, i - 30), i + 30) };
    i++;
    j++;
  }
  return out;
}

const closeInline = new RegExp(`</(?:${INLINE})>$`);
const openInline = new RegExp(`^<(?:${INLINE})[ >]`);

/** Prose boundary: a word or punctuation character against an inline tag, an expression, or more text. */
function isProseBoundary({ left, right }: Boundary): boolean {
  const leftText = /[\p{L}\p{N}.,;:!?)'"%]$/u.test(left) && !/[=;{(]\s*$/.test(left.slice(-2));
  const leftTag = closeInline.test(left);
  const leftExpr = /\$\{[^]*\}$/.test(left) && left.endsWith('}');
  const rightText =
    /^[\p{L}\p{N}('"]/u.test(right) && !/^(import|export|const|let|return|var|function|if|else|\$\$)/.test(right);
  const rightTag = openInline.test(right);
  const rightExpr = right.startsWith('${');
  return (leftText && (rightText || rightTag || rightExpr)) || ((leftTag || leftExpr) && rightText);
}

/**
 * Intended joins, keyed by file and a snippet of "left|right" around the boundary.
 * Each one has a reason why no space is needed or why the space comes from elsewhere.
 */
const ALLOWED: { file: string; snippet: string; why: string }[] = [
  // Icon span and label inside inline-flex containers with a gap.
  { file: 'components/DrepVotingStats.astro', snippet: '</svg> </span>|Participation', why: 'inline-flex title with gap' },
  { file: 'components/DrepVotingStats.astro', snippet: '</svg> </span>|Votes with rationale', why: 'inline-flex title with gap' },
  { file: 'components/DrepVotingStats.astro', snippet: '</svg> </span>|Vote timing', why: 'inline-flex title with gap' },
  { file: 'pages/c/[slug].astro', snippet: '</span>|All types', why: 'flex menu option with gap' },
  { file: 'pages/vote.astro', snippet: '</span>|All types', why: 'flex menu option with gap' },
  // The following expression yields a string with its own leading space.
  { file: 'pages/cite/[postId].astro', snippet: 'has since been deleted.|${deletedOn', why: 'fragment starts with a space, else explicit space follows' },
  { file: 'pages/cite/[postId].astro', snippet: 'that had been published|${view.versionCount === 1 ? " is"', why: 'expression has leading space' },
  { file: 'pages/cite/[postId].astro', snippet: 'pointing at|${view.versionCount === 1 ? " it"', why: 'expression has leading space' },
  { file: 'pages/debug/sync.astro', snippet: 'epoch ${snapshot.epoch}.|${snapshot.state === "overdue" && " Over', why: 'expression has leading space' },
  { file: 'pages/debug/sync.astro', snippet: 'items|${p.failed > 0 ?', why: 'expression starts with a comma' },
  { file: 'pages/my-drep.astro', snippet: 'not all of them.|${clampedToRegistration', why: 'template string has leading space' },
  // The span carries its own spaces inside: " · ".
  { file: 'pages/settings/devices.astro', snippet: '> · </span>|Last used', why: 'separator span includes its spaces' },
];

describe('astro inline whitespace under compressHTML "jsx"', () => {
  it('does not glue prose to inline elements or expressions', async () => {
    const problems: string[] = [];
    for (const path of walk(SRC)) {
      const file = relative(SRC, path);
      const source = readFileSync(path, 'utf8');
      const [kept, jsx] = await Promise.all([
        transform(source, { compact: true, filename: path }),
        transform(source, { compact: 'jsx', filename: path }),
      ]);
      const found = lostWhitespace(normalize(kept.code), normalize(jsx.code));
      if (!Array.isArray(found)) {
        problems.push(`${file}: outputs could not be aligned near ${JSON.stringify(found.bailAt)}`);
        continue;
      }
      for (const b of found.filter(isProseBoundary)) {
        const key = `${b.left}|${b.right}`;
        if (ALLOWED.some((a) => a.file === file && key.includes(a.snippet))) continue;
        problems.push(`${file}: ${JSON.stringify(b.left.slice(-30))} runs into ${JSON.stringify(b.right.slice(0, 30))}`);
      }
    }
    expect(problems, `add {' '} at the end of the line, or allow it in ALLOWED with a reason:\n${problems.join('\n')}`).toEqual([]);
  }, 120_000);
});
