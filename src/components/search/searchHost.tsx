import { useEffect, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { HelpEntry } from '@/lib/search/staticEntries.js';
import type { Scope } from '@/lib/search/scopes.js';
import SearchPalette from './SearchPalette';

// React side of the header search, loaded by SearchTrigger.astro on the first
// open (or when the pointer or focus reaches the button), so pages without
// other islands never download React.

export interface SearchHost {
  /** Opens the palette, optionally with text typed while it was loading. */
  open(seedQuery?: string): void;
  toggle(): void;
}

interface MountOptions {
  trigger: HTMLButtonElement;
  signedIn: boolean;
  initialScope: Scope;
}

// Starts with the chunk so the list is usually there before the first keystroke.
// A failed fetch only leaves the Help group empty.
const helpEntriesPromise: Promise<HelpEntry[]> = fetch('/search-help-entries.json')
  .then((res) => (res.ok ? (res.json() as Promise<HelpEntry[]>) : []))
  .catch(() => []);

export function mountSearch({ trigger, signedIn, initialScope }: MountOptions): SearchHost {
  // Open state lives outside React so the trigger script can flip it
  // synchronously: flushSync commits the palette inside the tap, which lets the
  // input's autoFocus raise the mobile keyboard.
  // One snapshot object per change, as useSyncExternalStore compares by identity.
  let state = { open: false, seedQuery: '' };
  const listeners = new Set<() => void>();
  const setState = (open: boolean, seedQuery = '') => {
    state = { open, seedQuery };
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const returnFocusRef = { current: trigger };

  function Host() {
    const { open, seedQuery } = useSyncExternalStore(subscribe, () => state);
    const [helpEntries, setHelpEntries] = useState<HelpEntry[]>([]);
    useEffect(() => {
      void helpEntriesPromise.then(setHelpEntries);
    }, []);
    return (
      <SearchPalette
        open={open}
        onClose={() => setState(false)}
        returnFocusRef={returnFocusRef}
        helpEntries={helpEntries}
        signedIn={signedIn}
        initialScope={initialScope}
        seedQuery={seedQuery}
      />
    );
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(<Host />));

  return {
    open: (seedQuery) => flushSync(() => setState(true, seedQuery)),
    toggle: () => flushSync(() => setState(!state.open)),
  };
}
