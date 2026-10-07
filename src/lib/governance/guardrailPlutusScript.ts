// The shipped guardrails script as an SDK Plutus V3 script. Kept apart from
// guardrailScript.ts so that leaf module stays free of SDK imports.
import { PlutusV3 } from '@evolution-sdk/evolution';
import { hexToBytes } from '../crypto/hex.js';
import { GUARDRAIL_SCRIPT_CBOR_HEX } from './guardrailScript.js';

export function guardrailPlutusScript(): PlutusV3.PlutusV3 {
  return new PlutusV3.PlutusV3({ bytes: hexToBytes(GUARDRAIL_SCRIPT_CBOR_HEX) });
}
