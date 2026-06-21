// The contract between a post's server-rendered Edit button and the Composer
// island, mirroring replyEvent.ts: one window event, one detail shape.

export const EDIT_EVENT = 'dreptalk:edit';

export interface EditEventDetail {
  /** The post being edited. */
  postId: string;
  /** The post's current markdown source, fetched before dispatch, to prefill. */
  bodyMd: string;
}

/** Dispatches the edit event the Composer island listens for. */
export function dispatchEdit(detail: EditEventDetail): void {
  window.dispatchEvent(new CustomEvent<EditEventDetail>(EDIT_EVENT, { detail }));
}
