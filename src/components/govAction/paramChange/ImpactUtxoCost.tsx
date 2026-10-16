// What a new UTxO cost per byte means for the minimum ada of typical outputs:
// paired bars now and new on one fixed scale, and two tiles for the plain ada
// output and a reference script. Props only, so the governance action page
// can render it from a payload too.
import { memo } from 'react';
import { EXAMPLE_OUTPUTS, REFERENCE_SCRIPT_OUTPUT, barScaleMaxLovelace, minAdaLovelace } from '@/lib/governance/utxoImpact.js';
import { PARAM_DEFS } from '@/lib/governance/paramDefs.js';
import { LegendItem, Stat } from './chart.js';

// Three decimals, so the plain ada row reads like a wallet's send screen
// (0.996 for 0.995610). Rounded half up in lovelace, no float on the way.
const adaText = (lovelace: bigint) => {
  const thousandths = (lovelace + 500n) / 1000n;
  return `${(thousandths / 1000n).toLocaleString('en-US')}.${(thousandths % 1000n).toString().padStart(3, '0')}`;
};
const SCALE = Number(barScaleMaxLovelace(PARAM_DEFS.utxoCostPerByte.max.n));

export default memo(function ImpactUtxoCost({ currentLovelace, nextLovelace }: { currentLovelace: bigint; nextLovelace: bigint }) {
  const minAda = (bytes: number) => ({ now: minAdaLovelace(bytes, currentLovelace), next: minAdaLovelace(bytes, nextLovelace) });
  const plain = minAda(EXAMPLE_OUTPUTS[0].bytes);
  const script = minAda(REFERENCE_SCRIPT_OUTPUT.bytes);
  const summary = `Plain ada output: ${adaText(plain.now)} ₳ now, ${adaText(plain.next)} ₳ new.`;
  const width = (lovelace: bigint) => `${(Number(lovelace) / SCALE) * 100}%`;
  return (
    <>
      <fieldset className="pcp-utxo" aria-label={summary}>
        {EXAMPLE_OUTPUTS.map((out) => {
          const { now, next } = minAda(out.bytes);
          return (
            <div key={out.id} className="pcp-utxo__row">
              <span className="pcp-utxo__name">
                {out.label}
                <span className="pcp-utxo__bytes">{out.bytes} bytes</span>
              </span>
              <span className="pcp-utxo__bars" aria-hidden="true">
                <i className="pcp-utxo__bar pcp-utxo__bar--now" style={{ width: width(now) }} />
                <i className="pcp-utxo__bar pcp-utxo__bar--new" style={{ width: width(next) }} />
              </span>
              <span className="pcp-utxo__val">
                {adaText(now)} <span aria-hidden="true">→</span> <b>{adaText(next)} ₳</b>
              </span>
            </div>
          );
        })}
      </fieldset>
      <div className="pcp-legend">
        <LegendItem color="var(--pcp-bar)">Now</LegendItem>
        <LegendItem color="var(--accent)">New</LegendItem>
      </div>
      <div className="pcp-stats">
        <Stat label="Plain ada output" value={`${adaText(plain.next)} ₳`} from={`${adaText(plain.now)} ₳`} />
        <Stat label={REFERENCE_SCRIPT_OUTPUT.label} value={`${adaText(script.next)} ₳`} from={`${adaText(script.now)} ₳`} />
      </div>
      <p className="pcp-why">
        Minimum ada per output is (160 + output size in bytes) × cost per byte, with output sizes as wallets count them. It is checked only when a transaction creates an output, existing UTxOs keep their ada.
      </p>
    </>
  );
});
