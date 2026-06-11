// The contract between a post's server-rendered Reply button and the Composer
// island: one window event, one detail shape, defined once so dispatcher and
// listener cannot drift.

export const REPLY_EVENT = 'dreptalk:reply';

export interface ReplyEventDetail {
  /** The post being replied to (the server lifts nested targets to one level). */
  postId: string;
  /** Author display name, echoed in the composer's "Replying to" chip. */
  author: string;
}

/** Dispatches the reply event the Composer island listens for. */
export function dispatchReply(detail: ReplyEventDetail): void {
  window.dispatchEvent(new CustomEvent<ReplyEventDetail>(REPLY_EVENT, { detail }));
}
