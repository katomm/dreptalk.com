import { describe, it, expect } from 'vitest';
import { parseLegalInfo } from './legal.ts';

describe('parseLegalInfo', () => {
  it('parses configured values and splits the address on "|"', () => {
    const info = parseLegalInfo({
      LEGAL_OPERATOR_NAME: 'Jane Doe',
      LEGAL_OPERATOR_ADDRESS: 'Some Street 1 | 12345 City | Germany',
      LEGAL_CONTACT_EMAIL: 'legal@example.com',
      LEGAL_VAT_ID: 'DE123456789',
    });
    expect(info.operatorName).toBe('Jane Doe');
    expect(info.addressLines).toEqual(['Some Street 1', '12345 City', 'Germany']);
    expect(info.email).toBe('legal@example.com');
    expect(info.vatId).toBe('DE123456789');
    expect(info.responsiblePerson).toBe('Jane Doe'); // defaults to the operator
    expect(info.configured).toBe(true);
  });

  it('falls back to placeholders and is not configured when unset', () => {
    const info = parseLegalInfo({});
    expect(info.operatorName).toBe('(not configured)');
    expect(info.addressLines).toEqual(['(not configured)']);
    expect(info.phone).toBeNull();
    expect(info.vatId).toBeNull();
    expect(info.configured).toBe(false);
  });

  it('uses an explicit responsible person when given', () => {
    const info = parseLegalInfo({
      LEGAL_OPERATOR_NAME: 'Acme',
      LEGAL_RESPONSIBLE_PERSON: 'Editor Name',
    });
    expect(info.responsiblePerson).toBe('Editor Name');
  });
});
