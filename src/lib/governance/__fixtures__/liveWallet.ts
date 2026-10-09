// Shared setup for the gated live preprod tests. They run only with
// DREPTALK_LIVE=1, and then need PREPROD_TEST_WALLET_MNEMONIC exported in the
// shell: the BIP39 mnemonic of a funded preprod test wallet whose account 0
// DRep key is registered on preprod. The mnemonic comes from the environment
// only and must never be committed or logged.
import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import * as E from '@evolution-sdk/evolution';
import { addressFromSeed } from '@evolution-sdk/evolution/sdk/wallet/Derivation';
import { Address } from '@evolution-sdk/evolution';
import { blake2b224 } from '../../crypto/blake.js';

const MNEMONIC = process.env.PREPROD_TEST_WALLET_MNEMONIC ?? '';

export const LIVE = process.env.DREPTALK_LIVE === '1';

// Asking for a live run without the wallet fails loudly instead of skipping,
// so `npm run test:live` can never pass with nothing run.
if (LIVE && MNEMONIC === '') {
  throw new Error('DREPTALK_LIVE=1 needs PREPROD_TEST_WALLET_MNEMONIC in the environment');
}

export const PREPROD_KOIOS = 'https://preprod.koios.rest/api/v1';

// The public key and a detached signer for one key of the test wallet.
function deriveKey(path: string) {
  const entropy = mnemonicToEntropy(MNEMONIC, wordlist);
  const root = E.Bip32PrivateKey.fromBip39Entropy(entropy, '');
  const prv = E.Bip32PrivateKey.toPrivateKey(E.Bip32PrivateKey.derivePath(root, path));
  const pubKey = E.VKey.toBytes(E.PrivateKey.toPublicKey(prv));
  const sign = (msg: Uint8Array) => E.Ed25519Signature.toBytes(E.PrivateKey.sign(prv, msg));
  return { pubKey, sign };
}

// Derive the DRep signing material (account 0, role 3, index 0) and the
// account 0 base payment address from the test wallet mnemonic.
export function loadDrepKey() {
  const { pubKey, sign } = deriveKey("1852'/1815'/0'/3/0");
  const paymentAddress = Address.toBech32(addressFromSeed(MNEMONIC, { networkId: 0 }).address);
  return { paymentAddress, pubKey, keyHash: blake2b224(pubKey), sign };
}

// The account 0 payment key (role 0, index 0), which signs for the inputs of
// the base payment address, the way the wallet's own signTx does.
export function loadPaymentKey() {
  return deriveKey("1852'/1815'/0'/0/0");
}
