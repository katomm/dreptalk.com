// React island: per-row actions menu for the /dreps table, plus the
// non-custodial vote-delegation dialog it opens.
//
// The table itself is server-rendered Astro (good for SEO and a cheap first
// paint). Each row renders a plain `<button data-drep-action ...>` carrying the
// DRep identity in data-attributes. This single island mounts once, listens for
// clicks on those buttons (they live OUTSIDE the island's React root, so only a
// native document listener can catch them), and opens a small popover anchored
// to the clicked button.
//
// "Delegate voting power" opens the shared DelegateDialog, which runs the
// non-custodial wallet flow: the server never sees a key; the wallet signs and
// submits the vote_deleg certificate.
import { useEffect, useState } from 'react';
import DelegateDialog, { type Target } from '@/components/DelegateDialog.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import { drepPath } from '@/lib/dreps/profile.js';

interface Props {
  // Resolved at build/SSR time from the deployment's network; defaults to preprod.
  network?: CardanoNetwork;
}

function targetFromButton(btn: HTMLElement): Target {
  return {
    drepId: btn.dataset.drepId ?? '',
    slug: btn.dataset.drepSlug || null,
    name: btn.dataset.drepName ?? '',
    credentialHex: btn.dataset.drepCred || null,
    isScript: btn.dataset.drepScript === '1',
  };
}

type Menu = { target: Target; right: number; top: number } | null;

export default function DrepActionsMenu({ network = 'preprod' }: Props) {
  const [menu, setMenu] = useState<Menu>(null);
  const [dialogTarget, setDialogTarget] = useState<Target | null>(null);
  const [copied, setCopied] = useState(false);

  // The row action buttons are server HTML outside this island's React root, so
  // a native document listener is the only way to catch their clicks. A second
  // role of the same listener: clicking anywhere outside the open popover closes
  // it. Scroll/resize also close it, since the popover is pinned to a viewport
  // coordinate that those invalidate.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      // The desktop "Delegate" quick-action opens the dialog straight away,
      // skipping the popover. Like the kebab, it is server HTML outside this
      // island's React root, so the document listener is what catches it.
      const del = el?.closest('[data-drep-delegate]') as HTMLElement | null;
      if (del) {
        // Same effect as openDelegate(), inlined with the stable state setters so
        // this [] effect needs no extra dependency.
        e.preventDefault();
        setMenu(null);
        setDialogTarget(targetFromButton(del));
        return;
      }
      const btn = el?.closest('[data-drep-action]') as HTMLElement | null;
      if (btn) {
        e.preventDefault();
        const rect = btn.getBoundingClientRect();
        setCopied(false);
        setMenu({ target: targetFromButton(btn), right: window.innerWidth - rect.right, top: rect.bottom + 4 });
        return;
      }
      if (!el?.closest('[data-drep-menu]')) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, []);

  function openDelegate(target: Target) {
    setMenu(null);
    setDialogTarget(target);
  }

  async function copyId(drepId: string) {
    try {
      await navigator.clipboard.writeText(drepId);
      setCopied(true);
    } catch {
      // Clipboard can be blocked (no permission / insecure context); ignore.
    }
  }

  return (
    <>
      {menu && (
        <div
          data-drep-menu
          className="drep-menu"
          role="menu"
          style={{ position: 'fixed', top: menu.top, right: menu.right }}
        >
          <button
            type="button"
            role="menuitem"
            className="drep-menu__item"
            disabled={!menu.target.credentialHex}
            onClick={() => openDelegate(menu.target)}
          >
            <svg className="drep-menu__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
            Delegate voting power
            {!menu.target.credentialHex && (
              <span className="drep-menu__hint">unavailable</span>
            )}
          </button>
          <hr className="drep-menu__sep" />
          <a role="menuitem" className="drep-menu__item" href={drepPath(menu.target)}>
            <svg className="drep-menu__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
            View profile
          </a>
          <a role="menuitem" className="drep-menu__item" href={`${drepPath(menu.target)}#voting-history`}>
            <svg className="drep-menu__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><polyline points="12 7 12 12 15 14" /></svg>
            View voting history
          </a>
          <button
            type="button"
            role="menuitem"
            className="drep-menu__item"
            onClick={() => void copyId(menu.target.drepId)}
          >
            <svg className="drep-menu__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
            {copied ? 'Copied' : 'Copy DRep ID'}
          </button>
        </div>
      )}

      {dialogTarget && (
        <DelegateDialog
          target={dialogTarget}
          network={network}
          onClose={() => setDialogTarget(null)}
        />
      )}
    </>
  );
}
