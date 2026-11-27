// Runs the inline theme script the way a browser would. Every boot() gets its
// own happy-dom window, so listeners registered by one test never fire in the
// next. localStorage and matchMedia are stubs, which lets a test pick the OS
// scheme, flip it later and simulate blocked storage.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./theme-init.js', import.meta.url)), 'utf8');

const MARKUP = `
  <details id="theme-menu" data-auto-dismiss>
    <summary id="theme-toggle" aria-label="Theme"></summary>
    <div role="group" aria-label="Theme">
      <button type="button" data-theme-choice="light" aria-pressed="false">Light</button>
      <button type="button" data-theme-choice="dark" aria-pressed="false">Dark</button>
      <button type="button" data-theme-choice="system" aria-pressed="false">System</button>
    </div>
  </details>`;

type Choice = 'light' | 'dark' | 'system';

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});

function boot(
  opts: {
    stored?: string;
    osDark?: boolean;
    brokenStorage?: boolean;
    reducedMotion?: boolean;
    viewTransitions?: boolean;
  } = {},
) {
  const window = new Window({ url: 'https://x.test/' });
  windows.push(window);
  const document = window.document;
  document.head.innerHTML = '<meta name="theme-color" content="#0c0a12">';
  document.body.innerHTML = MARKUP;

  const store = new Map<string, string>();
  if (opts.stored !== undefined) store.set('theme', opts.stored);
  const denied = () => {
    throw new Error('denied');
  };
  const localStorage = opts.brokenStorage
    ? { getItem: denied, setItem: denied, removeItem: denied }
    : {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      };

  const osListeners: Array<() => void> = [];
  const osQuery = {
    matches: opts.osDark ?? false,
    addEventListener: (_type: string, fn: () => void) => void osListeners.push(fn),
  };
  const matchMedia = (query: string) =>
    query.includes('prefers-color-scheme') ? osQuery : { matches: opts.reducedMotion ?? false };

  const html = document.documentElement;
  const startViewTransition = vi.fn((cb: () => void) => {
    cb();
    return { ready: Promise.resolve() };
  });
  if (opts.viewTransitions) {
    Object.assign(document, { startViewTransition });
    Object.assign(html, { animate: () => ({}) });
  }

  new Function('window', 'document', 'localStorage', 'matchMedia', source)(window, document, localStorage, matchMedia);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) throw new Error('theme-color meta missing');
  // Read before DOMContentLoaded: what the reader gets before first paint.
  const early = { theme: html.getAttribute('data-theme'), themeColor: meta.getAttribute('content') };
  document.dispatchEvent(new window.Event('DOMContentLoaded'));

  const byId = (id: string) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} missing`);
    return el;
  };
  return {
    window,
    document,
    html,
    meta,
    store,
    early,
    startViewTransition,
    toggle: byId('theme-toggle'),
    menu: byId('theme-menu') as unknown as HTMLDetailsElement,
    choice(name: Choice) {
      const el = document.querySelector(`[data-theme-choice="${name}"]`);
      if (!el) throw new Error(`choice ${name} missing`);
      return el as unknown as HTMLButtonElement;
    },
    setOs(dark: boolean) {
      osQuery.matches = dark;
      for (const fn of osListeners) fn();
    },
    storageEvent(key: string | null) {
      window.dispatchEvent(Object.assign(new window.Event('storage'), { key }));
    },
    pageShow(persisted: boolean) {
      window.dispatchEvent(Object.assign(new window.Event('pageshow'), { persisted }));
    },
  };
}

describe('theme-init, before first paint', () => {
  it('applies a stored dark choice on a light OS', () => {
    const t = boot({ stored: 'dark', osDark: false });
    expect(t.early).toEqual({ theme: 'dark', themeColor: '#0c0a12' });
  });

  it('applies a stored light choice on a dark OS', () => {
    const t = boot({ stored: 'light', osDark: true });
    expect(t.early).toEqual({ theme: 'light', themeColor: '#ffffff' });
  });

  it.each([
    [true, 'dark'],
    [false, 'light'],
  ])('follows the OS without a stored value (dark=%s)', (osDark, theme) => {
    expect(boot({ osDark }).early.theme).toBe(theme);
  });

  it('treats an unknown stored value as System', () => {
    const t = boot({ stored: 'auto', osDark: true });
    expect(t.early.theme).toBe('dark');
    expect(t.choice('system').getAttribute('aria-pressed')).toBe('true');
  });

  it('follows the OS when storage throws', () => {
    expect(boot({ brokenStorage: true, osDark: true }).early.theme).toBe('dark');
  });
});

describe('theme-init, menu', () => {
  it('marks System for a visitor without a stored value', () => {
    const t = boot({ osDark: false });
    expect(t.choice('system').getAttribute('aria-pressed')).toBe('true');
    expect(t.toggle.getAttribute('aria-label')).toBe('Theme: System');
  });

  it('stores and applies Dark, closes the panel and returns focus', () => {
    const t = boot({ osDark: false });
    t.menu.open = true;
    t.choice('dark').click();
    expect(t.store.get('theme')).toBe('dark');
    expect(t.html.getAttribute('data-theme')).toBe('dark');
    expect(t.meta.getAttribute('content')).toBe('#0c0a12');
    expect(t.choice('dark').getAttribute('aria-pressed')).toBe('true');
    expect(t.choice('system').getAttribute('aria-pressed')).toBe('false');
    expect(t.toggle.getAttribute('aria-label')).toBe('Theme: Dark');
    expect(t.menu.open).toBe(false);
    expect(t.document.activeElement).toBe(t.toggle);
  });

  it('System removes the stored value and follows the OS', () => {
    const t = boot({ stored: 'dark', osDark: false });
    t.choice('system').click();
    expect(t.store.has('theme')).toBe(false);
    expect(t.html.getAttribute('data-theme')).toBe('light');
  });

  it('still switches for this page view when storage throws', () => {
    const t = boot({ brokenStorage: true, osDark: false });
    expect(() => t.choice('dark').click()).not.toThrow();
    expect(t.html.getAttribute('data-theme')).toBe('dark');
    expect(t.choice('dark').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('theme-init, live following', () => {
  it('switches with the OS in System mode', () => {
    const t = boot({ osDark: false });
    t.setOs(true);
    expect(t.html.getAttribute('data-theme')).toBe('dark');
    expect(t.meta.getAttribute('content')).toBe('#0c0a12');
    t.setOs(false);
    expect(t.html.getAttribute('data-theme')).toBe('light');
  });

  it('ignores the OS while Light is chosen', () => {
    const t = boot({ stored: 'light', osDark: false });
    t.setOs(true);
    expect(t.html.getAttribute('data-theme')).toBe('light');
  });

  it.each(['theme', null])('applies a change from another tab (key=%s)', (key) => {
    const t = boot({ osDark: false });
    t.store.set('theme', 'dark');
    t.storageEvent(key);
    expect(t.html.getAttribute('data-theme')).toBe('dark');
    expect(t.choice('dark').getAttribute('aria-pressed')).toBe('true');
  });

  it('re-reads the choice when the page comes back from the back/forward cache', () => {
    // The reader chose Dark on the next page, then pressed Back. The restored
    // page still holds the old state and gets no storage event from its own tab.
    const t = boot({ osDark: false });
    t.store.set('theme', 'dark');
    t.pageShow(true);
    expect(t.html.getAttribute('data-theme')).toBe('dark');
    expect(t.choice('dark').getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores storage events for other keys', () => {
    const t = boot({ osDark: false });
    t.store.set('theme', 'dark');
    t.storageEvent('other');
    expect(t.html.getAttribute('data-theme')).toBe('light');
  });
});

describe('theme-init, circular reveal', () => {
  it('runs when the visible theme changes', () => {
    const t = boot({ osDark: false, viewTransitions: true });
    t.choice('dark').click();
    expect(t.startViewTransition).toHaveBeenCalledTimes(1);
    expect(t.html.getAttribute('data-theme')).toBe('dark');
  });

  it('is skipped when only the mode changes', () => {
    const t = boot({ stored: 'dark', osDark: true, viewTransitions: true });
    t.choice('system').click();
    expect(t.startViewTransition).not.toHaveBeenCalled();
    expect(t.store.has('theme')).toBe(false);
  });

  it('is skipped with reduced motion, the switch still happens', () => {
    const t = boot({ osDark: false, viewTransitions: true, reducedMotion: true });
    t.choice('dark').click();
    expect(t.startViewTransition).not.toHaveBeenCalled();
    expect(t.html.getAttribute('data-theme')).toBe('dark');
  });

  it('still switches when the browser skips the transition', async () => {
    // A hidden document or a newer transition rejects `ready`. Vitest fails the
    // run on an unhandled rejection, so this also pins that the script handles it.
    const t = boot({ osDark: false, viewTransitions: true });
    t.startViewTransition.mockImplementationOnce((cb: () => void) => {
      cb();
      return { ready: Promise.reject(new Error('Transition was skipped')) };
    });
    t.choice('dark').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.html.getAttribute('data-theme')).toBe('dark');
    expect(t.store.get('theme')).toBe('dark');
  });

  it('is skipped for a live OS switch', () => {
    const t = boot({ osDark: false, viewTransitions: true });
    t.setOs(true);
    expect(t.startViewTransition).not.toHaveBeenCalled();
  });
});
