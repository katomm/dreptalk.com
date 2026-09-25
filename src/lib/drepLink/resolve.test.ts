import { describe, it, expect } from 'vitest';
import { routeFor } from './resolve.js';
import { decodeBech32, encodeBech32 } from '../crypto/bech32.js';

const u = (p: string) => new URL(`https://drep.link${p}`);
const ID = 'drep1yftc8zs7gjcj4a9nxzplz4wg6cwweya0kxp8adnw59vsyrqvrysud';
const VKH = encodeBech32('drep_vkh', decodeBech32(ID).data.slice(1));

describe('routeFor', () => {
  it('serves the landing page and robots.txt', () => {
    expect(routeFor(u('/'))).toEqual({ kind: 'landing' });
    expect(routeFor(u('/robots.txt'))).toEqual({ kind: 'robots' });
  });
  it('turns the lookup form into a redirect to the normalized handle', () => {
    expect(routeFor(u('/?h=%20ADAtainment%20'))).toEqual({ kind: 'lookup', to: '/adatainment' });
    expect(routeFor(u('/?h='))).toEqual({ kind: 'landing' });
  });
  it('lowercases handles and tolerates a trailing slash and a query string', () => {
    expect(routeFor(u('/ADAtainment/'))).toEqual({ kind: 'handle', handle: 'adatainment' });
    expect(routeFor(u('/adatainment?utm_source=x'))).toEqual({ kind: 'handle', handle: 'adatainment' });
  });
  it('resolves CIP-129 and CIP-105 key ids to the CIP-129 id', () => {
    expect(routeFor(u(`/${ID}`))).toEqual({ kind: 'id', drepId: ID });
    expect(routeFor(u(`/${VKH}`))).toEqual({ kind: 'id', drepId: ID });
  });
  it('sends deep paths, invalid ids and junk to search with a capped query', () => {
    expect(routeFor(u('/adatainment/votes'))).toEqual({ kind: 'search', q: 'adatainment votes' });
    expect(routeFor(u('/drep1notreallyanid'))).toEqual({ kind: 'search', q: 'drep1notreallyanid' });
    expect(routeFor(u(`/${'x'.repeat(200)}`))).toEqual({ kind: 'search', q: 'x'.repeat(64) });
    expect(routeFor(u('/foo%20bar'))).toEqual({ kind: 'search', q: 'foo bar' });
  });
});
