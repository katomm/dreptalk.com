import { useEffect, useRef, type RefObject } from 'react';

// Selector for the elements a Tab press may land on inside a dialog. Disabled
// controls and tabindex="-1" are excluded so the trap cycles only real stops.
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface DialogA11yOptions {
  /** The dialog panel element. Focus is moved into it and Tab is trapped within it. */
  panelRef: RefObject<HTMLElement | null>;
  /** Close callback for Escape and outside-click. Read through a ref, so it never has to be memoized. */
  onClose: () => void;
  /** When false, Escape and outside-click do not close (e.g. a wallet round-trip is in flight). Defaults to true. */
  dismissable?: boolean;
  /** Lock body scroll while the dialog is open. Defaults to false. */
  lockScroll?: boolean;
  /** Element to focus on open. Defaults to the first focusable inside the panel. */
  initialFocusRef?: RefObject<{ focus: () => void } | null>;
}

/**
 * Accessibility plumbing shared by the app's modal dialogs: moves focus into the
 * panel on open, traps Tab/Shift+Tab within it, restores focus to the previously
 * focused element on close, and wires Escape + outside-click dismissal (and an
 * optional body-scroll lock). Without the focus trap/restore, keyboard and
 * screen-reader users can Tab out to the (aria-modal, inert) page behind the
 * dialog and land at the top of the document when it closes.
 */
export function useDialogA11y({
  panelRef,
  onClose,
  dismissable = true,
  lockScroll = false,
  initialFocusRef,
}: DialogA11yOptions): void {
  // Read onClose/dismissable through refs so the dismiss listeners can subscribe
  // once (no churn) yet always see the latest values.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissableRef = useRef(dismissable);
  dismissableRef.current = dismissable;

  // Focus management: initial focus, Tab trap, and focus restore. Runs once per
  // open so the restore only fires when the dialog actually unmounts.
  useEffect(() => {
    const panel = panelRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusTarget =
      (initialFocusRef?.current as HTMLElement | null) ??
      panel?.querySelector<HTMLElement>(FOCUSABLE) ??
      panel;
    focusTarget?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [panelRef, initialFocusRef]);

  // Escape + outside-click dismissal, honoring the live `dismissable` flag.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissableRef.current) onCloseRef.current();
    };
    const onDown = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (dismissableRef.current && panel && !panel.contains(e.target as Node)) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [panelRef]);

  // Optional body-scroll lock while open.
  useEffect(() => {
    if (!lockScroll) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [lockScroll]);
}
