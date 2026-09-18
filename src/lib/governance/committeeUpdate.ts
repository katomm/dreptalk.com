// Constitutional committee update validation: cold credential parsing and
// the UpdateCommittee field rules (expiry, conflicts, quorum). Pure logic
// only, no network and no D1, so the /ga/new form can depend on this leaf
// module directly.
import { decodeBech32 } from '../crypto/bech32.js';
import { bytesToHex } from '../crypto/hex.js';

/** A committee member's cold credential: a key hash or a script hash. */
export type ColdCredential = { hashHex: string; isScript: boolean };

/** A committee member as currently on chain, with its expiry epoch. */
export type CurrentMember = {
  hashHex: string;
  isScript: boolean;
  expirationEpoch: number | null;
};

/** One credential being added, with the epoch its term expires. */
export type AddedMember = { credential: ColdCredential; expiryEpoch: number };

/** A governance quorum threshold as a fraction. */
export type Quorum = { numerator: number; denominator: number };

/** The validated shape of an UpdateCommittee proposal, ready to submit. */
export type CommitteeUpdate = {
  remove: ColdCredential[];
  add: AddedMember[];
  quorum: Quorum;
};

export type ValidationError = { field: string; message: string };
export type ValidationWarning = { field: string; message: string };

export type ValidateCommitteeUpdateInput = {
  epoch: number;
  maxTermLength: number | null;
  current: CurrentMember[];
  remove: ColdCredential[];
  add: AddedMember[];
  quorum: Quorum | null;
  currentQuorum: Quorum | null;
};

export type ValidateCommitteeUpdateResult =
  | { ok: true; value: CommitteeUpdate; warnings: ValidationWarning[] }
  | { ok: false; errors: ValidationError[] };

const HEX_56_RE = /^[0-9a-f]{56}$/;
const CC_COLD_PREFIX = 'cc_cold';
const CC_COLD_KEY_HEADER = 0x12;
const CC_COLD_SCRIPT_HEADER = 0x13;

/**
 * Parses a cold credential from either 56 hex chars (kind given explicitly
 * by `hexKind`, since raw hex carries no key-vs-script marker) or a CIP-129
 * bech32 string with the single `cc_cold` prefix used for both kinds: a
 * 29-byte payload of a header byte (0x12 = key hash, 0x13 = script hash)
 * followed by the 28-byte hash. Returns null for anything else: wrong
 * prefix, wrong length, bad checksum, or an unrecognized header byte.
 */
export function parseColdCredential(
  input: string,
  hexKind: 'key' | 'script',
): ColdCredential | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const lowered = trimmed.toLowerCase();
  if (HEX_56_RE.test(lowered)) {
    return { hashHex: lowered, isScript: hexKind === 'script' };
  }

  if (/^cc_cold1[a-z0-9]+$/.test(lowered)) {
    try {
      const { prefix, data } = decodeBech32(lowered);
      if (prefix !== CC_COLD_PREFIX) return null;
      if (data.length !== 29) return null;
      const header = data[0];
      if (header !== CC_COLD_KEY_HEADER && header !== CC_COLD_SCRIPT_HEADER) return null;
      return { hashHex: bytesToHex(data.slice(1)), isScript: header === CC_COLD_SCRIPT_HEADER };
    } catch {
      return null;
    }
  }

  return null;
}

function credentialKey(c: { hashHex: string; isScript: boolean }): string {
  return `${c.hashHex.toLowerCase()}:${c.isScript}`;
}

function isNonNegativeInteger(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

function isPositiveInteger(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

function quorumsEqual(a: Quorum, b: Quorum): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}

/**
 * Validates an UpdateCommittee proposal's fields: each added credential's
 * expiry, conflicts between the add and remove lists, an added credential
 * that is already a current member (warning, not an error, since re-adding
 * with a new expiry is a legitimate way to extend a term), the quorum
 * fraction, and that the proposal actually changes something.
 */
export function validateCommitteeUpdate(
  input: ValidateCommitteeUpdateInput,
): ValidateCommitteeUpdateResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  const removeKeys = new Set(input.remove.map(credentialKey));
  const seenAddKeys = new Set<string>();
  const currentByKey = new Map(input.current.map(c => [credentialKey(c), c]));

  input.add.forEach((entry, i) => {
    const key = credentialKey(entry.credential);

    if (entry.expiryEpoch <= input.epoch) {
      errors.push({
        field: `add[${i}].expiryEpoch`,
        message: 'expiry epoch must be after the current epoch',
      });
    } else if (
      input.maxTermLength != null &&
      entry.expiryEpoch > input.epoch + input.maxTermLength
    ) {
      errors.push({
        field: `add[${i}].expiryEpoch`,
        message:
          'expiry epoch is beyond the maximum committee term, the action could pass the vote and still never ratify',
      });
    }

    if (removeKeys.has(key)) {
      errors.push({
        field: `add[${i}].credential`,
        message: 'credential is in both the add and remove lists',
      });
    }

    if (seenAddKeys.has(key)) {
      errors.push({
        field: `add[${i}].credential`,
        message: 'credential is listed more than once in add',
      });
    }
    seenAddKeys.add(key);

    if (currentByKey.has(key)) {
      warnings.push({
        field: `add[${i}].credential`,
        message: 'credential is already a current committee member, this extends its term',
      });
    }
  });

  input.remove.forEach((c, i) => {
    if (seenAddKeys.has(credentialKey(c))) {
      errors.push({
        field: `remove[${i}]`,
        message: 'credential is in both the add and remove lists',
      });
    }
  });

  if (input.quorum == null) {
    errors.push({ field: 'quorum.numerator', message: 'quorum is required' });
  } else {
    const { numerator, denominator } = input.quorum;
    if (!isNonNegativeInteger(numerator)) {
      errors.push({
        field: 'quorum.numerator',
        message: 'quorum numerator must be a non-negative integer',
      });
    }
    if (!isPositiveInteger(denominator)) {
      errors.push({
        field: 'quorum.denominator',
        message: 'quorum denominator must be a positive integer',
      });
    }
    if (
      isNonNegativeInteger(numerator) &&
      isPositiveInteger(denominator) &&
      numerator > denominator
    ) {
      errors.push({
        field: 'quorum.numerator',
        message: 'quorum numerator cannot exceed the denominator',
      });
    }
  }

  const quorumChanged =
    input.quorum != null &&
    (input.currentQuorum == null || !quorumsEqual(input.quorum, input.currentQuorum));
  const hasMembershipChange = input.add.length > 0 || input.remove.length > 0;

  if (!hasMembershipChange && !quorumChanged && errors.length === 0) {
    errors.push({ field: 'changes', message: 'nothing to change' });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      remove: input.remove,
      add: input.add,
      // input.quorum is non-null here: the null and invalid-shape cases above
      // both push an error and return before this point.
      quorum: input.quorum as Quorum,
    },
    warnings,
  };
}
