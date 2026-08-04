// Curated Net Change Limit periods. An NCL is set by an InfoAction, which never
// enacts on-chain and carries no ledger-queryable value; competing InfoActions
// target the same window with different amounts. So the operative NCL for each
// period is a human call recorded here: the authoritative defining action(s)
// plus curated challengers surfaced transparently. Everything else (consumed,
// remaining) is computed live from enacted TreasuryWithdrawals.
export interface NclPeriod {
  /** Stable slug, e.g. "2026-27". Used in the OG route and anchors. */
  id: string;
  label: string;
  /** Effective ceiling after any extension, in lovelace. */
  ceilingLovelace: bigint;
  startEpoch: number;
  /** Effective end epoch after any extension (inclusive). */
  endEpoch: number;
  /** Authoritative action id(s) that establish/extend this NCL: "txHash#index". */
  definingActionIds: string[];
  /** Curated competing/challenging action ids for the same window (may be empty). */
  relatedActionIds: string[];
}

export const NCL_PERIODS: NclPeriod[] = [
  {
    id: '2025',
    label: '2025 Net Change Limit',
    ceilingLovelace: 350_000_000_000_000n,
    startEpoch: 532,
    endEpoch: 612, // original 532 to 604, extended by 8 epochs to 612
    definingActionIds: [
      '9b62b3c632f329016a968ac25211825bb4f84b12461121c7da3aa11df92370f9#0',
      'd16dffbae9d86a73cb343506e6712d79c278096dc25e8ba6900eb24522726bba#0',
    ],
    relatedActionIds: [],
  },
  {
    id: '2026-27',
    label: '2026 to 2027 Net Change Limit',
    // Original 350M, raised to 500M by the second defining action (closed
    // Aug 2026 with 62.4% DRep approval).
    ceilingLovelace: 500_000_000_000_000n,
    startEpoch: 613,
    endEpoch: 713, // 2026-02-13 to 2027-07-03
    definingActionIds: [
      'dc4c679c8cf1cec49817d4d2c1c96cd802ec8a047a11dc0b0bb125b5af0a76cd#0', // original 350M
      'a75645e0871f3dbb6207df867d9bd6a1a3a5befa40d68df6da651db4d6607fbf#0', // raise to 500M
    ],
    relatedActionIds: [
      '73a4eb2148781c37ef37c90a33a1d3d00511a8eefe9cdfaa1ea593b090f23f96#0', // proposed 300M, lost
    ],
  },
];

export function getNclPeriod(id: string): NclPeriod | undefined {
  return NCL_PERIODS.find((p) => p.id === id);
}
