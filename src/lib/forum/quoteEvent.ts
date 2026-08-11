// The contract between a post's floating "Quote reply" button (the QuoteSelection
// island) and the Composer island, one window event, one detail shape, defined
// once so dispatcher and listener cannot drift. Mirrors replyEvent.ts.

export const QUOTE_EVENT = 'dreptalk:quote';

export interface QuoteEventDetail {
  /** The post the passage was quoted from. */
  postId: string;
  /** That post's author display name, for the attribution link label. */
  author: string;
  /** The plain-text selected passage, already clamped to the one post. */
  text: string;
  /** Local permalink to the source post (pathname + search + hash), no origin. */
  href: string;
}

/** Dispatches the quote event the Composer island listens for. */
export function dispatchQuote(detail: QuoteEventDetail): void {
  window.dispatchEvent(new CustomEvent<QuoteEventDetail>(QUOTE_EVENT, { detail }));
}
