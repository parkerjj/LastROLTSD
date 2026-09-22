export type MapDetails = {
  code: string;
  name: string;
  maxX: number;
  maxY: number;
  image: string;
  aliases: readonly string[];
};

const MAPS: readonly MapDetails[] = [
  { code: 'prontera', name: '普隆德拉', maxX: 312, maxY: 392, image: 'maps_xl/prontera_re.gif', aliases: ['prontera', '普隆德拉'] },
  { code: 'morocc', name: '梦罗克', maxX: 320, maxY: 320, image: 'maps_xl/morocc_re.gif', aliases: ['morocc', '梦罗克'] },
  { code: 'payon', name: '斐扬', maxX: 300, maxY: 360, image: 'maps_xl/payon.gif', aliases: ['payon', '斐扬'] },
  { code: 'geffen', name: '吉芬', maxX: 240, maxY: 240, image: 'maps_xl/geffen.gif', aliases: ['geffen', '吉芬'] },
];

export function mapDetails(value: string): MapDetails | undefined {
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase();
  return MAPS.find((map) => map.aliases.some((alias) => normalized.includes(alias)));
}

export function mapFilterOptions(): Array<{ value: string; label: string }> {
  return MAPS.map((map) => ({ value: map.code, label: map.name }));
}

export function mapMarkerPosition(mapName: string, x: number, y: number): { left: number; top: number } {
  const map = mapDetails(mapName);
  if (!map || !Number.isFinite(x) || !Number.isFinite(y)) return { left: 50, top: 50 };
  const boundedX = Math.max(0, Math.min(map.maxX, x));
  const boundedY = Math.max(0, Math.min(map.maxY, y));
  return {
    left: Number((boundedX / map.maxX * 100).toFixed(4)),
    top: Number((100 - boundedY / map.maxY * 100).toFixed(4)),
  };
}
