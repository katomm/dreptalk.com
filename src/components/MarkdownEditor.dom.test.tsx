// @vitest-environment happy-dom
// Cmd/Ctrl+B and Cmd/Ctrl+I in the editor wrap the selected text like the
// toolbar buttons do.
import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import MarkdownEditor from './MarkdownEditor';

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownEditor value={value} onChange={setValue} maxLength={1000} mentions={false} />;
}

function setup(initial: string, start: number, end: number) {
  const { container } = render(<Harness initial={initial} />);
  const ta = container.querySelector('textarea') as HTMLTextAreaElement;
  ta.focus();
  ta.setSelectionRange(start, end);
  return ta;
}

afterEach(cleanup);

describe('MarkdownEditor keyboard shortcuts', () => {
  it('Cmd+B makes the selection bold and keeps it selected', () => {
    const ta = setup('hello world', 6, 11);
    fireEvent.keyDown(ta, { key: 'b', metaKey: true });
    expect(ta.value).toBe('hello **world**');
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('world');
  });

  it('Ctrl+I makes the selection italic', () => {
    const ta = setup('hello world', 0, 5);
    fireEvent.keyDown(ta, { key: 'i', ctrlKey: true });
    expect(ta.value).toBe('*hello* world');
  });

  it('pressing Cmd+B twice toggles bold off again', () => {
    const ta = setup('hello world', 6, 11);
    fireEvent.keyDown(ta, { key: 'b', metaKey: true });
    fireEvent.keyDown(ta, { key: 'b', metaKey: true });
    expect(ta.value).toBe('hello world');
  });

  it('Cmd+K turns the selection into a link and cancels the key for the site search', () => {
    const ta = setup('hello world', 6, 11);
    const notCancelled = fireEvent.keyDown(ta, { key: 'k', metaKey: true });
    expect(notCancelled).toBe(false);
    expect(ta.value).toBe('hello [world](url)');
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('url');
  });
});
