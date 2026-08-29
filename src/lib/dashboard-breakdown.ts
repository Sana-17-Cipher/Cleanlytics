export type BreakdownView = 'empty' | 'donut' | 'treemap' | 'table';
export type BreakdownMode =
  | 'auto'
  | 'map'
  | 'donut'
  | 'treemap'
  | 'bubble'
  | 'radial'
  | 'waffle'
  | 'table'
  | 'kpi';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

const INDIA_GEO_POINTS: Readonly<Record<string, GeoPoint>> = {
  'andhra pradesh': { latitude: 15.91, longitude: 79.74 },
  assam: { latitude: 26.2, longitude: 92.94 },
  bihar: { latitude: 25.1, longitude: 85.31 },
  chhattisgarh: { latitude: 21.28, longitude: 81.87 },
  delhi: { latitude: 28.61, longitude: 77.21 },
  goa: { latitude: 15.3, longitude: 74.12 },
  gujarat: { latitude: 22.26, longitude: 71.19 },
  haryana: { latitude: 29.06, longitude: 76.09 },
  'himachal pradesh': { latitude: 31.1, longitude: 77.17 },
  jharkhand: { latitude: 23.61, longitude: 85.28 },
  karnataka: { latitude: 15.32, longitude: 75.71 },
  kerala: { latitude: 10.85, longitude: 76.27 },
  'madhya pradesh': { latitude: 22.97, longitude: 78.66 },
  maharashtra: { latitude: 19.75, longitude: 75.71 },
  'new delhi': { latitude: 28.61, longitude: 77.21 },
  odisha: { latitude: 20.95, longitude: 85.1 },
  punjab: { latitude: 31.15, longitude: 75.34 },
  rajasthan: { latitude: 27.02, longitude: 74.22 },
  'tamil nadu': { latitude: 11.13, longitude: 78.66 },
  telangana: { latitude: 18.11, longitude: 79.02 },
  'uttar pradesh': { latitude: 26.85, longitude: 80.95 },
  uttarakhand: { latitude: 30.07, longitude: 79.02 },
  'west bengal': { latitude: 22.99, longitude: 87.85 },
  ahmedabad: { latitude: 23.02, longitude: 72.57 },
  bengaluru: { latitude: 12.97, longitude: 77.59 },
  bangalore: { latitude: 12.97, longitude: 77.59 },
  chennai: { latitude: 13.08, longitude: 80.27 },
  hyderabad: { latitude: 17.39, longitude: 78.49 },
  jaipur: { latitude: 26.91, longitude: 75.79 },
  kolkata: { latitude: 22.57, longitude: 88.36 },
  mumbai: { latitude: 19.08, longitude: 72.88 },
  nagpur: { latitude: 21.15, longitude: 79.09 },
  pune: { latitude: 18.52, longitude: 73.86 },
  surat: { latitude: 21.17, longitude: 72.83 },
};

function normaliseLocation(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ');
}

/** Coordinates are only returned for labels we genuinely recognise. */
export function geoPointFor(label: string): GeoPoint | null {
  return INDIA_GEO_POINTS[normaliseLocation(label)] ?? null;
}

/** Keep every honest display available; add Map only when most points can be placed. */
export function availableBreakdownModes(role: string, labels: readonly string[]): BreakdownMode[] {
  const standard: BreakdownMode[] = [
    'auto', 'donut', 'treemap', 'bubble', 'radial', 'waffle', 'table', 'kpi',
  ];
  if (labels.length < 2) return standard;
  const located = labels.filter((label) => geoPointFor(label) !== null).length;
  const locationEvidence = role === 'geographic' ? located >= 2 : located === labels.length;
  return locationEvidence && located / labels.length >= 0.6
    ? ['auto', 'map', ...standard.slice(1)]
    : standard;
}

/** Pick a view that stays readable and does not distort non-positive values. */
export function selectBreakdownView(values: readonly number[]): BreakdownView {
  if (values.length === 0) return 'empty';
  if (values.length === 1 || values.some((value) => value < 0)) return 'table';
  if (values.reduce((sum, value) => sum + value, 0) <= 0) return 'table';
  if (values.length <= 5) return 'donut';
  if (values.length <= 12) return 'treemap';
  return 'table';
}
