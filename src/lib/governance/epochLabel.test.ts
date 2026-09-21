// Tests for epochWithDate: an epoch number plus the calendar date its
// boundary falls on, on both networks, and the "about" qualifier that drops
// for the epoch currently running.
import { describe, expect, it } from 'vitest';
import { epochWithDate } from './epochLabel.js';
import { resolveNetwork, epochStartMs } from '../config/network.js';

const mainnet = resolveNetwork('mainnet');
const preprod = resolveNetwork('preprod');

describe('epochWithDate', () => {
  it('formats a mainnet epoch as en-GB day-month-year with an "about" qualifier by default', () => {
    // Epoch 208 is the mainnet anchor itself: 2020-07-29T21:44:51Z.
    const now = epochStartMs(300, mainnet);
    expect(epochWithDate(208, mainnet, now)).toBe('epoch 208 (about 29 Jul 2020)');
  });

  it('formats a preprod epoch as en-GB day-month-year with an "about" qualifier by default', () => {
    // Epoch 4 is the preprod anchor itself: 2022-06-21T00:00:00Z.
    const now = epochStartMs(300, preprod);
    expect(epochWithDate(4, preprod, now)).toBe('epoch 4 (about 21 Jun 2022)');
  });

  it('drops the "about" qualifier when the epoch is the one currently running', () => {
    // now sits partway through epoch 300, so 300 is the current epoch.
    const now = epochStartMs(300, preprod) + 24 * 60 * 60 * 1000;
    expect(epochWithDate(300, preprod, now)).toBe(`epoch 300 (${formatted(300, preprod)})`);
  });

  it('keeps the "about" qualifier for an epoch other than the one currently running', () => {
    const now = epochStartMs(300, preprod) + 24 * 60 * 60 * 1000;
    expect(epochWithDate(301, preprod, now)).toBe(`epoch 301 (about ${formatted(301, preprod)})`);
    expect(epochWithDate(299, preprod, now)).toBe(`epoch 299 (about ${formatted(299, preprod)})`);
  });

  it('defaults now to the current time when omitted', () => {
    // Both networks are long past their anchor, so a far-past epoch always gets "about".
    expect(epochWithDate(208, mainnet)).toBe('epoch 208 (about 29 Jul 2020)');
  });
});

function formatted(epoch: number, cfg: ReturnType<typeof resolveNetwork>): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(
    new Date(epochStartMs(epoch, cfg)),
  );
}
