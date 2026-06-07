import { describe, it, expect } from 'vitest';
import { postViewerContext } from './postVisibility.js';

const writer = { id: 'u-writer', roles: ['drep'] };
const mod = { id: 'u-mod', roles: ['moderator'] };
const member = { id: 'u-member', roles: ['member'] };

describe('postViewerContext: canFlag', () => {
  it('lets a writer flag another user\'s normal post', () => {
    const c = postViewerContext({ author_id: 'other', hidden: false }, writer, false);
    expect(c.canFlag).toBe(true);
  });

  it('forbids flagging your own post', () => {
    const c = postViewerContext({ author_id: writer.id, hidden: false }, writer, false);
    expect(c.canFlag).toBe(false);
  });

  it('forbids flagging a system post', () => {
    const c = postViewerContext({ author_id: 'gov-sync', hidden: false }, writer, true);
    expect(c.canFlag).toBe(false);
  });

  it('forbids a non-writer from flagging', () => {
    const c = postViewerContext({ author_id: 'other', hidden: false }, member, false);
    expect(c.canFlag).toBe(false);
  });

  it('forbids an anonymous viewer from flagging', () => {
    const c = postViewerContext({ author_id: 'other', hidden: false }, null, false);
    expect(c.canFlag).toBe(false);
  });
});

describe('postViewerContext: canSeeContent for a hidden post', () => {
  it('hides content from an ordinary viewer', () => {
    const c = postViewerContext({ author_id: 'other', hidden: true }, writer, false);
    expect(c.canSeeContent).toBe(false);
  });

  it('shows content to the author', () => {
    const c = postViewerContext({ author_id: writer.id, hidden: true }, writer, false);
    expect(c.canSeeContent).toBe(true);
  });

  it('shows content to a moderator', () => {
    const c = postViewerContext({ author_id: 'other', hidden: true }, mod, false);
    expect(c.canSeeContent).toBe(true);
  });

  it('always shows a non-hidden post', () => {
    const c = postViewerContext({ author_id: 'other', hidden: false }, null, false);
    expect(c.canSeeContent).toBe(true);
  });
});
