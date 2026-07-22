import { describe, expect, it } from 'vitest';
import { inviteUrl, parseJoinHash } from '../src/deeplink';

describe('deep link', () => {
  it('parses #/join/<CODE> and uppercases', () => {
    expect(parseJoinHash('#/join/XKCD42')).toBe('XKCD42');
    expect(parseJoinHash('#/join/ab12cd')).toBe('AB12CD');
  });

  it('rejects everything else', () => {
    expect(parseJoinHash('')).toBeNull();
    expect(parseJoinHash('#/join/')).toBeNull();
    expect(parseJoinHash('#/join/with spaces')).toBeNull();
    expect(parseJoinHash('#/other/XKCD42')).toBeNull();
    expect(parseJoinHash('#/join/WAY-TOO-LONG-FOR-A-CODE')).toBeNull();
  });

  it('builds the invite URL the Home screen parses back', () => {
    const url = inviteUrl('https://night.example.com/', 'XKCD42');
    expect(url).toBe('https://night.example.com/#/join/XKCD42');
    expect(parseJoinHash(new URL(url).hash)).toBe('XKCD42');
  });
});
