// React island: the "Delegate voting power" call to action on a DRep profile.
// Renders a single primary button that opens the shared DelegateDialog with the
// profile's DRep as the target. The heavy tx bundle stays lazy (loaded inside
// the dialog at submit time), so the profile page ships only this small island.
import { useState } from 'react';
import DelegateDialog, { type Target, type DelegateSource } from '@/components/DelegateDialog.js';
import type { CardanoNetwork } from '@/lib/config/network.js';
import type { TrackingViewer } from '@/lib/delegation/trackingOffer.js';

interface Props {
  target: Target;
  // Resolved at SSR time from the deployment's network; defaults to preprod.
  network?: CardanoNetwork;
  // The viewer's session, read server side by the mounting page. Required: an
  // anonymous default would send a signed-in person to a login they do not need.
  viewer: TrackingViewer;
  source?: DelegateSource;
}

export default function DelegateButton({ target, network = 'preprod', viewer, source }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        aria-label="Delegate voting power to this DRep"
        onClick={() => setOpen(true)}
      >
        Delegate
      </button>
      {open && (
        <DelegateDialog target={target} network={network} viewer={viewer} source={source} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
