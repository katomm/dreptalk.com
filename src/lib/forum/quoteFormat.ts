// Pure builders for a select-to-quote insertion. Kept DOM-free and event-free so
// the composer and the selection island can share them and they stay unit-testable.

export type AppendResult = { ok: true; value: string } | { ok: false; reason: 'length' };

// Escapes the characters that would break a Markdown link label, and flattens any
// newlines in a display name to spaces so the attribution stays on one line.
export function escapeMarkdownLinkLabel(author: string): string {
  return author
    .replace(/[\\[\]]/g, (c) => `\\${c}`)
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

// Builds a linked attribution header followed by the selection as a blockquote.
// Every source line gets one extra "> " (blank lines become a bare ">"), and the
// block ends with a blank line so the reply is typed directly under it.
export function buildQuoteBlock(input: { author: string; href: string; text: string }): string {
  const label = escapeMarkdownLinkLabel(input.author) || 'post';
  const quoted = input.text
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
  return `[${label}](${input.href}) wrote:\n\n${quoted}\n\n`;
}

// Appends a quote block to the current draft, keeping the draft intact and
// ensuring a blank line separates stacked quotes. Enforces the composer limit.
export function appendQuote(previous: string, block: string, maxLength: number): AppendResult {
  let separator = '';
  if (previous.length > 0 && !previous.endsWith('\n\n')) {
    separator = previous.endsWith('\n') ? '\n' : '\n\n';
  }
  const value = previous + separator + block;
  if (value.length > maxLength) return { ok: false, reason: 'length' };
  return { ok: true, value };
}
