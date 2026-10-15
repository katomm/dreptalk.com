// What a new UTxO cost per byte means for the minimum ada of typical outputs:
// paired bars now and new on one fixed scale, and two tiles for the plain ada
// output and a reference script. Props only, so the governance action page
// can render it from a payload too.
import { memo } from 'react';
import { EXAMPLE_OUTPUTS, REFERENCE_SCRIPT_OUTPUT, barScaleMaxLovelace, minAdaLovelace } from '@/lib/governance/utxoImpact.js';
import { PARAM_DEFS } from '@/lib/governance/paramDefs.js';
import { LegendItem, Stat } from './chart.js';

const ada2 = (lovelace: bigint) =>
  (Number(lovelace) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SCALE = Number(barScaleMaxLovelace(PARAM_DEFS.utxoCostPerByte.max.n));

export default memo(function ImpactUtxoCost({ currentLovelace, nextLovelace }: { currentLovelace: bigint; nextLovelace: bigint }) {
  const minAda = (bytes: number) => ({ now: minAdaLovelace(bytes, currentLovelace), next: minAdaLovelace(bytes, nextLovelace) });
  const plain = minAda(EXAMPLE_OUTPUTS[0].bytes);
  const script = minAda(REFERENCE_SCRIPT_OUTPUT.bytes);
  const summary = `Plain ada output: ${ada2(plain.now)} ₳ now, ${ada2(plain.next)} ₳ new.`;
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
                {ada2(now)} → <b>{ada2(next)} ₳</b>
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
        <Stat label="Plain ada output" value={`${ada2(plain.next)} ₳`} from={`${ada2(plain.now)} ₳`} />
        <Stat label={REFERENCE_SCRIPT_OUTPUT.label} value={`${ada2(script.next)} ₳`} from={`${ada2(script.now)} ₳`} />
      </div>
      <p className="pcp-why">
        Minimum ada per output is (160 + output size in bytes) × cost per byte. It is checked only when a transaction creates an output, existing UTxOs keep their ada.
      </p>
    </>
  );
});
