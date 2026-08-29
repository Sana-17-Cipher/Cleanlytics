/**
 * Shared display formatting.
 *
 * Kept in one place so the same number never appears two different ways on two
 * different screens.
 */

import type { Additivity, CellValue, LogicalType, SemanticRole } from './types';

/** Compact form for headline figures: 1.2M, 4.5K. */
export function compact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e12) return `${(value / 1e12).toFixed(1)}T`;
  if (magnitude >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (magnitude >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (magnitude >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Full precision with separators, for tables where the exact figure matters. */
export function exact(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function count(value: number | null | undefined): string {
  if (value == null) return '—';
  return value.toLocaleString();
}

export function percent(fraction: number | null | undefined, digits = 1): string {
  if (fraction == null || Number.isNaN(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function bytes(value: number | null | undefined): string {
  if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Render a raw cell for the data grid, keeping blanks visibly distinct. */
export function cell(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return exact(value);
  return value;
}

export function pluralise(n: number, singular: string, plural?: string): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ─── Visual vocabulary ─────────────────────────────────────────────────── */

export const ROLE_STYLE: Record<
  SemanticRole,
  { label: string; plural: string; text: string; bg: string; border: string }
> = {
  measure: { label: 'Measure', plural: 'Measures', text: 'text-emerald-400', bg: 'bg-emerald-950/40', border: 'border-emerald-800/40' },
  dimension: { label: 'Dimension', plural: 'Dimensions', text: 'text-cyan-400', bg: 'bg-cyan-950/40', border: 'border-cyan-800/40' },
  category: { label: 'Category', plural: 'Categories', text: 'text-blue-400', bg: 'bg-blue-950/40', border: 'border-blue-800/40' },
  time: { label: 'Date', plural: 'Dates', text: 'text-amber-400', bg: 'bg-amber-950/40', border: 'border-amber-800/40' },
  identifier: { label: 'Identifier', plural: 'Identifiers', text: 'text-gray-300', bg: 'bg-zinc-800/60', border: 'border-gray-700/40' },
  geographic: { label: 'Location', plural: 'Locations', text: 'text-violet-400', bg: 'bg-violet-950/40', border: 'border-violet-800/40' },
  boolean: { label: 'Yes/No', plural: 'Yes/No fields', text: 'text-pink-400', bg: 'bg-pink-950/40', border: 'border-pink-800/40' },
  text: { label: 'Free text', plural: 'Free text', text: 'text-gray-400', bg: 'bg-zinc-900/50', border: 'border-gray-800/40' },
};

export const SEVERITY_STYLE = {
  high: { text: 'text-red-400', bg: 'bg-red-950/20', border: 'border-red-900/50', label: 'Important' },
  medium: { text: 'text-amber-400', bg: 'bg-amber-950/20', border: 'border-amber-900/50', label: 'Worth fixing' },
  low: { text: 'text-gray-400', bg: 'bg-zinc-900/30', border: 'border-gray-800/50', label: 'Minor' },
} as const;

/** Explains why a measure defaults to average rather than sum. */
export const ADDITIVITY_NOTE: Record<Additivity, string | null> = {
  additive: null,
  semi_additive: 'Adds up across categories, but not across time.',
  non_additive: 'This is a rate or price, so adding it up would not mean anything.',
};

export function logicalTypeLabel(type: LogicalType): string {
  const labels: Record<LogicalType, string> = {
    integer: 'whole number',
    decimal: 'number',
    currency: 'currency',
    percentage: 'percentage',
    date: 'date',
    datetime: 'date and time',
    time: 'time',
    boolean: 'yes/no',
    text: 'text',
  };
  return labels[type] ?? type;
}

export function qualityTone(score: number): string {
  if (score >= 95) return 'text-emerald-400';
  if (score >= 85) return 'text-cyan-400';
  if (score >= 70) return 'text-amber-400';
  return 'text-red-400';
}
