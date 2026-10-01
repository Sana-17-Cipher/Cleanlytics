'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart,
  Funnel, FunnelChart, LabelList, Legend, Pie, PieChart, PolarAngleAxis, PolarGrid, PolarRadiusAxis,
  Radar, RadarChart, RadialBar, RadialBarChart, Scatter, ScatterChart, Treemap,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Download, Loader2, Plus, RefreshCw, Save, Settings2, Table2, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import type {
  Aggregation, AnalysisSuggestion, CellValue, ModelFieldGroup, QueryFilter, QuerySpec, QueryResult, SemanticModel, TableSummary,
} from '../lib/types';




export const TIME_GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type TimeGrain = (typeof TIME_GRAINS)[number];
export const TIME_GRAIN_LABELS: Record<TimeGrain, string> = {
  day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year',
};
export function isTimeGrain(value: unknown): value is TimeGrain {
  return typeof value === 'string' && TIME_GRAINS.some((grain) => grain === value);
}
export function timeGrainFor(spec: QuerySpec): TimeGrain | null {
  const dimensions = spec.dimensions ?? [];
  return dimensions.length === 1 && isTimeGrain(dimensions[0].date_part) ? dimensions[0].date_part : null;
}
/** Regroup the source records; changing grain never rolls up already aggregated results. */
export function withTimeGrain(spec: QuerySpec, grain: TimeGrain | undefined): QuerySpec {
  if (!grain || !timeGrainFor(spec)) return spec;
  const dimension = spec.dimensions![0];
  let label = dimension.label ?? 'Period';
  const labels = new Set((spec.measures ?? []).map((measure) => measure.label));
  while (labels.has(label)) label = `${label}_period`;
  return { ...spec, dimensions: [{ ...dimension, label, date_part: grain }],
    order_by: { field: label, direction: 'asc' }, limit: 1000 };
}
const monthLabel = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** ISO week years may start in December of the previous calendar year. */
export function formatPeriod(value: unknown, grain?: string | null, full = false): string {
  const raw = value == null ? '(Missing or unmatched)' : String(value);
  if (grain === 'week') {
    const match = /^(\d{4})-W(\d{2})$/.exec(raw);
    if (!match) return raw;
    const year = Number(match[1]), week = Number(match[2]);
    if (year < 1000 || week < 1 || week > 53) return raw;
    const january4 = new Date(Date.UTC(year, 0, 4));
    const monday = new Date(january4);
    monday.setUTCDate(january4.getUTCDate() - (january4.getUTCDay() + 6) % 7 + (week - 1) * 7);
    const thursday = new Date(monday); thursday.setUTCDate(monday.getUTCDate() + 3);
    if (thursday.getUTCFullYear() !== year) return raw;
    const text = `Week ${week}, ${year}`;
    if (!full) return text;
    const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6);
    return `${text} (${dayLabel.format(monday)} – ${dayLabel.format(sunday)})`;
  }
  if (grain === 'month' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
    return monthLabel.format(new Date(`${raw}-01T00:00:00Z`));
  }
  if (grain === 'quarter' && /^\d{4}-Q[1-4]$/.test(raw)) return `${raw.slice(5)} ${raw.slice(0, 4)}`;
  if (grain === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const date = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw) return dayLabel.format(date);
  }
  return raw;
}


export const INSIGHTS_ID = '__story_insights__';
export const LAYOUT_KEY = 'storytelling_v1';
export type PanelWidth = 3 | 4 | 6 | 8 | 12;
export interface DashboardPreferences {
  version: 1;
  sources: Record<string, string[]>;
  hidden: string[];
  modes: Record<string, string>;
  widths: Record<string, PanelWidth>;
  tables: string[];
  purposes: Record<string, string>;
  grains: Record<string, TimeGrain>;
}
export function newPreferences(): DashboardPreferences {
  return { version: 1, sources: {}, hidden: [], modes: {}, widths: {}, tables: [], purposes: {}, grains: {} };
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === 'string') && new Set(value).size === value.length;
}
/** Reject incompatible storage rather than silently overwriting someone's dashboard. */
export function readPreferences(value: unknown): DashboardPreferences {
  if (value === undefined) return newPreferences();
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.sources) ||
      !Object.values(value.sources).every(ids) || !ids(value.hidden) || !ids(value.tables) ||
      !isRecord(value.modes) || !Object.values(value.modes).every((mode) =>
        typeof mode === 'string' && ['bar', 'horizontal_bar', 'area', 'line', 'pie', 'treemap', 'table', 'kpi', 'scatter'].includes(mode)) ||
      !isRecord(value.widths) || !Object.values(value.widths).every((width) => [3, 4, 6, 8, 12].includes(Number(width)) && typeof width === 'number') ||
      (value.grains !== undefined && (!isRecord(value.grains) || !Object.values(value.grains).every((grain) => typeof grain === 'string' && ['day', 'week', 'month', 'quarter', 'year'].includes(grain)))) ||
      !isRecord(value.purposes) || !Object.values(value.purposes).every((purpose) => typeof purpose === 'string')) {
    throw new Error('Saved dashboard preferences have an unsupported format. They are preserved; saving is disabled.');
  }
  return { ...value, grains: value.grains ?? {} } as unknown as DashboardPreferences;
}
/** An intentionally empty selection is different from having no saved selection. */
export function selectedIds(preferences: DashboardPreferences, source: string, defaults: string[]): string[] {
  return preferences.sources[source] ?? defaults;
}
export function pinPanel(preferences: DashboardPreferences, source: string, defaults: string[], id: string): DashboardPreferences {
  const selected = selectedIds(preferences, source, defaults);
  return { ...preferences, sources: { ...preferences.sources, [source]: selected.includes(id) ? selected : [...selected, id] },
    hidden: preferences.hidden.filter((hidden) => hidden !== id) };
}
/** Swap adjacent visible panels while preserving hidden or temporarily unavailable panels. */
export function movePanel(order: string[], visible: string[], id: string, offset: -1 | 1): string[] {
  const index = visible.indexOf(id), target = visible[index + offset];
  if (index < 0 || target === undefined) return order;
  const a = order.indexOf(id), b = order.indexOf(target);
  if (a < 0 || b < 0) return order;
  return order.map((entry, position) => position === a ? target : position === b ? id : entry);
}
export interface DashboardFilters {
  scope: string; category: string; categoryValue: string; dateField: string; dateFrom: string; dateTo: string;
}
/** All views of the selected source, including the category chart, share these filters. */
export function withDashboardFilters(spec: QuerySpec, selected: DashboardFilters): QuerySpec {
  const filters: QueryFilter[] = [...(spec.filters ?? [])];
  const base = spec.base_table_id ?? spec.measures?.[0]?.table_id;
  if (selected.scope !== 'all' && String(base) === selected.scope) {
    if (selected.category && selected.categoryValue) filters.push({ table_id: Number(selected.scope),
      column: selected.category, operator: 'in', value: [selected.categoryValue] });
    if (selected.dateField) {
      if (selected.dateFrom) filters.push({ table_id: Number(selected.scope), column: selected.dateField, operator: '>=', value: selected.dateFrom });
      if (selected.dateTo) {
        const nextDay = new Date(`${selected.dateTo}T00:00:00Z`);
        if (Number.isNaN(nextDay.getTime())) throw new Error('Choose a valid end date.');
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        filters.push({ table_id: Number(selected.scope), column: selected.dateField, operator: '<', value: nextDay.toISOString().slice(0, 10) });
      }
    }
  }
  return { ...spec, filters };
}

export const CUSTOM_CHART_OPTIONS = [
  { value: 'bar', label: 'Vertical bars' },
  { value: 'horizontal_bar', label: 'Horizontal bars' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Donut' },
  { value: 'radar', label: 'Radar' },
  { value: 'radial', label: 'Radial bars' },
  { value: 'treemap', label: 'Treemap' },
  { value: 'funnel', label: 'Funnel' },
  { value: 'scatter', label: 'Scatter' },
  { value: 'table', label: 'Table' },
  { value: 'kpi', label: 'KPI number' },
] as const;

export type CustomChartType = (typeof CUSTOM_CHART_OPTIONS)[number]['value'];

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


const WIDGET_PALETTE = ['#06b6d4', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#6366f1', '#ef4444', '#14b8a6'];
const TOOLTIP_STYLE: React.CSSProperties = { background: '#18181b', border: '1px solid #3f3f46', borderRadius: 10, fontSize: 11 };
const AGGREGATIONS: Aggregation[] = ['sum', 'avg', 'median', 'min', 'max', 'count', 'count_distinct'];
const DATE_PARTS = ['year', 'quarter', 'month', 'month_name', 'week', 'day', 'day_of_week'];
const NUMERIC = new Set(['integer', 'decimal', 'currency', 'percentage']);
function tooltipNumber(value: unknown): string { return typeof value === 'number' ? exact(value) : String(value ?? '—'); }
function axisNumber(value: unknown): string { return typeof value === 'number' ? compact(value) : String(value ?? ''); }

export interface Widget {
  id: string;
  title: string;
  chart: CustomChartType;
  dimension: { table_id: number; column: string; date_part?: string } | null;
  measure: { table_id: number; column: string | null; aggregation: Aggregation };
  limit: number;
  base_table_id?: number;
}
type WidgetOutcome = QueryResult | { error: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positive(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
/** Validate saved structure without dropping unknown properties or old chart IDs. */
export function isWidget(value: unknown): value is Widget {
  if (!record(value) || !record(value.measure)) return false;
  const dimension = value.dimension;
  return typeof value.id === 'string' && value.id.length > 0 && typeof value.title === 'string' &&
    CUSTOM_CHART_OPTIONS.some((option) => option.value === value.chart) &&
    positive(value.measure.table_id) && (value.measure.column === null || typeof value.measure.column === 'string') &&
    AGGREGATIONS.includes(value.measure.aggregation as Aggregation) && positive(value.limit) &&
    (value.base_table_id === undefined || positive(value.base_table_id)) &&
    (dimension === null || (record(dimension) && positive(dimension.table_id) && typeof dimension.column === 'string' &&
      (dimension.date_part == null || DATE_PARTS.includes(String(dimension.date_part)))));
}
export function specFor(widget: Widget): QuerySpec {
  const dimension = widget.chart === 'kpi' ? null : widget.dimension;
  return {
    base_table_id: widget.base_table_id ?? widget.measure.table_id,
    dimensions: dimension ? [{ ...dimension, label: 'group' }] : [],
    measures: [{ ...widget.measure, label: 'value' }],
    order_by: dimension ? {
      field: widget.chart === 'line' || widget.chart === 'area' ? 'group' : 'value',
      direction: widget.chart === 'line' || widget.chart === 'area' ? 'asc' : 'desc',
    } : undefined,
    limit: widget.limit,
  };
}


interface AutoDashboardProps {
  projectId: number;
  model: SemanticModel;
  tables: TableSummary[];
  onOpenTable: (tableId: number) => void;
}

type Outcome = { result: QueryResult } | { error: string };
const MINT = '#35e0a1';
const PALETTE = ['#35e0a1', '#38bdf8', '#a78bfa', '#fbbf24', '#fb7185', '#2dd4bf'];
const numberFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

function display(value: CellValue | undefined): string {
  if (value == null) return '—';
  return typeof value === 'number' ? numberFormat.format(value) : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not load this analysis.';
}

/** Export the returned rows only; never imply a limited result is the full data. */
function downloadRows(title: string, result: QueryResult) {
  const keys = result.fields.map((field) => field.key);
  const csvCell = (value: CellValue | undefined) => {
    let text = value == null ? '' : String(value);
    // Prevent spreadsheet formula execution in exported text cells.
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const content = [keys.map(csvCell).join(','), ...result.rows.map(
    (row) => keys.map((key) => csvCell(row[key])).join(','),
  )].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', content], { type: 'text/csv;charset=utf-8;' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${title.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'analysis'}${result.truncated ? '-partial' : ''}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function metricPriority(name: string): number {
  const value = name.toLowerCase().replace(/[_-]/g, ' ');
  if (/revenue|sales|turnover|income/.test(value)) return 0;
  if (/profit|earnings/.test(value)) return 10;
  if (/order.*id|invoice.*id|booking.*id|shipment.*id/.test(value)) return 20;
  if (/customer.*id|client.*id|account.*id/.test(value)) return 30;
  if (/cost|spend|expense|amount/.test(value)) return 40;
  if (/quantity|units|volume/.test(value)) return 50;
  if (/records|rows/.test(value)) return 60;
  if (/discount|latitude|longitude|distinct|city|state/.test(value)) return 100;
  return 80;
}

/** A small editorial overview; the entire catalogue remains in Explore. */
function chooseStory(items: AnalysisSuggestion[]) {
  const ordered = items.filter((item) => item.chart === 'kpi').sort((a, b) =>
    metricPriority(a.spec.measures?.[0]?.column ?? a.title) - metricPriority(b.spec.measures?.[0]?.column ?? b.title));
  const kpis = ordered.slice(0, 4);
  const primary = ordered.find((item) => item.spec.measures?.[0]?.column &&
    item.spec.measures[0].aggregation !== 'count_distinct') ?? kpis[0];
  const sameMetric = (item: AnalysisSuggestion) => item.spec.measures?.[0]?.column === primary?.spec.measures?.[0]?.column;
  const trend = items.find((item) => ['line', 'area'].includes(item.chart) && sameMetric(item)) ??
    items.find((item) => ['area', 'line'].includes(item.chart));
  const comparisons = items.filter((item) => item.spec.dimensions?.length === 1 &&
    !['line', 'area', 'scatter', 'kpi', 'table'].includes(item.chart));
  const dimensionPriority = (item: AnalysisSuggestion) => /category|segment|product|channel|type/i.test(item.spec.dimensions?.[0]?.column ?? '') ? 0 : 1;
  const composition = [...comparisons].sort((a, b) => Number(!sameMetric(a)) - Number(!sameMetric(b)) || dimensionPriority(a) - dimensionPriority(b))[0];
  const leaders = items.find((item) => item.id.startsWith('leaders-')) ?? items.find((item) => item.id.startsWith('routes-')) ??
    comparisons.find((item) => sameMetric(item) && item.id !== composition?.id) ?? composition;
  return { kpis, primary, trend, composition, leaders };
}

function resultFor(item: AnalysisSuggestion | undefined, outcomes: Record<string, Outcome>): QueryResult | null {
  const outcome = item ? outcomes[item.id] : undefined;
  return outcome && 'result' in outcome ? outcome.result : null;
}

function kpiLabel(item: AnalysisSuggestion): string {
  const field = item.spec.measures?.[0];
  const name = field?.column?.replace(/[_-]/g, ' ');
  if (field?.aggregation === 'count_distinct') {
    const entity = name?.replace(/\s+id$/i, '');
    if (entity && /^(order|customer|client|shipment|invoice)$/i.test(entity)) return `${entity}s`;
    return entity ? `Unique ${entity}` : 'Distinct values';
  }
  if (!name) return 'Records';
  return field?.aggregation === 'sum' ? `Total ${name}` : `${field?.aggregation === 'avg' ? 'Average' : field?.aggregation ?? ''} ${name}`;
}

function storyFacts(story: ReturnType<typeof chooseStory>, outcomes: Record<string, Outcome>): string[] {
  const facts: string[] = [];
  const aggregate = (item: AnalysisSuggestion | undefined) => {
    const result = resultFor(item, outcomes);
    const key = result?.fields.find((field) => field.kind === 'measure')?.key;
    return key ? result?.rows[0]?.[key] : null;
  };
  const total = aggregate(story.primary);
  const contribution = resultFor(story.composition, outcomes);
  if (contribution) {
    const dimension = contribution.fields.find((field) => field.kind === 'dimension')?.key;
    const measure = contribution.fields.find((field) => field.kind === 'measure');
    const values = contribution.rows.filter((row) => typeof row[measure?.key ?? ''] === 'number');
    const ranked = [...values].sort((a, b) => Number(b[measure?.key ?? '']) - Number(a[measure?.key ?? '']));
    if (dimension && measure && ranked.length) {
      const first = ranked[0], value = Number(first[measure.key]);
      const sum = values.reduce((acc, row) => acc + Number(row[measure.key]), 0);
      const sameMeasure = measure.column === story.primary?.spec.measures?.[0]?.column &&
        measure.aggregation === 'sum' && story.primary?.spec.measures?.[0]?.aggregation === 'sum';
      if (!contribution.truncated && sameMeasure && typeof total === 'number' && total > 0 &&
          Math.abs(sum - total) < Math.max(0.01, Math.abs(total) * 0.000001) && values.every((row) => Number(row[measure.key]) >= 0)) {
        facts.push(`${display(first[dimension])} contributes ${(value / total * 100).toFixed(1)}% of ${measure.column}.`);
      } else facts.push(`${display(first[dimension])} has the highest ${measure.key} among returned groups: ${display(value)}.`);
    }
  }
  const sales = story.kpis.find((item) => /sales|revenue/i.test(item.spec.measures?.[0]?.column ?? '') && item.spec.measures?.[0]?.aggregation === 'sum');
  const profit = story.kpis.find((item) => /profit/i.test(item.spec.measures?.[0]?.column ?? '') && item.spec.measures?.[0]?.aggregation === 'sum');
  const salesValue = aggregate(sales), profitValue = aggregate(profit);
  if (typeof salesValue === 'number' && salesValue > 0 && typeof profitValue === 'number') {
    facts.push(`Recorded profit is ${(profitValue / salesValue * 100).toFixed(1)}% of recorded sales.`);
  }
  const trend = resultFor(story.trend, outcomes);
  if (trend && trend.rows.length > 1) {
    const dimension = trend.fields.find((field) => field.kind === 'dimension')?.key;
    const measure = trend.fields.find((field) => field.kind === 'measure')?.key;
    const numeric = trend.rows.filter((row) => typeof row[measure ?? ''] === 'number');
    const peak = [...numeric].sort((a, b) => Number(b[measure ?? '']) - Number(a[measure ?? '']))[0];
    if (peak && dimension && measure) facts.push(`Highest observed period: ${formatPeriod(peak[dimension], trend.fields.find((field) => field.key === dimension)?.date_part)}, with ${display(peak[measure])} ${measure}.`);
  }
  return facts.slice(0, 3);
}

/** Reset project-specific state immediately when switching projects. */
export default function AutoDashboard(props: AutoDashboardProps) {
  return <GeneratedDashboard key={props.projectId} {...props} />;
}

function defaultPanels(items: AnalysisSuggestion[]): string[] {
  const story = chooseStory(items);
  return [...new Set([...story.kpis.map((item) => item.id), story.trend?.id,
    story.composition?.id, story.leaders?.id, INSIGHTS_ID].filter((id): id is string => Boolean(id)))];
}
function availableModes(item: AnalysisSuggestion): string[] {
  if (item.chart === 'kpi') return ['kpi'];
  if (item.chart === 'scatter' || (item.spec.measures?.length ?? 0) > 1) return [item.chart, 'table'];
  if (item.spec.dimensions?.some((field) => field.date_part)) return ['line', 'area', 'bar', 'table'];
  return ['horizontal_bar', 'bar', 'pie', 'treemap', 'table'];
}
const WIDTH_CLASSES: Record<PanelWidth, string> = {
  3: 'lg:col-span-3', 4: 'lg:col-span-4', 6: 'lg:col-span-6', 8: 'lg:col-span-8', 12: 'lg:col-span-12',
};

function GeneratedDashboard({ projectId, model, tables, onOpenTable }: AutoDashboardProps) {
  const suggestions = useMemo(() => {
    const source = model.dashboard_plan?.version === 1 ? model.dashboard_plan.widgets : model.suggestions;
    const ids = new Set<string>();
    return source.filter((item) => { if (ids.has(item.id)) return false; ids.add(item.id); return true; });
  }, [model]);
  const suggestionsRef = useRef(suggestions);
  useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);
  const [scope, setScope] = useState(() => String(chooseStory(suggestions).primary?.spec.base_table_id ?? tables[0]?.id ?? 'all'));
  const [view, setView] = useState<'overview' | 'explore'>('overview');
  const [customizing, setCustomizing] = useState(false);
  const [metric, setMetric] = useState('all');
  const [category, setCategory] = useState('');
  const [categoryValue, setCategoryValue] = useState('');
  const [dateField, setDateField] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [preferences, setPreferences] = useState<DashboardPreferences>(newPreferences);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [layouts, setLayouts] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [filterOptions, setFilterOptions] = useState<QueryResult | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const mounted = useRef(true);
  const saveLock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = JSON.stringify({ widgets, preferences });
  const dirty = loaded && snapshot !== saved;

  // One persistence owner writes both custom definitions and preferences. Other layout keys survive.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoaded(false); setLoadError(null);
      try {
        const response = await api.getDashboard(projectId);
        const suggestions = suggestionsRef.current;
        if (!Array.isArray(response.widgets) || !response.widgets.every(isWidget) || !isRecord(response.layouts)) {
          throw new Error('Saved charts have an unsupported format. They are preserved; saving is disabled.');
        }
        if (new Set(response.widgets.map((widget) => widget.id)).size !== response.widgets.length ||
            response.widgets.some((widget) => widget.id === INSIGHTS_ID || suggestions.some((item) => item.id === widget.id))) {
          throw new Error('Saved charts have conflicting IDs. They are preserved; saving is disabled.');
        }
        let restored = readPreferences(response.layouts[LAYOUT_KEY]);
        // Bring existing custom graphs into the overview when upgrading an older dashboard.
        if (response.layouts[LAYOUT_KEY] === undefined) {
          const sources = [...new Set(response.widgets.map((widget) => String(widget.base_table_id ?? widget.measure.table_id)))];
          for (const source of sources) {
            const defaults = defaultPanels(suggestions.filter((item) => String(item.spec.base_table_id ?? item.spec.measures?.[0]?.table_id) === source));
            for (const widget of response.widgets.filter((entry) => String(entry.base_table_id ?? entry.measure.table_id) === source)) {
              restored = pinPanel(restored, source, defaults, widget.id);
            }
          }
        }
        if (cancelled) return;
        setWidgets(response.widgets); setLayouts(response.layouts); setPreferences(restored);
        setSaved(JSON.stringify({ widgets: response.widgets, preferences: restored })); setLoaded(true);
      } catch (error) { if (!cancelled) setLoadError(errorMessage(error)); }
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId, loadRevision]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const customItems: AnalysisSuggestion[] = widgets.map((widget) => ({ id: widget.id, title: widget.title,
    description: 'Your custom analysis', chart: widget.chart, spec: specFor(widget) }));
  const catalogue = [...suggestions.map((item) => ({ ...item, spec: withTimeGrain(item.spec, preferences.grains[item.id]) })), ...customItems];
  const scoped = catalogue.filter((item) => scope === 'all' || String(item.spec.base_table_id ?? item.spec.measures?.[0]?.table_id) === scope);
  const visible = scoped.filter((item) => !preferences.hidden.includes(item.id) &&
    (metric === 'all' || item.chart === 'table' || item.spec.measures?.some((field) => metric === 'records' ? !field.column : field.column === metric)));
  const sourceKey = scope === 'all' ? String(chooseStory(suggestions).primary?.spec.base_table_id ?? tables[0]?.id ?? 'all') : scope;
  const suggestedSource = catalogue.filter((item) => !widgets.some((widget) => widget.id === item.id)).filter((item) => String(item.spec.base_table_id ?? item.spec.measures?.[0]?.table_id) === sourceKey);
  const defaults = defaultPanels(suggestedSource);
  const order = selectedIds(preferences, sourceKey, defaults);
  const shownOrder = order.filter((id) => !preferences.hidden.includes(id) &&
    (id === INSIGHTS_ID || visible.some((item) => item.id === id)));
  const story = chooseStory(suggestedSource.filter((item) => shownOrder.includes(item.id)));
  const canonicalStory = chooseStory(suggestedSource);
  const selectedSource = tables.find((table) => String(table.id) === sourceKey);
  const facts = storyFacts(story, outcomes);
  const fields = model.fields.find((group) => String(group.table_id) === scope)?.columns ?? [];
  const dateFields = fields.filter((field) => ['date', 'datetime'].includes(field.logical_type)).map((field) => field.name);
  const metricNames = [...new Set(scoped.flatMap((item) => (item.spec.measures ?? [])
    .filter((field) => field.column && field.aggregation !== 'count_distinct').map((field) => field.column!)))];
  const filterSources = suggestions.filter((item) => item.id.startsWith('distribution-') && String(item.spec.base_table_id) === scope);
  const categoryFields = [...new Set(filterSources.flatMap((item) => item.spec.dimensions?.map((field) => field.column) ?? []))];
  const filterKey = filterOptions?.fields.find((field) => field.kind === 'dimension')?.key;
  const filterValues = filterKey && filterOptions ? [...new Set(filterOptions.rows.map((row) => row[filterKey]).filter((value) => value != null).map(String))] : [];
  const notes = model.dashboard_plan?.notes ?? [];
  const quality = tables.filter((table) => table.summary && table.summary.quality_score_available !== false && Number.isFinite(table.summary.quality_score));
  const hiddenHere = scoped.filter((item) => preferences.hidden.includes(item.id));
  const unavailable = order.filter((id) => id !== INSIGHTS_ID && !catalogue.some((item) => item.id === id));
  const inputClass = 'rounded-lg border border-gray-700 bg-zinc-900 p-2 text-xs text-gray-200';

  // Dropdown choices are unfiltered; chart results always use the selected filters.
  useEffect(() => {
    let cancelled = false;
    async function loadOptions() {
      setFilterOptions(null); setFilterError(null);
      if (!category || scope === 'all') return;
      try {
        const result = await api.query(projectId, { base_table_id: Number(scope),
          dimensions: [{ table_id: Number(scope), column: category, label: 'group' }],
          measures: [{ table_id: Number(scope), column: null, aggregation: 'count', label: 'rows' }],
          order_by: { field: 'group', direction: 'asc' }, limit: 200 });
        if (!cancelled) setFilterOptions(result);
      } catch (error) { if (!cancelled) setFilterError(errorMessage(error)); }
    }
    void loadOptions();
    return () => { cancelled = true; };
  }, [projectId, scope, category, revision, model]);

  // Serializing only IDs and specs keeps title, width and arrangement edits from rerunning SQL.
  useEffect(() => {
    if (editing) document.getElementById(`dashboard-${editing}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [editing]);

  const queryRequests = JSON.stringify(scoped.map((item) => ({ id: item.id, spec: withDashboardFilters(item.spec,
    { scope, category, categoryValue, dateField, dateFrom, dateTo }) })));
  useEffect(() => {
    let cancelled = false, cursor = 0;
    const requests = JSON.parse(queryRequests) as { id: string; spec: QuerySpec }[];
    const next: Record<string, Outcome> = {};
    async function worker() {
      while (!cancelled && cursor < requests.length) {
        const request = requests[cursor++];
        try { const result = await api.query(projectId, request.spec); if (!cancelled) next[request.id] = { result }; }
        catch (error) { if (!cancelled) next[request.id] = { error: errorMessage(error) }; }
        if (!cancelled) setOutcomes({ ...next });
      }
    }
    async function load() {
      setOutcomes({}); setLoading(true);
      await Promise.all(Array.from({ length: Math.min(3, requests.length) }, () => worker()));
      if (!cancelled) setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId, queryRequests, revision, model]);

  function clearFilters() { setMetric('all'); setCategory(''); setCategoryValue(''); setDateField(''); setDateFrom(''); setDateTo(''); }
  function changeSource(next: string) { setScope(next); clearFilters(); }
  function hide(id: string) {
    setPreferences((current) => ({ ...current, hidden: [...new Set([...current.hidden, id])] }));
    if (editing === id) setEditing(null);
    setNotice('View removed from the dashboard. Restore it in Customize, or create your own graph. Save dashboard to keep this change.');
  }
  function pin(id: string) { setPreferences((current) => pinPanel(current, sourceKey, defaults, id)); }
  function move(id: string, offset: -1 | 1) {
    setPreferences((current) => ({ ...current, sources: { ...current.sources,
      [sourceKey]: movePanel(selectedIds(current, sourceKey, defaults), shownOrder, id, offset) } }));
  }
  function reset() {
    const sourceIds = new Set([...suggestedSource, ...customItems.filter((item) => String(item.spec.base_table_id) === sourceKey)].map((item) => item.id));
    sourceIds.add(INSIGHTS_ID);
    setPreferences((current) => ({ ...current, sources: { ...current.sources, [sourceKey]: defaults },
      hidden: current.hidden.filter((id) => !sourceIds.has(id)),
      modes: Object.fromEntries(Object.entries(current.modes).filter(([id]) => !sourceIds.has(id))),
      widths: Object.fromEntries(Object.entries(current.widths).filter(([id]) => !sourceIds.has(id))),
      tables: current.tables.filter((id) => !sourceIds.has(id)),
      grains: Object.fromEntries(Object.entries(current.grains).filter(([id]) => !sourceIds.has(id))) }));
    setEditing(null); clearFilters(); setNotice('Suggested overview restored. Your custom charts remain in Explore. Save to keep this layout.');
  }
  function addChart() {
    if (!loaded) return;
    if (scope === 'all') changeSource(sourceKey);
    const base = Number(sourceKey);
    if (!Number.isSafeInteger(base)) return;
    const group = model.fields.find((entry) => entry.table_id === base);
    const dimension = group?.columns.find((column) => ['dimension', 'category', 'geographic', 'boolean'].includes(column.semantic_role) && !['date', 'datetime'].includes(column.logical_type));
    const measure = canonicalStory.primary?.spec.measures?.[0];
    const next: Widget = { id: `custom-${crypto.randomUUID()}`, title: 'My analysis', chart: dimension ? 'horizontal_bar' : 'kpi',
      base_table_id: base, dimension: dimension ? { table_id: base, column: dimension.name } : null,
      measure: measure ? { table_id: measure.table_id, column: measure.column ?? null, aggregation: measure.aggregation }
        : { table_id: base, column: null, aggregation: 'count' }, limit: 50 };
    setWidgets((current) => [...current, next]); pin(next.id); setMetric('all');
    setView('overview'); setCustomizing(true); setEditing(next.id); setNotice(null);
  }
  function changeGrain(id: string, grain: string) {
    if (!loaded || !isTimeGrain(grain)) return;
    setPreferences((current) => ({ ...current, grains: { ...current.grains, [id]: grain } }));
  }
  function removeControl(id: string, title: string) {
    return <button type="button" disabled={!loaded} aria-label={`Remove ${title} from dashboard`}
      title="Remove from dashboard" onClick={() => hide(id)}
      className="rounded-md p-1 text-gray-500 hover:bg-gray-800 hover:text-red-300 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>;
  }
  function grainControl(item: AnalysisSuggestion) {
    const grain = timeGrainFor(item.spec);
    if (!grain || widgets.some((widget) => widget.id === item.id)) return null;
    return <label className="flex items-center gap-2 text-xs text-gray-400">Group by
      <select aria-label={`Time grouping for ${item.title}`} disabled={!loaded} value={grain}
        onChange={(event) => changeGrain(item.id, event.target.value)}
        className="rounded-md border border-gray-700 bg-zinc-900 p-1.5 text-xs text-gray-200 disabled:opacity-40">
        {TIME_GRAINS.map((part) => <option key={part} value={part}>{TIME_GRAIN_LABELS[part]}</option>)}
      </select>
    </label>;
  }
  function updateChart(id: string, patch: Partial<Widget>) {
    const existing = widgets.find((widget) => widget.id === id);
    if (!existing) return;
    const updated = { ...existing, ...patch };
    setWidgets((current) => current.map((widget) => widget.id === id ? updated : widget));
    const newSource = String(updated.base_table_id ?? updated.measure.table_id);
    const oldSource = String(existing.base_table_id ?? existing.measure.table_id);
    if (newSource !== oldSource) {
      const newDefaults = defaultPanels(suggestions.filter((item) => String(item.spec.base_table_id) === newSource));
      setPreferences((current) => pinPanel({ ...current, sources: Object.fromEntries(
        Object.entries(current.sources).map(([key, ids]) => [key, ids.filter((entry) => entry !== id)])) }, newSource, newDefaults, id));
      changeSource(newSource);
    }
  }
  async function save() {
    if (!loaded || saveLock.current) return;
    saveLock.current = true; setSaving(true); setNotice(null);
    const captured = snapshot;
    try {
      await api.saveDashboard(projectId, widgets, { ...layouts, [LAYOUT_KEY]: preferences });
      if (mounted.current) { setSaved(captured); setNotice('Dashboard saved for this project.'); }
    } catch (error) { if (mounted.current) setNotice(errorMessage(error)); }
    finally { saveLock.current = false; if (mounted.current) setSaving(false); }
  }
  function customOutcome(id: string) {
    const outcome = outcomes[id];
    return outcome && ('result' in outcome ? outcome.result : outcome);
  }
  function defaultMode(item: AnalysisSuggestion) {
    if (item.id === canonicalStory.trend?.id) return 'area';
    if (item.id === canonicalStory.composition?.id) {
      const result = resultFor(item, outcomes);
      const measure = result?.fields.find((field) => field.kind === 'measure');
      const safe = result && measure && ['sum', 'count'].includes(measure.aggregation ?? '') &&
        !result.truncated && result.rows.every((row) => typeof row[measure.key] === 'number' && Number(row[measure.key]) >= 0) &&
        result.rows.some((row) => Number(row[measure.key]) > 0);
      if (safe && result.rows.length >= 2 && result.rows.length <= 6) return 'pie';
      if (safe && result.rows.length > 6 && result.rows.length <= 20) return 'treemap';
    }
    if (item.id === canonicalStory.leaders?.id && item.id !== canonicalStory.composition?.id) return 'table';
    return item.chart;
  }
  function defaultWidth(item?: AnalysisSuggestion): PanelWidth {
    if (item?.chart === 'kpi') return 3;
    return !item || item.id === canonicalStory.composition?.id ? 4 : item.id === canonicalStory.trend?.id || item.id === canonicalStory.leaders?.id ? 8 : 6;
  }
  function panelControls(id: string, item?: AnalysisSuggestion) {
    return customizing && loaded && <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-2 text-xs text-gray-300">
      <button type="button" aria-label={`Move ${item?.title ?? 'observations'} earlier`} disabled={shownOrder.indexOf(id) === 0}
        onClick={() => move(id, -1)} className="rounded px-2 py-1 hover:bg-gray-800 disabled:opacity-30">↑ Earlier</button>
      <button type="button" aria-label={`Move ${item?.title ?? 'observations'} later`} disabled={shownOrder.indexOf(id) === shownOrder.length - 1}
        onClick={() => move(id, 1)} className="rounded px-2 py-1 hover:bg-gray-800 disabled:opacity-30">↓ Later</button>
      <select aria-label={`Width for ${item?.title ?? 'observations'}`} className={inputClass} value={preferences.widths[id] ?? defaultWidth(item)}
        onChange={(event) => setPreferences((current) => ({ ...current, widths: { ...current.widths, [id]: Number(event.target.value) as PanelWidth } }))}>
        <option value={3}>One quarter</option><option value={4}>One third</option><option value={6}>Half</option><option value={8}>Two thirds</option><option value={12}>Full width</option>
      </select>
      {item && !widgets.some((widget) => widget.id === id) && item.chart !== 'kpi' && <select aria-label={`Chart type for ${item.title}`} className={inputClass}
        value={preferences.modes[id] ?? defaultMode(item)} onChange={(event) => setPreferences((current) => ({ ...current, modes: { ...current.modes, [id]: event.target.value } }))}>
        {[...new Set([defaultMode(item), ...availableModes(item)])].map((mode) => <option key={mode} value={mode}>{mode.replace('_', ' ')}</option>)}
      </select>}
      <button type="button" onClick={() => hide(id)} className="ml-auto px-2 py-1 text-gray-400 hover:text-white">Hide</button>
    </div>;
  }
  const overviewTitle = preferences.purposes[sourceKey] ?? `Understand ${canonicalStory.primary?.spec.measures?.[0]?.column?.replace(/[_-]/g, ' ') ?? 'activity'}, its drivers and the leading groups.`;

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-400">Your business at a glance</p>
        <h2 className="mt-1 text-xl font-semibold text-white">{selectedSource?.table_name.replace(/_/g, ' ') ?? 'Business'} overview</h2>
        <p className="mt-1 text-xs text-gray-400">{overviewTitle}</p>
        <p className="mt-1 text-[10px] text-gray-500">{dateField ? `${dateField}: ${dateFrom || 'start of data'} – ${dateTo || 'end of data'}` : 'All available dates'}{categoryValue ? ` · ${category}: ${categoryValue}` : ''}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Filter analyses by source table" value={scope} onChange={(event) => changeSource(event.target.value)} className={inputClass}>
          {view === 'explore' && <option value="all">All source tables</option>}
          {tables.map((table) => <option key={table.id} value={table.id}>{table.table_name}</option>)}
        </select>
        <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)} className="flex items-center gap-1 p-2 text-xs text-gray-300 disabled:opacity-50">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh</button>
        <button type="button" disabled={!loaded || !selectedSource} onClick={addChart}
          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"><Plus className="h-4 w-4" />Create my graph</button>
        <button type="button" disabled={!loaded} aria-pressed={customizing} onClick={() => { setCustomizing((current) => !current); setEditing(null); }}
          className="rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-200 disabled:opacity-40">{customizing ? 'Done customizing' : 'Customize'}</button>
        <button type="button" disabled={!loaded || saving || !dirty} onClick={() => void save()}
          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save dashboard</button>
      </div>
    </div>
    <p role="status" className="text-xs text-gray-400">{loadError ? 'Saved layout could not be loaded.' : !loaded ? 'Loading your saved layout…' : dirty ? 'Unsaved changes · Save before switching projects.' : 'Layout and charts saved for this project.'}</p>
    {notice && <p role="status" className="text-xs text-emerald-300">{notice}</p>}
    {loadError && <Notice>{loadError} <button type="button" onClick={() => setLoadRevision((value) => value + 1)} className="underline">Retry loading</button></Notice>}
    <div className="flex items-center gap-1 border-b border-gray-800 pb-2">
      {(['overview', 'explore'] as const).map((next) => <button key={next} type="button" aria-pressed={view === next}
        onClick={() => { setView(next); if (next === 'overview' && scope === 'all') changeSource(sourceKey); }}
        className={`rounded-lg px-4 py-2 text-xs font-semibold ${view === next ? 'bg-emerald-500/10 text-emerald-300' : 'text-gray-500 hover:text-gray-200'}`}>
        {next === 'overview' ? 'Business overview' : `Explore all analyses (${catalogue.length})`}</button>)}
    </div>
    {customizing && loaded && <div className="space-y-3 rounded-xl border border-emerald-900/70 bg-emerald-950/10 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={addChart} disabled={!selectedSource} className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs text-white disabled:opacity-40"><Plus className="h-4 w-4" />Create graph</button>
        <select aria-label="Add analysis to overview" value="" className={inputClass} onChange={(event) => { if (event.target.value) { pin(event.target.value); setView('overview'); } }}>
          <option value="">Add an existing analysis…</option>
          {scoped.filter((item) => !order.includes(item.id) || preferences.hidden.includes(item.id)).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          {(!order.includes(INSIGHTS_ID) || preferences.hidden.includes(INSIGHTS_ID)) && <option value={INSIGHTS_ID}>What stands out</option>}
        </select>
        <button type="button" onClick={reset} className="ml-auto p-2 text-xs text-gray-400 hover:text-white">Reset suggested dashboard</button>
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs text-gray-400">Dashboard purpose
        <input value={preferences.purposes[sourceKey] ?? overviewTitle} aria-label="Dashboard purpose" maxLength={240}
          onChange={(event) => setPreferences((current) => ({ ...current, purposes: { ...current.purposes, [sourceKey]: event.target.value } }))}
          className={`${inputClass} min-w-0 flex-1`} /></label>
      <p className="text-[10px] text-gray-500">Use the card controls to change width and order. Reset keeps custom chart definitions in Explore. Save dashboard stores your choices.</p>
      {(hiddenHere.length > 0 || preferences.hidden.includes(INSIGHTS_ID)) && <details className="text-xs text-gray-400"><summary className="cursor-pointer">Hidden views ({hiddenHere.length + Number(preferences.hidden.includes(INSIGHTS_ID))})</summary>
        <div className="mt-2 flex flex-wrap gap-2">{[...hiddenHere.map((item) => ({ id: item.id, title: item.title })), ...(preferences.hidden.includes(INSIGHTS_ID) ? [{ id: INSIGHTS_ID, title: 'What stands out' }] : [])]
          .map((item) => <button key={item.id} type="button" onClick={() => setPreferences((current) => ({ ...current, hidden: current.hidden.filter((id) => id !== item.id) }))}
            className="rounded border border-gray-700 px-2 py-1 text-emerald-300">Restore {item.title}</button>)}</div></details>}
    </div>}
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-800 bg-zinc-900/40 p-3">
      <label className="text-xs text-gray-400">Focus metric <select aria-label="Focus metric" value={metric} onChange={(event) => setMetric(event.target.value)} className={inputClass}>
        <option value="all">All metrics</option><option value="records">Record counts</option>{metricNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      {scope !== 'all' && categoryFields.length > 0 && <><select aria-label="Filter category" value={category} onChange={(event) => { setCategory(event.target.value); setCategoryValue(''); }} className={inputClass}>
        <option value="">Filter by category</option>{categoryFields.map((name) => <option key={name} value={name}>{name}</option>)}</select>
        {category && <select aria-label="Filter value" value={categoryValue} onChange={(event) => setCategoryValue(event.target.value)} className={inputClass} disabled={!filterOptions}>
          <option value="">{filterOptions ? 'All values' : 'Loading values…'}</option>{filterValues.map((value) => <option key={value} value={value}>{value}</option>)}
          {categoryValue && !filterValues.includes(categoryValue) && <option value={categoryValue}>{categoryValue}</option>}</select>}</>}
      {dateFields.length > 0 && <><select aria-label="Date field" value={dateField} onChange={(event) => setDateField(event.target.value)} className={inputClass}>
        <option value="">Date range</option>{dateFields.map((name) => <option key={name} value={name}>{name}</option>)}</select>
        {dateField && <><input aria-label="From date" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} className={inputClass} />
          <input aria-label="To date" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} className={inputClass} /></>}</>}
      {(metric !== 'all' || category || dateField) && <button type="button" onClick={clearFilters} className="p-2 text-xs text-emerald-300">Clear filters</button>}
      <span className="text-[10px] text-gray-500">{loading ? 'Calculating selection…' : 'Calculated from source data'}</span>
    </div>
    {filterError && <Notice>Filter choices could not load: {filterError}</Notice>}
    {filterOptions?.truncated && <p className="text-xs text-amber-300">Category choices contain the first 200 returned values.</p>}
    {view === 'explore' && notes.map((note, index) => <p key={index} className="text-xs text-gray-400">{note}</p>)}
    {model.pending_count > 0 && <Notice>{model.pending_count} relationships await review in the data model. Charts use approved relationships only.</Notice>}
    {!model.is_connected && tables.length > 1 && <Notice>Some source tables are disconnected. Their analyses are shown separately.</Notice>}
    {view === 'overview' && <>
      {unavailable.length > 0 && <Notice>{unavailable.length} saved views are unavailable in the current data model. Their layout choices are retained. Reset the suggested dashboard to refresh the selection.</Notice>}
      {shownOrder.length === 0 ? <div className="rounded-xl border border-dashed border-gray-700 p-8 text-center text-sm text-gray-400">No views match this layout and metric. Clear filters, or use Customize to add or restore a view.</div> :
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">{shownOrder.map((id) => {
          const item = catalogue.find((entry) => entry.id === id);
          const widget = widgets.find((entry) => entry.id === id);
          const width = preferences.widths[id] ?? defaultWidth(item);
          return <div key={id} id={`dashboard-${id}`} className={`min-w-0 ${WIDTH_CLASSES[width]}`}>{panelControls(id, item)}
            {id === INSIGHTS_ID ? <aside className="rounded-xl border border-gray-800 bg-[#151c24] p-5">
              <div className="flex items-center justify-between gap-2"><p className="text-[10px] font-semibold uppercase tracking-widest text-emerald-400">What stands out</p>{removeControl(id, 'What stands out')}</div>
              {facts.length > 0 ? <ul className="mt-4 space-y-4 text-sm leading-relaxed text-gray-300">{facts.map((fact) => <li key={fact} className="border-b border-gray-800 pb-3 last:border-0">{fact}</li>)}</ul>
                : <p className="mt-4 text-xs leading-relaxed text-gray-500">{loading ? 'Calculating observations…' : 'This selection does not support a summary observation. Explore the individual analyses.'}</p>}
              <p className="mt-4 text-[10px] leading-relaxed text-gray-500">These observations describe the returned data and use the same category and date filters as the charts.</p>
            </aside> : widget ? <WidgetCard widget={widget} fields={model.fields} editable={loaded} removeLabel="Remove from dashboard"
              result={customOutcome(id)} editing={customizing && editing === id}
              onToggleEdit={() => { setCustomizing(true); setEditing((current) => current === id ? null : id); }} onChange={(patch) => updateChart(id, patch)} onRemove={() => hide(id)}
              column={model.fields.find((group) => group.table_id === widget.measure.table_id)?.columns.find((column) => column.name === widget.measure.column)} />
              : item?.chart === 'kpi' ? <SummaryKpi item={item} outcome={outcomes[id]} actions={removeControl(id, item.title)} /> : item ? <StoryPanel item={item} outcome={outcomes[id]}
                heading={item.id === canonicalStory.trend?.id ? `${item.spec.measures?.[0]?.column ?? 'Record'} performance` : item.title.replace(/^(Sum|Avg|Count)( of)? /i, '')}
                actions={removeControl(id, item.title)} timeControl={grainControl(item)}
                mode={preferences.modes[id] ?? defaultMode(item)} tableView={preferences.tables.includes(id)}
                onToggleView={() => setPreferences((current) => ({ ...current, tables: current.tables.includes(id) ? current.tables.filter((entry) => entry !== id) : [...current.tables, id] }))} /> : null}
          </div>;
        })}</div>}
      {selectedSource && <button type="button" onClick={() => onOpenTable(selectedSource.id)} className="text-xs text-gray-500 hover:text-emerald-300">
        {display(selectedSource.row_count)} source records · {selectedSource.column_count} fields · Open source table</button>}
    </>}
    {view === 'explore' && <div className="space-y-6">
      {visible.length === 0 && <Notice>No analyses match this selection. Clear filters or use Customize to restore hidden views.</Notice>}
      {[
        { title: 'At a glance', items: visible.filter((item) => item.chart === 'kpi'), kpis: true },
        { title: 'Activity and trends', items: visible.filter((item) => ['line', 'area'].includes(item.chart)) },
        { title: 'Drivers and comparisons', items: visible.filter((item) => !['kpi', 'line', 'area', 'table', 'scatter'].includes(item.chart)) },
        { title: 'Relationships and detail', items: visible.filter((item) => ['table', 'scatter'].includes(item.chart)) },
      ].filter((group) => group.items.length > 0).map((group) => <section key={group.title}>
        <h3 className="mb-3 text-sm font-semibold text-gray-200">{group.title}</h3>
        <div className={group.kpis ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4' : 'grid grid-cols-1 gap-4 xl:grid-cols-2'}>
          {group.items.map((item) => { const widget = widgets.find((entry) => entry.id === item.id); return <div key={item.id}>
            <button type="button" disabled={!loaded} onClick={() => { const source = String(item.spec.base_table_id ?? item.spec.measures?.[0]?.table_id);
              const initial = defaultPanels(suggestions.filter((entry) => String(entry.spec.base_table_id) === source));
              setPreferences((current) => pinPanel(current, source, initial, item.id)); changeSource(source); setView('overview'); }}
              className="mb-2 text-xs text-emerald-300 disabled:opacity-40">Add to overview</button>
            {widget ? <WidgetCard widget={widget} fields={model.fields} editable={loaded} removeLabel="Remove from dashboard"
              result={customOutcome(item.id)}
              editing={customizing && editing === widget.id} onToggleEdit={() => { setCustomizing(true); setEditing((current) => current === widget.id ? null : widget.id); }}
              onChange={(patch) => updateChart(widget.id, patch)} onRemove={() => hide(widget.id)}
              column={model.fields.find((fields) => fields.table_id === widget.measure.table_id)?.columns.find((column) => column.name === widget.measure.column)} />
              : <AnalysisCard item={item} outcome={outcomes[item.id]} timeControl={grainControl(item)} chartMode={preferences.modes[item.id] ?? item.chart}
                onChartMode={(mode) => setPreferences((current) => ({ ...current, modes: { ...current.modes, [item.id]: mode } }))}
                tableView={preferences.tables.includes(item.id)} onToggleView={() => setPreferences((current) => ({ ...current,
                  tables: current.tables.includes(item.id) ? current.tables.filter((id) => id !== item.id) : [...current.tables, item.id] }))}
                onHide={() => { if (loaded) hide(item.id); }} editable={loaded} />}
          </div>; })}
        </div>
      </section>)}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{tables.map((table) => <button type="button" key={table.id} onClick={() => onOpenTable(table.id)}
        className="rounded-xl border border-gray-800 bg-zinc-900/50 p-4 text-left hover:border-emerald-700">
        <span className="flex items-center gap-2 text-sm text-gray-200"><Table2 className="h-4 w-4 text-emerald-400" />{table.table_name}</span>
        <p className="mt-2 text-xl font-semibold text-white">{numberFormat.format(table.row_count)}</p><p className="text-xs text-gray-400">rows · {table.column_count} columns · Open table</p></button>)}</div>
    </div>}
    {quality.length > 0 && <details className="rounded-xl border border-gray-800 p-3 text-xs text-gray-400"><summary className="cursor-pointer">Data quality by table</summary>
      <p className="mt-2">Indicative scores from measured checks; they do not establish business accuracy.</p>
      {quality.map((table) => <p key={table.id} className="mt-1">{table.table_name}: {display(table.summary!.quality_score)} / 100
        {table.summary?.patterns_sampled ? ' · Pattern checks sampled' : ''}{table.summary?.distinct_counts_approximate ? ' · Distinct counts estimated' : ''}</p>)}</details>}
  </div>;
}

function SummaryKpi({ item, outcome, actions }: { item: AnalysisSuggestion; outcome?: Outcome; actions?: React.ReactNode }) {
  const result = outcome && 'result' in outcome ? outcome.result : null;
  const key = result?.fields.find((field) => field.kind === 'measure')?.key;
  const value = key ? result?.rows[0]?.[key] : null;
  const formatted = typeof value === 'number' && Math.abs(value) >= 100000
    ? new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : display(value);
  return <section className="min-w-0 rounded-xl border border-gray-800 bg-[#171d25] px-4 py-4">
    <div className="flex items-center justify-between gap-2"><p className="truncate text-xs text-gray-400" title={item.title}>{kpiLabel(item)}</p>{actions}</div>
    {!outcome ? <div className="mt-3 h-9 animate-pulse rounded bg-gray-800/60" aria-label="Loading metric" />
      : 'error' in outcome ? <p role="alert" className="mt-3 text-xs text-amber-300">{outcome.error}</p>
      : <p className="mt-3 truncate text-2xl font-semibold tracking-tight text-white xl:text-3xl" title={display(value)}>{formatted}</p>}
    <p className="mt-2 text-[10px] text-emerald-400">{item.spec.measures?.[0]?.aggregation === 'count_distinct' ? 'Distinct non-NULL values' : 'Current selection'}</p>
    {result && result.warnings.length > 0 && <details className="mt-2 text-[10px] text-amber-300">
      <summary>{result.warnings.length} calculation notes</summary>{result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
    </details>}
  </section>;
}

function StoryPanel({ item, outcome, heading, mode, tableView, onToggleView, actions, timeControl }: {
  item: AnalysisSuggestion; outcome?: Outcome; heading: string; mode: string;
  tableView: boolean; onToggleView: () => void; actions?: React.ReactNode; timeControl?: React.ReactNode;
}) {
  const result = outcome && 'result' in outcome ? outcome.result : null;
  const [details, setDetails] = useState(false);
  const limited = result && mode === 'table' && !tableView ? { ...result, rows: result.rows.slice(0, 8) } : result;
  return <section className="min-w-0 rounded-xl border border-gray-800 bg-[#151c24] p-5" style={{ minHeight: mode === 'table' ? undefined : 350 }}>
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold text-gray-100">{heading}</h3>
      <div className="flex items-center gap-2">{actions}<button type="button" onClick={() => setDetails((current) => !current)} aria-expanded={details}
        aria-label={`Details for ${heading}`} className="text-lg leading-none text-gray-500 hover:text-gray-200">⋯</button></div>
    </div>
    {timeControl && <div className="mb-3">{timeControl}</div>}
    {!outcome ? <div role="status" className="flex h-64 items-center justify-center text-xs text-gray-500">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />Calculating…</div>
      : 'error' in outcome ? <Notice>{outcome.error}</Notice>
      : limited && <AnalysisView item={{ ...item, chart: mode }} result={limited} tableView={tableView} />}
    {result && mode === 'table' && !tableView && result.rows.length > 8 && <p className="mt-3 text-[10px] text-gray-500">
      Top 8 of {result.row_count} returned groups. Open details and choose Show values for the full returned table.</p>}
    {result?.truncated && <p className="mt-3 text-xs text-amber-300">Query limit reached; this view contains partial results.</p>}
    {result?.warnings.map((warning, index) => <p key={index} className="mt-2 text-[10px] text-amber-300">{warning}</p>)}
    {details && result && <div className="mt-4 space-y-3 border-t border-gray-800 pt-3 text-xs text-gray-500">
      <p>{item.description}</p><p>Source: {result.base_table_name}</p>
      <div className="flex gap-4"><button type="button" onClick={onToggleView}
        className="text-emerald-300">{tableView ? 'Show chart' : 'Show values'}</button>
        <button type="button" onClick={() => downloadRows(item.title, result)} className="text-emerald-300">Download returned rows</button></div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap text-[10px]">{result.sql}</pre>
    </div>}
  </section>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return <div className="flex items-start gap-2 rounded-xl border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200">
    <TriangleAlert className="h-4 w-4 shrink-0" /><div>{children}</div>
  </div>;
}

function AnalysisCard({ item, outcome, tableView, onToggleView, onHide, chartMode, onChartMode, editable, timeControl }: {
  item: AnalysisSuggestion;
  chartMode: string;
  onChartMode: (mode: string) => void;
  outcome?: Outcome;
  tableView: boolean;
  onToggleView: () => void;
  onHide: () => void;
  editable: boolean;
  timeControl?: React.ReactNode;
}) {
  const result = outcome && 'result' in outcome ? outcome.result : null;
  return <section className="min-w-0 rounded-2xl border border-gray-800 bg-zinc-900/40 p-4">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold text-white">{item.title}</h3>
        <p className="mt-1 text-xs text-gray-400">{item.description}</p></div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-gray-400">
        {result && <>
          <button type="button" onClick={onToggleView} disabled={!editable} className="hover:text-white disabled:opacity-40">{tableView ? 'Chart' : 'Table'}</button>
          <button type="button" aria-label={`Download returned rows for ${item.title}`} title="Download returned rows"
            onClick={() => downloadRows(item.title, result)} className="hover:text-white"><Download className="h-4 w-4" /></button>
        </>}
        <button type="button" onClick={onHide} disabled={!editable} className="hover:text-white disabled:opacity-40">Hide</button>
      </div>
    </div>
    {timeControl && <div className="mt-3">{timeControl}</div>}
    {result && item.chart !== 'kpi' && item.chart !== 'table' && item.chart !== 'scatter' && (
      <select aria-label={`Chart type for ${item.title}`} value={chartMode} disabled={!editable}
        onChange={(event) => onChartMode(event.target.value)}
        className="mt-3 rounded-md border border-gray-700 bg-zinc-900 p-1.5 text-xs text-gray-300">
        {(item.chart === 'line' || item.chart === 'area'
          ? ['line', 'area', 'bar', 'table'] : ['horizontal_bar', 'bar', 'pie', 'treemap', 'table'])
          .map((mode) => <option key={mode} value={mode}>{({ pie: 'Donut', horizontal_bar: 'Ranked bars' } as Record<string, string>)[mode] ?? mode}</option>)}
      </select>
    )}
    <div className="mt-4">
      {!outcome ? <p role="status" className="flex items-center gap-2 text-xs text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" />Loading analysis…</p>
        : 'error' in outcome ? <Notice>{outcome.error} Use Refresh to retry.</Notice>
        : <AnalysisView item={{ ...item, chart: chartMode }} result={outcome.result} tableView={tableView} />}
    </div>
    {result && <div className="mt-3 space-y-2">
      {result.truncated && <Notice>Partial result: the query limit was reached.
        This chart and download contain {result.row_count} returned rows.</Notice>}
      {result.warnings.map((warning, index) => <Notice key={index}>{warning}</Notice>)}
      <details className="text-xs text-gray-500"><summary className="cursor-pointer">Source and query</summary>
        <p className="mt-2">Source: {result.base_table_name}
          {result.joined_tables.length > 0 ? ` · Joined: ${result.joined_tables.join(', ')}` : ''}</p>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 p-2">{result.sql}</pre>
      </details>
    </div>}
  </section>;
}

function AnalysisView({ item, result, tableView }: {
  item: AnalysisSuggestion; result: QueryResult; tableView: boolean;
}) {
  if (result.rows.length === 0) return <p className="text-xs text-gray-400">No rows match this analysis.</p>;
  const dimensions = result.fields.filter((field) => field.kind === 'dimension');
  const dimension = dimensions[0];
  const measures = result.fields.filter((field) => field.kind === 'measure');
  const measure = measures[0];
  if (tableView || item.chart === 'table' || !measure) return <ResultTable result={result} />;
  if (item.chart === 'kpi' && dimensions.length === 0 && result.rows.length === 1) {
    return <p className="py-3 text-3xl font-bold text-emerald-300">{display(result.rows[0][measure.key])}</p>;
  }
  if (item.chart === 'scatter' && measures.length === 2) {
    const points = result.rows.flatMap((row) => {
      const x = row[measures[0].key], y = row[measures[1].key];
      return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)
        ? [{ x, y, label: dimension ? String(row[dimension.key] ?? '(Missing)') : '' }] : [];
    });
    if (!points.length) return <ResultTable result={result} />;
    return <div>
      {points.length < result.rows.length && <p className="mb-2 text-xs text-gray-500">
        {result.rows.length - points.length} groups without a finite pair are omitted.</p>}
      <div className="h-64"><ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 15 }}>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
          <XAxis type="number" dataKey="x" name={measures[0].key} stroke="#9ca3af" tick={{ fontSize: 10 }}
            label={{ value: measures[0].key, position: 'bottom', fill: '#9ca3af', fontSize: 10 }} />
          <YAxis type="number" dataKey="y" name={measures[1].key} stroke="#9ca3af" tick={{ fontSize: 10 }} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: '#18181b', border: '1px solid #3f3f46' }} />
          <Scatter data={points} fill={MINT} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer></div>
      <p className="mt-2 text-xs text-gray-500">Y axis: {measures[1].key} · X axis: {measures[0].key}</p>
    </div>;
  }
  if (!dimension || dimensions.length !== 1 || measures.length !== 1) return <ResultTable result={result} />;
  const data = result.rows.map((row) => ({
    label: row[dimension.key] == null ? '(Missing or unmatched)' : String(row[dimension.key]),
    value: typeof row[measure.key] === 'number' && Number.isFinite(row[measure.key]) ? row[measure.key] as number : null,
  }));
  if (!data.some((row) => row.value !== null)) return <p className="text-xs text-gray-400">No numeric values available.</p>;
  const tooltip = <Tooltip contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8 }}
    labelFormatter={(value) => formatPeriod(value, dimension.date_part, true)}
    formatter={(value) => [typeof value === 'number' ? display(value) : '—', measure.key]} />;
  const composition = item.chart === 'pie' || item.chart === 'treemap';
  const safeComposition = ['sum', 'count'].includes(measure.aggregation ?? '') && data.every((row) => row.value != null && row.value >= 0) &&
    data.some((row) => row.value != null && row.value > 0);
  const mode = composition && !safeComposition ? 'horizontal_bar' : item.chart;
  const axes = <>
    <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
    <XAxis dataKey="label" stroke="#9ca3af" tick={{ fontSize: 10 }} tickFormatter={(value: string) => { const label = formatPeriod(value, dimension.date_part); return label.length > 20 ? `${label.slice(0, 18)}…` : label; }} />
    <YAxis stroke="#9ca3af" width={65} tick={{ fontSize: 10 }} tickFormatter={(value) => numberFormat.format(value)} />
    {tooltip}
  </>;
  const dot = data.length === 1 ? { r: 5, fill: MINT } : false;
  return <div>
    {composition && !safeComposition && <p className="mb-2 text-xs text-gray-500">
      Part-of-whole charts require additive, non-negative values with a positive total. Showing bars.</p>}
    {(mode === 'line' || mode === 'area') && data.length === 1 && <p className="mb-2 text-xs text-gray-500">
      One returned period; more periods are needed to assess a trend.</p>}
    <div className="min-w-0" style={{ height: mode === 'horizontal_bar' ? Math.max(256, data.length * 24) : 256 }}><ResponsiveContainer width="100%" height="100%" minWidth={0}>
      {mode === 'pie' ? <PieChart>
        <Pie data={data} dataKey="value" nameKey="label" innerRadius="48%" outerRadius="78%" paddingAngle={2} isAnimationActive={false}>
          {data.map((row, index) => <Cell key={row.label} fill={PALETTE[index % PALETTE.length]} />)}
        </Pie>{tooltip}
      </PieChart> : mode === 'treemap' ? <Treemap data={data.map((row) => ({ name: row.label, value: row.value }))}
        dataKey="value" nameKey="name" stroke="#09090b" fill={MINT} isAnimationActive={false}>
        {tooltip}
      </Treemap> : mode === 'line' ? <LineChart data={data} margin={{ top: 8, right: 10, bottom: 16, left: 0 }}>
        {axes}<Line type="linear" dataKey="value" stroke={MINT} strokeWidth={2} dot={dot} connectNulls={false} isAnimationActive={false} />
      </LineChart> : mode === 'area' ? <AreaChart data={data} margin={{ top: 8, right: 10, bottom: 16, left: 0 }}>
        {axes}<Area type="linear" dataKey="value" stroke={MINT} fill={MINT} fillOpacity={0.18}
          dot={dot} connectNulls={false} isAnimationActive={false} />
      </AreaChart> : mode === 'horizontal_bar' ? <BarChart data={data} layout="vertical" margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
        <XAxis type="number" stroke="#9ca3af" tick={{ fontSize: 10 }} />
        <YAxis type="category" dataKey="label" width={105} stroke="#9ca3af" tick={{ fontSize: 10 }}
          tickFormatter={(value: string) => value.length > 18 ? `${value.slice(0, 16)}…` : value} />
        {tooltip}<Bar dataKey="value" fill={MINT} isAnimationActive={false} />
      </BarChart> : <BarChart data={data} margin={{ top: 8, right: 10, bottom: 16, left: 0 }}>
        {axes}<Bar dataKey="value" fill={MINT} isAnimationActive={false} />
      </BarChart>}
    </ResponsiveContainer></div>
    {['pie', 'treemap'].includes(mode) && <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-400">
      {data.slice(0, 8).map((row, index) => <div key={row.label} className="flex items-center gap-2">
        {mode === 'pie' && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PALETTE[index % PALETTE.length] }} />}
        <span className="truncate" title={row.label}>{row.label}</span><span className="ml-auto">{display(row.value)}</span>
      </div>)}
      {data.length > 8 && <p className="col-span-2">All {data.length} groups appear in the chart; switch to Table for exact values.</p>}
    </div>}
  </div>;
}

function ResultTable({ result }: { result: QueryResult }) {
  return <div className="max-h-72 overflow-auto rounded-lg border border-gray-800">
    <table className="w-full text-left text-xs">
      <thead className="sticky top-0 bg-zinc-900 text-gray-300"><tr>
        {result.fields.map((field) => <th key={field.key} scope="col" className="p-2 font-medium">{field.key}</th>)}
      </tr></thead>
      <tbody className="text-gray-400">{result.rows.map((row, index) => <tr key={index} className="border-t border-gray-800">
        {result.fields.map((field) => <td key={field.key} className="max-w-64 break-words p-2">{display(row[field.key])}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

function Warning({ children }: { children: React.ReactNode }) {
  return <div className="flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/20 p-2 text-xs text-amber-300"><TriangleAlert className="h-4 w-4 shrink-0" /><div>{children}</div></div>;
}
export function WidgetCard({ widget, result, fields, editing, onToggleEdit, onChange, onRemove, column, editable = true, removeLabel = 'Remove' }: {
  widget: Widget; result?: WidgetOutcome; fields: ModelFieldGroup[]; editing: boolean;
  onToggleEdit: () => void; onChange: (patch: Partial<Widget>) => void; onRemove: () => void;
  column?: ModelFieldGroup['columns'][number]; editable?: boolean; removeLabel?: string;
}) {
  const data = result && !('error' in result) ? result : null;
  const dimension = data?.fields.find((field) => field.kind === 'dimension')?.key;
  const rows = data?.rows.map((row) => ({ name: dimension ? formatPeriod(row[dimension], widget.dimension?.date_part) : 'Total', value: typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null })) ?? [];
  const composition = widget.chart === 'pie' || widget.chart === 'treemap';
  const additive = widget.measure.aggregation === 'count' || (widget.measure.aggregation === 'sum' && column?.additivity === 'additive');
  const unsafeComposition = composition && (!additive || rows.some((row) => row.value == null || row.value < 0) || !rows.some((row) => (row.value ?? 0) > 0));
  const unsafeShape = ['radar', 'radial', 'funnel'].includes(widget.chart) && rows.some((row) => row.value == null || row.value < 0);
  const textResult = data?.rows.some((row) => row.value != null && typeof row.value !== 'number');
  const caps: Partial<Record<CustomChartType, number>> = { radar: 12, radial: 8, treemap: 20, funnel: 10, horizontal_bar: 15 };
  const cap = caps[widget.chart];
  return <div className="min-w-0 rounded-xl border border-gray-800 bg-zinc-900/40 p-4">
    <div className="mb-3 flex items-start justify-between gap-2"><div>
      {editing ? <input aria-label="Chart title" value={widget.title} onChange={(event) => onChange({ title: event.target.value })} className="w-full border-b border-emerald-700 bg-transparent text-sm text-white" /> : <h3 className="text-sm font-semibold text-white">{widget.title}</h3>}
      {data && <p className="mt-1 text-xs text-gray-500">{data.base_table_name}{data.joined_tables.length ? ` + ${data.joined_tables.join(', ')}` : ''} · {count(data.row_count)} result rows</p>}
    </div><div className="flex gap-2">
      <button type="button" disabled={!editable} aria-label={`Edit ${widget.title}`} onClick={onToggleEdit} className="flex items-center gap-1 text-xs text-gray-400 disabled:opacity-40"><Settings2 className="h-4 w-4" />{editing ? 'Done editing' : 'Edit'}</button>
      <button type="button" disabled={!editable} aria-label={`${removeLabel} ${widget.title}`} onClick={onRemove} className="text-xs text-gray-400 disabled:opacity-40">{removeLabel === 'Remove' ? <Trash2 className="h-4 w-4" /> : removeLabel}</button>
    </div></div>
    {editing && <WidgetEditor widget={widget} fields={fields} onChange={onChange} />}
    <div className="mb-3 space-y-2">
      {data?.warnings.map((warning, index) => <Warning key={index}>{warning}</Warning>)}
      {data?.truncated && <Warning>Partial result: the query limit was reached. Increase the limit to include more groups.</Warning>}
      {unsafeShape && <Warning>This chart needs non-negative numeric values. Showing the table instead.</Warning>}
      {widget.chart === 'pie' && data?.truncated && <Warning>Shares describe returned groups only, not the full dataset.</Warning>}
      {unsafeComposition && <Warning>A composition chart needs non-negative additive values. Showing the table instead.</Warning>}
      {cap && rows.length > cap && !unsafeComposition && !unsafeShape && <Warning>This chart displays the first {cap} of {rows.length} returned groups. Choose Table to see all returned groups.</Warning>}
      {widget.chart === 'funnel' && <Warning>This compares grouped values; stage order and conversion rates are not established by the data model.</Warning>}
      {widget.chart === 'scatter' && <Warning>This shows values by category, not a relationship between two numeric variables.</Warning>}
      {(widget.chart === 'line' || widget.chart === 'area') && widget.dimension && !['date', 'datetime'].includes(fields.find((group) => group.table_id === widget.dimension?.table_id)?.columns.find((entry) => entry.name === widget.dimension?.column)?.logical_type ?? '') && <Warning>The horizontal axis uses group order. This is a time trend only if the selected field represents time.</Warning>}
    </div>
    <div className="h-64 min-w-0">{result && 'error' in result ? <Warning>{result.error} Edit the chart or use Refresh to retry.</Warning> : !data ? <p role="status" className="text-xs text-gray-400">Loading chart…</p> : !rows.length ? <p className="text-xs text-gray-400">No matching data.</p> : textResult ? <div className="h-full overflow-auto"><table className="w-full text-left text-xs text-gray-300"><tbody>{data.rows.map((row, index) => <tr key={index}>{data.fields.map((field) => <td key={field.key} className="border-b border-gray-800 p-2">{String(row[field.key] ?? '—')}</td>)}</tr>)}</tbody></table></div> : <ChartBody widget={unsafeComposition || unsafeShape ? { ...widget, chart: 'table' } : widget} rows={rows} />}</div>
    {data && <details className="mt-3 text-xs text-gray-500"><summary className="cursor-pointer">Show query</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words p-2">{data.sql}</pre></details>}
  </div>;
}
function ChartBody({ widget, rows }: { widget: Widget; rows: { name: string; value: number | null }[] }) {
  const axis = { stroke: '#374151', tickLine: false as const, axisLine: false as const };
  const tick = { fontSize: 9, fill: '#6b7280' };
  if (widget.chart === 'kpi') {
    const total = rows[0]?.value ?? null;
    return (
      <div className="h-full flex flex-col items-center justify-center">
        <span className="text-4xl font-extrabold font-mono text-white">{total == null ? '—' : compact(total)}</span>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider mt-2">
          {widget.measure.aggregation.replace('_', ' ')} of {widget.measure.column ?? 'rows'}
        </span>
      </div>
    );
  }
  if (widget.chart === 'table') {
    return (
      <div className="h-full overflow-auto rounded-lg border border-gray-800/50">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-zinc-900/90">
            <tr className="border-b border-gray-800">
              <th className="px-3 py-2 text-gray-400 font-semibold">Group</th>
              <th className="px-3 py-2 text-gray-400 font-semibold text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-b border-gray-800/30">
                <td className="px-3 py-1.5 text-gray-300 truncate max-w-[200px]">{row.name}</td>
                <td className="px-3 py-1.5 text-gray-200 text-right font-mono">{row.value == null ? '—' : exact(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (widget.chart === 'pie') {
    const total = rows.reduce((sum, row) => sum + (row.value ?? 0), 0);
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey="name" innerRadius="50%" outerRadius="78%" paddingAngle={2} strokeWidth={0}>
            {rows.map((row, index) => <Cell key={row.name} fill={WIDGET_PALETTE[index % WIDGET_PALETTE.length]} />)}
          </Pie>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value: unknown, name: unknown) => {
              const amount = typeof value === 'number' ? value : 0;
              const share = total ? ((amount / total) * 100).toFixed(1) : '0';
              return [`${exact(amount)} (${share}%)`, String(name ?? '')];
            }}
          />
          <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
        </PieChart>
      </ResponsiveContainer>
    );
  }
  if (widget.chart === 'radar') {
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <RadarChart data={rows.slice(0, 12)} outerRadius="72%">
          <PolarGrid stroke="rgba(255,255,255,0.08)" />
          <PolarAngleAxis dataKey="name" tick={{ fontSize: 9, fill: '#9ca3af' }} />
          <PolarRadiusAxis tick={false} axisLine={false} />
          <Radar dataKey="value" stroke="#35e0a1" fill="#35e0a1" fillOpacity={0.3} strokeWidth={2} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipNumber} />
        </RadarChart>
      </ResponsiveContainer>
    );
  }
  if (widget.chart === 'radial') {
    const maximum = Math.max(...rows.map((row) => row.value ?? 0), 1);
    const radialRows = rows.slice(0, 8).map((row, index) => ({
      ...row,
      fill: WIDGET_PALETTE[index % WIDGET_PALETTE.length],
    }));
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <RadialBarChart data={radialRows} innerRadius="18%" outerRadius="92%" startAngle={90} endAngle={-270}>
          <PolarAngleAxis type="number" domain={[0, maximum]} tick={false} />
          <RadialBar dataKey="value" background={{ fill: 'rgba(255,255,255,0.04)' }} cornerRadius={6} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipNumber} />
          <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 9, color: '#9ca3af' }} />
        </RadialBarChart>
      </ResponsiveContainer>
    );
  }
  if (widget.chart === 'treemap') {
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <Treemap
          data={rows.slice(0, 20)}
          dataKey="value"
          nameKey="name"
          aspectRatio={1.6}
          stroke="#030712"
          fill="#10b981"
          isAnimationActive={false}
        />
      </ResponsiveContainer>
    );
  }
  if (widget.chart === 'funnel') {
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <FunnelChart>
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipNumber} />
          <Funnel dataKey="value" data={rows.slice(0, 10)} isAnimationActive={false}>
            {rows.slice(0, 10).map((row, index) => (
              <Cell key={row.name} fill={WIDGET_PALETTE[index % WIDGET_PALETTE.length]} />
            ))}
            <LabelList dataKey="name" position="right" fill="#d1d5db" fontSize={9} />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    );
  }
  if (widget.chart === 'scatter') {
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <ScatterChart margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
          <XAxis dataKey="name" {...axis} tick={tick} />
          <YAxis dataKey="value" {...axis} tick={tick} tickFormatter={axisNumber} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipNumber} />
          <Scatter data={rows} fill={WIDGET_PALETTE[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }
  if (widget.chart === 'line' || widget.chart === 'area') {
    const ChartComponent = widget.chart === 'line' ? LineChart : AreaChart;
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <ChartComponent data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id={`fill-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
          <XAxis dataKey="name" {...axis} tick={tick} />
          <YAxis {...axis} tick={tick} tickFormatter={axisNumber} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipNumber} />
          {widget.chart === 'line' ? (
            <Line type="linear" dataKey="value" stroke="#6366f1" strokeWidth={2} dot={{ r: 2 }} />
          ) : (
            <Area type="linear" dataKey="value" stroke="#10b981" strokeWidth={2} fill={`url(#fill-${widget.id})`} />
          )}
        </ChartComponent>
      </ResponsiveContainer>
    );
  }
  if (widget.chart === 'horizontal_bar') {
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <BarChart data={rows.slice(0, 15)} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" horizontal={false} />
          <XAxis type="number" {...axis} tick={tick} tickFormatter={axisNumber} />
          <YAxis dataKey="name" type="category" {...axis} tick={tick} width={74} />
          <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipNumber} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
          <Bar dataKey="value" radius={[0, 5, 5, 0]} maxBarSize={24}>
            {rows.map((row, index) => <Cell key={row.name} fill={WIDGET_PALETTE[index % WIDGET_PALETTE.length]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
        <XAxis
          dataKey="name"
          {...axis}
          tick={tick}
          interval={0}
          angle={rows.length > 6 ? -35 : 0}
          textAnchor={rows.length > 6 ? 'end' : 'middle'}
          height={rows.length > 6 ? 60 : 30}
        />
        <YAxis {...axis} tick={tick} tickFormatter={axisNumber} />
        <Tooltip contentStyle={TOOLTIP_STYLE} formatter={tooltipNumber} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
        <Bar dataKey="value" radius={[5, 5, 0, 0]} maxBarSize={46}>
          {rows.map((row, index) => <Cell key={row.name} fill={WIDGET_PALETTE[index % WIDGET_PALETTE.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
function WidgetEditor({ widget, fields, onChange }: {
  widget: Widget; fields: ModelFieldGroup[]; onChange: (patch: Partial<Widget>) => void;
}) {
  const encode = (table: number, column: string | null) => JSON.stringify([table, column]);
  const decode = (value: string) => { const [table_id, column] = JSON.parse(value) as [number, string | null]; return { table_id, column }; };
  const selected = fields.find((group) => group.table_id === widget.measure.table_id)?.columns.find((column) => column.name === widget.measure.column);
  const allowed: Aggregation[] = widget.measure.column === null ? ['count'] : NUMERIC.has(selected?.logical_type ?? '')
    ? AGGREGATIONS.filter((aggregation) => aggregation !== 'sum' || selected?.additivity === 'additive')
    : ['count', 'count_distinct', 'min', 'max'];
  const dimension = fields.find((group) => group.table_id === widget.dimension?.table_id)?.columns.find((column) => column.name === widget.dimension?.column);
  const input = 'w-full rounded border border-gray-700 bg-zinc-900 p-2 text-xs text-gray-200';
  return <div className="mb-3 grid grid-cols-1 gap-3 rounded-lg border border-gray-800 p-3 sm:grid-cols-2">
    <label className="space-y-1 text-xs text-gray-400">Chart
      <select aria-label="Custom graph type" className={input} value={widget.chart} onChange={(event) => { const chart = event.target.value as CustomChartType; onChange({ chart, ...(chart === 'kpi' ? { dimension: null } : {}) }); }}>
        {CUSTOM_CHART_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
    <label className="space-y-1 text-xs text-gray-400">Group by
      <select aria-label="Custom graph group by" className={input} disabled={widget.chart === 'kpi'} value={widget.dimension ? encode(widget.dimension.table_id, widget.dimension.column) : ''}
        onChange={(event) => { const decoded = event.target.value ? decode(event.target.value) : null; onChange({ dimension: decoded && decoded.column !== null ? { table_id: decoded.table_id, column: decoded.column } : null }); }}>
        <option value="">Nothing (one aggregate)</option>
        {fields.map((group) => <optgroup key={group.table_id} label={group.table_name}>{group.columns.map((column) => <option key={column.name} value={encode(group.table_id, column.name)}>{column.name}</option>)}</optgroup>)}
        {widget.dimension && !dimension && <option value={encode(widget.dimension.table_id, widget.dimension.column)}>{widget.dimension.column} (missing field)</option>}
      </select></label>
    <label className="space-y-1 text-xs text-gray-400">Value / source table
      <select aria-label="Custom graph measure" className={input} value={encode(widget.measure.table_id, widget.measure.column)} onChange={(event) => {
        const decoded = decode(event.target.value);
        const column = fields.find((group) => group.table_id === decoded.table_id)?.columns.find((entry) => entry.name === decoded.column);
        const aggregation = decoded.column === null ? 'count' : NUMERIC.has(column?.logical_type ?? '') ? column?.default_aggregation ?? 'avg' : 'count_distinct';
        onChange({ measure: { ...decoded, aggregation }, base_table_id: decoded.table_id });
      }}>
        {fields.map((group) => <optgroup key={group.table_id} label={group.table_name}>
          <option value={encode(group.table_id, null)}>Count rows in {group.table_name}</option>
          {group.columns.map((column) => <option key={column.name} value={encode(group.table_id, column.name)}>{column.name}</option>)}
        </optgroup>)}
        {widget.measure.column !== null && !selected && <option value={encode(widget.measure.table_id, widget.measure.column)}>{widget.measure.column} (missing field)</option>}
      </select></label>
    <label className="space-y-1 text-xs text-gray-400">Calculation
      <select aria-label="Custom graph calculation" className={input} value={widget.measure.aggregation} onChange={(event) => onChange({ measure: { ...widget.measure, aggregation: event.target.value as Aggregation } })}>
        {!allowed.includes(widget.measure.aggregation) && <option value={widget.measure.aggregation} disabled>{widget.measure.aggregation} (unsupported for this field)</option>}
        {allowed.map((aggregation) => <option key={aggregation} value={aggregation}>{aggregation.replace('_', ' ')}</option>)}
      </select></label>
    {widget.dimension && dimension && ['date', 'datetime'].includes(dimension.logical_type) && <label className="space-y-1 text-xs text-gray-400">Date grouping
      <select aria-label="Custom graph date grouping" className={input} value={widget.dimension.date_part ?? ''} onChange={(event) => onChange({ dimension: { ...widget.dimension!, date_part: event.target.value || undefined } })}>
        <option value="">Original date / timestamp</option>{DATE_PARTS.map((part) => <option key={part} value={part}>{isTimeGrain(part) ? TIME_GRAIN_LABELS[part] : part.replaceAll('_', ' ')}</option>)}
      </select></label>}
    <label className="space-y-1 text-xs text-gray-400">Maximum result groups
      <input className={input} type="number" min={1} max={1000} value={widget.limit} onChange={(event) => { const limit = event.target.valueAsNumber; if (Number.isInteger(limit) && limit >= 1 && limit <= 1000) onChange({ limit }); }} />
    </label>
    <p className="text-xs text-gray-500 sm:col-span-2">Cross-table charts require one approved join path. The backend rejects joins that would multiply totals. Saving stores the chart configuration; Refresh retrieves current figures.</p>
  </div>;
}
