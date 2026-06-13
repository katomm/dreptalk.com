// React island: the "Delegate voting power" call to action on a DRep profile.
// Renders a single primary button that opens the shared DelegateDialog with the
// profile's DRep as the target. The heavy tx bundle stays lazy (loaded inside
// the dialog at submit time), so the profile page ships only this small island.
import { useState } from 'react';
import DelegateDialog, { type Target } from '@/components/DelegateDialog.js';
import type { CardanoNetwork } from '@/lib/config/network.js';

interface Props {
  target: Target;
  // Resolved at SSR time from the deployment's network; defaults to preprod.
  network?: CardanoNetwork;
}

export default function DelegateButton({ target, network = 'preprod' }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
        Delegate voting power to this DRep
      </button>
      {open && (
        <DelegateDialog target={target} network={network} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
