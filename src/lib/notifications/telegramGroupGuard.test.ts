// Pure parts of the group guard: config parsing and the suspicious-message
// rule. No KV, no Telegram traffic, so these run in the node project.
import { describe, it, expect, vi } from 'vitest';
import { parseGroupGuardConfig, isSuspiciousMessage, GROUP_GUARD_DEFAULTS } from './telegramGroupGuard.js';

describe('parseGroupGuardConfig', () => {
  it('returns the defaults when the value is missing or empty', () => {
    expect(parseGroupGuardConfig(undefined)).toEqual(GROUP_GUARD_DEFAULTS);
    expect(parseGroupGuardConfig('')).toEqual(GROUP_GUARD_DEFAULTS);
  });

  it('overrides only the fields present in the JSON', () => {
    const cfg = parseGroupGuardConfig('{"watchHours":72,"patterns":["airdrop"]}');
    expect(cfg.watchHours).toBe(72);
    expect(cfg.patterns.map(String)).toEqual(['/airdrop/i']);
    expect(cfg.cleanMessages).toBe(GROUP_GUARD_DEFAULTS.cleanMessages);
    expect(cfg.strikesToBan).toBe(GROUP_GUARD_DEFAULTS.strikesToBan);
  });

  it('falls back to the defaults on malformed JSON or wrong types, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseGroupGuardConfig('{not json')).toEqual(GROUP_GUARD_DEFAULTS);
    expect(parseGroupGuardConfig('{"watchHours":"soon","strikesToBan":0}')).toEqual(GROUP_GUARD_DEFAULTS);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('isSuspiciousMessage', () => {
  const bot = 'DRepTalkBot';
  const plain = (text: string, extra: Record<string, unknown> = {}) => ({ text, ...extra });

  it('lets plain text through', () => {
    expect(isSuspiciousMessage(plain('hello everyone, new here'), bot, [])).toBe(false);
  });

  it('flags url, text_link, mention and text_mention entities', () => {
    const entity = (type: string) => plain('x', { entities: [{ type, offset: 0, length: 1 }] });
    for (const type of ['url', 'text_link', 'mention', 'text_mention']) {
      expect(isSuspiciousMessage(entity(type), bot, [])).toBe(true);
    }
    expect(isSuspiciousMessage(entity('bold'), bot, [])).toBe(false);
  });

  it('flags entities in a media caption as well', () => {
    const msg = { caption: 'see', caption_entities: [{ type: 'url', offset: 0, length: 3 }] };
    expect(isSuspiciousMessage(msg, bot, [])).toBe(true);
  });

  it('ignores a mention of the bot itself', () => {
    const msg = plain('@DRepTalkBot hi', { entities: [{ type: 'mention', offset: 0, length: 12 }] });
    expect(isSuspiciousMessage(msg, bot, [])).toBe(false);
  });

  it('flags forwards and inline keyboards', () => {
    expect(isSuspiciousMessage(plain('x', { forward_origin: { type: 'channel' } }), bot, [])).toBe(true);
    expect(isSuspiciousMessage(plain('x', { reply_markup: { inline_keyboard: [[]] } }), bot, [])).toBe(true);
  });

  it('flags raw links that carry no entity', () => {
    expect(isSuspiciousMessage(plain('join t.me/freeada'), bot, [])).toBe(true);
    expect(isSuspiciousMessage(plain('go to https://example.org'), bot, [])).toBe(true);
    expect(isSuspiciousMessage(plain('dm me on telegram dot me slash x'), bot, [])).toBe(false);
  });

  it('flags configured patterns case-insensitively', () => {
    const { patterns } = parseGroupGuardConfig('{"patterns":["airdrop"]}');
    expect(isSuspiciousMessage(plain('Free AIRDROP for holders'), bot, patterns)).toBe(true);
    expect(isSuspiciousMessage(plain('nothing here'), bot, patterns)).toBe(false);
  });

  it('an invalid pattern in the config is skipped, the others still apply', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { patterns } = parseGroupGuardConfig('{"patterns":["(unclosed","airdrop"]}');
    expect(patterns).toHaveLength(1);
    expect(isSuspiciousMessage(plain('airdrop!'), bot, patterns)).toBe(true);
    warn.mockRestore();
  });
});
