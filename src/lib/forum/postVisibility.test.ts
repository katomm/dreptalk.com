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

describe('postViewerContext: reactions', () => {
  it('lets a writer react to another user\'s post', () => {
    const c = postViewerContext({ author_id: 'other', hidden: false }, writer, false);
    expect(c.reactions).toBe('interactive');
  });

  it('hides the row entirely on a system post', () => {
    const c = postViewerContext({ author_id: 'gov-sync', hidden: false }, writer, true);
    expect(c.reactions).toBe('hidden');
  });

  it('shows read-only counts on your own post', () => {
    const c = postViewerContext({ author_id: writer.id, hidden: false }, writer, false);
    expect(c.reactions).toBe('readonly');
  });

  it('shows read-only counts to a non-writer', () => {
    const c = postViewerContext({ author_id: 'other', hidden: false }, member, false);
    expect(c.reactions).toBe('readonly');
  });

  it('shows read-only counts to an anonymous viewer', () => {
    const c = postViewerContext({ author_id: 'other', hidden: false }, null, false);
    expect(c.reactions).toBe('readonly');
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

describe('postViewerContext: canEdit', () => {
  const writer = { id: 'u1', roles: ['drep'] };
  it('true for a writer editing their own non-hidden non-system post', () => {
    const ctx = postViewerContext({ author_id: 'u1', hidden: false }, writer, false);
    expect(ctx.canEdit).toBe(true);
  });
  it('false for someone else\'s post', () => {
    const ctx = postViewerContext({ author_id: 'u2', hidden: false }, writer, false);
    expect(ctx.canEdit).toBe(false);
  });
  it('false for a system/governance post', () => {
    const ctx = postViewerContext({ author_id: 'u1', hidden: false }, writer, true);
    expect(ctx.canEdit).toBe(false);
  });
  it('false for a hidden post', () => {
    const ctx = postViewerContext({ author_id: 'u1', hidden: true }, writer, false);
    expect(ctx.canEdit).toBe(false);
  });
  it('false for an anonymous viewer', () => {
    const ctx = postViewerContext({ author_id: 'u1', hidden: false }, null, false);
    expect(ctx.canEdit).toBe(false);
  });
});
