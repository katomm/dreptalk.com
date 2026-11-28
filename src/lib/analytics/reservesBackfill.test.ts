import { describe, it, expect } from 'vitest';
import { reservesBackfillSql } from './reservesBackfill.js';

describe('reservesBackfillSql', () => {
  it('guards every update by the stored treasury value of the same network', () => {
    const sql = reservesBackfillSql('mainnet', [{ epoch_no: 508, treasury: '1500', reserves: '6000' }]);
    expect(sql).toContain('-- network=mainnet');
    expect(sql).toContain(
      "UPDATE governance_epoch_stats SET reserves_lovelace = '6000' WHERE epoch = 508 AND reserves_lovelace IS NULL AND treasury_lovelace = '1500';",
    );
  });

  it('rejects values that are not plain digits', () => {
    expect(() => reservesBackfillSql('preprod', [{ epoch_no: 1, treasury: "1'; DROP", reserves: '2' }])).toThrow();
    expect(() => reservesBackfillSql('preprod', [{ epoch_no: 1.5, treasury: '1', reserves: '2' }])).toThrow();
  });
});
