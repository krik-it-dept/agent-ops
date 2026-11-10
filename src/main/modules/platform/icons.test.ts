import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Frozen approved asset hashes; the retired Go/web source copies are no longer needed.
const hashes: Record<string, string> = {
  'app-dark.ico':
    'b3ce4681c428c73d1c893cdfedb7d53700267572c15275a6b96812f3d422b468',
  'app-dark.png':
    'a455ff1abac440dcc9292b737a76b26a8bca19b99c83e8124f731c1900861e91',
  'app-light.ico':
    '5ec76ec704aeaa3fc4d4a6c53128309b590152d380c2aa0b3db5c0a81871b9aa',
  'app-light.png':
    'f39fe57ce4715dc02df09f1d9188b3d5cc82a078dfb4d6e4139e011554ecb915',
  'app.ico': 'a8f78e67cda4c4e9e20bae4f72df373bcef1cf9980a2c406f55c9a709d095a99',
  'app.png': 'c695fe79de739a95999009e02864bc5673f72a38a46a6c214cfbe63ffacadd8e',
  'source-dark.svg':
    '890e6f364b00626966192b81b0f3a8999ba28d313239240678d50e0f89bc7c4c',
  'source-light.svg':
    'af9f96aa7729a53ac286645a73868a9ada07a957b509f0a68bcdea1db611578e',
  'source-tile.svg':
    '550c31d496a2cb059aeb61e13e13e8f00654fe97dcfc06c4e1f142d3277eeb27',
};

describe('copied native ledger icons', () => {
  it.each([
    'app.ico',
    'app-light.ico',
    'app-dark.ico',
    'app.png',
    'app-light.png',
    'app-dark.png',
  ])('preserves the approved raster bytes: %s', async (file) => {
    expect(
      createHash('sha256')
        .update(await readFile(resolve('resources/icons', file)))
        .digest('hex'),
    ).toBe(hashes[file]);
  });
  it.each(['source-light.svg', 'source-dark.svg', 'source-tile.svg'])(
    'preserves the original artwork: %s',
    async (file) => {
      expect(
        createHash('sha256')
          .update(await readFile(resolve('resources/icons', file)))
          .digest('hex'),
      ).toBe(hashes[file]);
    },
  );
  it.each(['app.ico', 'app-light.ico', 'app-dark.ico'])(
    'contains all five valid native resolutions: %s',
    async (file) => {
      const bytes = await readFile(resolve('resources/icons', file));
      expect(bytes.readUInt16LE(0)).toBe(0);
      expect(bytes.readUInt16LE(2)).toBe(1);
      expect(bytes.readUInt16LE(4)).toBe(5);
      const sizes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const offset = 6 + i * 16,
          width = bytes[offset] || 256,
          height = bytes[offset + 1] || 256;
        expect(width).toBe(height);
        sizes.push(width);
        const length = bytes.readUInt32LE(offset + 8),
          start = bytes.readUInt32LE(offset + 12);
        expect(start + length).toBeLessThanOrEqual(bytes.length);
        expect(bytes.subarray(start, start + 8)).toEqual(
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
        expect(bytes.readUInt32BE(start + 16)).toBe(width);
        expect(bytes.readUInt32BE(start + 20)).toBe(height);
      }
      expect(sizes).toEqual([16, 24, 32, 48, 256]);
    },
  );
});
