// Minimal line-level diff (LCS) for the post edit-history modal. No dependency:
// the version pairs are markdown bodies capped at 20,000 characters, small enough
// for an O(n*m) table up to the shared cell budget, past which it degrades.

import { LCS_CELL_BUDGET, similarity, wordDiff, type WordOp } from './wordDiff.js';

export type DiffOp = { type: 'same' | 'add' | 'del'; line: string };

/** Diffs two texts line by line. Removed lines (from old) come before added (from new). */
export function lineDiff(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;

  // Same quadratic table and same exposure as wordDiff, one level up: a body of
  // nothing but newlines is 20,000 lines within the length limit, which is 400
  // million cells. Over the budget (see LCS_CELL_BUDGET) every old line is reported
  // removed and every new line added, and lineDiffWithWords still zips that run by
  // position, so a reader keeps a line by line view.
  if ((n + 1) * (m + 1) > LCS_CELL_BUDGET) {
    return [
      ...a.map((line): DiffOp => ({ type: 'del', line })),
      ...b.map((line): DiffOp => ({ type: 'add', line })),
    ];
  }

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', line: a[i++] });
  while (j < m) ops.push({ type: 'add', line: b[j++] });
  return ops;
}

export type DiffLine = { type: 'same' | 'add' | 'del'; parts: WordOp[] };

// Pairing threshold shared with the rich diff: below this, two lines are a
// replacement rather than a rewrite and are shown as whole-line changes.
const SIMILAR_ENOUGH = 0.3;

const whole = (op: DiffOp): DiffLine => ({ type: op.type, parts: [{ type: op.type, text: op.line }] });

/**
 * lineDiff, plus a word pass inside each contiguous changed run. Deleted and
 * inserted lines in a run are zipped by position, and a zipped pair is word
 * diffed only when it is similar enough to be a rewrite. Leftover lines on
 * either side stay whole-line changes.
 */
export function lineDiffWithWords(oldText: string, newText: string): DiffLine[] {
  const ops = lineDiff(oldText, newText);
  const out: DiffLine[] = [];

  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'same') {
      out.push({ type: 'same', parts: [{ type: 'same', text: ops[i].line }] });
      i++;
      continue;
    }
    const start = i;
    while (i < ops.length && ops[i].type !== 'same') i++;
    const run = ops.slice(start, i);
    const dels = run.filter((op) => op.type === 'del');
    const adds = run.filter((op) => op.type === 'add');

    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k++) {
      if (similarity(dels[k].line, adds[k].line) >= SIMILAR_ENOUGH) {
        const parts = wordDiff(dels[k].line, adds[k].line);
        out.push({ type: 'del', parts: parts.filter((p) => p.type !== 'add') });
        out.push({ type: 'add', parts: parts.filter((p) => p.type !== 'del') });
      } else {
        out.push(whole(dels[k]));
        out.push(whole(adds[k]));
      }
    }
    for (let k = pairs; k < dels.length; k++) out.push(whole(dels[k]));
    for (let k = pairs; k < adds.length; k++) out.push(whole(adds[k]));
  }
  return out;
}
