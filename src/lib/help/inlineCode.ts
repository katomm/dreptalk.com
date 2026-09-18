// FAQ answers in guide frontmatter are plain text, with one markdown feature:
// `backticks` mark inline code. The guide route renders those parts as <code>,
// the FAQ structured data carries the text without the backticks.

export interface AnswerPart {
  text: string;
  code: boolean;
}

const INLINE_CODE = /`([^`]+)`/g;

export function splitInlineCode(s: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_CODE)) {
    if (m.index > last) parts.push({ text: s.slice(last, m.index), code: false });
    parts.push({ text: m[1], code: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) parts.push({ text: s.slice(last), code: false });
  return parts;
}

export function stripInlineCode(s: string): string {
  return s.replace(INLINE_CODE, '$1');
}
