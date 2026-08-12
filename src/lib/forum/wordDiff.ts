// Word-level LCS, shared by the rich HTML diff and the markdown source diff.
// Tokens alternate word and whitespace so the reassembled text is byte-identical
// to the input: a diff must never silently reflow a post.

export type WordOp = { type: 'same' | 'add' | 'del'; text: string };

/**
 * Cell budget for every LCS table in the diff engine, shared with alignNodes and
 * lineDiff. A table is (n+1) by (m+1) numbers, measured at exactly 8 bytes per cell
 * in V8, so this caps one table at about 15 MB.
 *
 * It has to be capped. Tokens include whitespace runs, so the 20,000 character body
 * limit (src/lib/forum/handlers.ts) allows 20,000 tokens in a single paragraph, which
 * is 400 million cells, about 3 GB. A Workers isolate dies at 128 MB, and the history
 * page is a public unauthenticated URL, so that is an isolate kill rather than even a
 * 500, and the same call runs in the reader's browser in the history modal. Measured
 * on ordinary prose the table alone is 32 MB at 8,000 characters and 168 MB at 20,000,
 * so a budget that only catches the worst case would still let an ordinary long post
 * take the page down.
 *
 * 2 million cells is about 1,400 tokens per side, roughly 700 words or 4,200
 * characters of prose in one paragraph, far beyond what anyone writes without a
 * paragraph break. Over the budget the pair degrades to a whole replacement, which is
 * the shape the 0.3 similarity rule already produces for text too dissimilar to word
 * diff, so every caller and the CSS already handle it.
 */
export const LCS_CELL_BUDGET = 2_000_000;

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** Diffs two texts word by word. Adjacent ops of the same type are merged. */
export function wordDiff(oldText: string, newText: string): WordOp[] {
  // Before the budget check, not after: identical text is the one case where the
  // table is never needed whatever its size. Without this, an untouched paragraph
  // over the budget comes back as a whole deletion plus a whole addition, so a long
  // paragraph nobody edited renders struck through and re-added, and the header
  // counts every one of its words twice.
  if (oldText === newText) return oldText === '' ? [] : [{ type: 'same', text: oldText }];

  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

  // Over budget: build no table at all and return the pair as one whole replacement.
  if ((n + 1) * (m + 1) > LCS_CELL_BUDGET) {
    const replacement: WordOp[] = [];
    if (oldText !== '') replacement.push({ type: 'del', text: oldText });
    if (newText !== '') replacement.push({ type: 'add', text: newText });
    return replacement;
  }

  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: WordOp[] = [];
  const push = (type: WordOp['type'], text: string): void => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('del', a[i++]);
    } else {
      push('add', b[j++]);
    }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('add', b[j++]);
  return ops;
}

/**
 * Shared words over the longer word count, in 0..1. Used to decide whether two
 * lines or nodes are a rewrite (worth a word diff) or unrelated (replace whole).
 */
export function similarity(a: string, b: string): number {
  const wa = a.match(/[^\s]+/g) ?? [];
  const wb = b.match(/[^\s]+/g) ?? [];
  if (wa.length === 0 && wb.length === 0) return 1;
  const pool = [...wb];
  let shared = 0;
  for (const w of wa) {
    const at = pool.indexOf(w);
    if (at !== -1) {
      shared++;
      pool.splice(at, 1);
    }
  }
  return shared / Math.max(wa.length, wb.length);
}
