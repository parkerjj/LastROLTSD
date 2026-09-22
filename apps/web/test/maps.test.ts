import { describe, expect, it } from 'vitest';
import { mapDetails, mapFilterOptions, mapMarkerPosition } from '../src/maps';

describe('market maps', () => {
  it.each([
    ['prontera', '普隆德拉', 312, 392, 156, 196, { left: 50, top: 50 }],
    ['morocc', '梦罗克', 320, 320, 0, 0, { left: 0, top: 100 }],
    ['payon', '斐扬', 300, 360, 300, 360, { left: 100, top: 0 }],
    ['geffen', '吉芬', 240, 240, 60, 180, { left: 25, top: 25 }],
  ])('maps %s to its Chinese name and correct left/top percentages', (code, name, _maxX, _maxY, x, y, position) => {
    expect(mapDetails(code)?.name).toBe(name);
    expect(mapMarkerPosition(code, x, y)).toEqual(position);
  });

  it('uses the available Payon map asset', () => {
    expect(mapDetails('payon')?.image).toContain('maps_xl/payon.gif');
  });

  it('submits database map codes while presenting Chinese map names', () => {
    expect(mapFilterOptions()).toEqual([
      { value: 'prontera', label: '普隆德拉' },
      { value: 'morocc', label: '梦罗克' },
      { value: 'payon', label: '斐扬' },
      { value: 'geffen', label: '吉芬' },
    ]);
  });
});
