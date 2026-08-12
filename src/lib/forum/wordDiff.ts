// Word-level LCS, shared by the rich HTML diff and the markdown source diff.
// Tokens alternate word and whitespace so the reassembled text is byte-identical
// to the input: a diff must never silently reflow a post.

export type WordOp = { type: 'same' | 'add' | 'del'; text: string };

function tokenize(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** Diffs two texts word by word. Adjacent ops of the same type are merged. */
export function wordDiff(oldText: string, newText: string): WordOp[] {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;

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
