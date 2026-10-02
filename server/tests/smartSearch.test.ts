import { describe, expect, it } from 'vitest';
import { parseQuery } from '../src/services/nlParse.js';

describe('natural-language parser', () => {
  const now = new Date(2026, 9, 2, 10, 0);
  it('parses the spec example', () => {
    const c = parseQuery('I need a room for 80 people tomorrow from 3-5 PM with a projector', now);
    expect(c.capacity).toBe(80); expect(c.facilities).toEqual(['Projector']);
    expect(c.start).toEqual(new Date(2026, 9, 3, 15, 0)); expect(c.end).toEqual(new Date(2026, 9, 3, 17, 0));
  });
  it('infers am when the range crosses noon', () => {
    const c = parseQuery('lab with pcs 11-1pm', now);
    expect(c.type).toBe('COMPUTER_LAB'); expect(c.start!.getHours()).toBe(11); expect(c.end!.getHours()).toBe(13);
  });
});
