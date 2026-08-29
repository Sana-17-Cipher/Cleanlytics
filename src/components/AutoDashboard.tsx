'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Area, AreaChart, Cell, Pie, PieChart, PolarAngleAxis, RadialBar, RadialBarChart,
  ResponsiveContainer, Tooltip, Treemap, XAxis, YAxis,
} from 'recharts';
import {
  Activity, ArrowUpRight, Calendar, Crown, Filter, Hash, Loader2,
  MapPin, Package, Sigma, Table2, TrendingDown, TrendingUp, TriangleAlert, Users, X,
} from 'lucide-react';

import { ApiError, api } from '../lib/api';
import {
  availableBreakdownModes, geoPointFor, selectBreakdownView,
} from '../lib/dashboard-breakdown';
import type { BreakdownMode } from '../lib/dashboard-breakdown';
import { compact, count, exact } from '../lib/format';
import type {
  CellValue, ModelFieldGroup, QueryResult, QuerySpec, Row, SemanticModel, TableSummary,
} from '../lib/types';

const MINT = '#35e0a1';

/** One mint family keeps category identity calm without turning the panel into confetti. */
const COMPOSITION_FILL = [
  '#35e0a1', '#2bb88c', '#229574', '#1f7d69', '#1d685e', '#1d5854',
  '#1c4a4b', '#1b4045', '#19383f', '#172f37', '#152a31', '#13252c',
];

const BREAKDOWN_MODE_LABELS: Record<BreakdownMode, string> = {
  auto: 'Auto',
  map: 'Map',
  donut: 'Donut',
  treemap: 'Treemap',
  bubble: 'Bubbles',
  radial: 'Radial',
  waffle: 'Waffle',
  table: 'Table',
  kpi: 'KPI',
};

/** Columns that can head a breakdown: few enough values to read as a chart. */
const BREAKDOWN_ROLES = new Set(['category', 'geographic', 'dimension']);
const MAX_BREAKDOWN_VALUES = 40;

type Column = ModelFieldGroup['columns'][number];
type FieldRef = { table_id: number; column: string };

/** The one value the whole dashboard is currently narrowed to. */
interface ActiveFilter extends FieldRef {
  value: string;
}

function sameField(a: FieldRef, b: FieldRef): boolean {
  return a.table_id === b.table_id && a.column === b.column;
}

/**
 * What the dashboard decided to show, derived entirely from the semantic model.
 * Anything the data cannot support is left null and its slot is dropped rather
 * than filled with something misleading.
 */
interface Plan {
  factTableId: number;
  factTableName: string;
  primary: { table_id: number; column: string; aggregation: Column['default_aggregation']; name: string } | null;
  counts: { ref: FieldRef; name: string }[];
  time: FieldRef | null;
  breakdowns: { ref: FieldRef; name: string; role: Column['semantic_role'] }[];
  listDim: { ref: FieldRef; name: string; attributes: FieldRef[] } | null;
}

/** Picks the fact table, its headline measure, and every supporting field. */
function buildPlan(model: SemanticModel): Plan | null {
  const fact =
    model.tables.find((t) => t.kind === 'fact')
    ?? [...model.tables].sort((a, b) => b.outgoing - a.outgoing)[0];
  if (!fact) return null;

  const factGroup = model.fields.find((g) => g.table_id === fact.id);

  const measure = factGroup?.columns
    .filter((c) => c.semantic_role === 'measure' && c.additivity === 'additive')
    .sort((a, b) => b.distinct_count - a.distinct_count)[0]
    ?? factGroup?.columns.find((c) => c.semantic_role === 'measure');

  // Distinct counts come from the dimension tables the fact points at, which is
  // what makes "49 customers" mean customers who actually ordered.
  const counts: Plan['counts'] = [];
  for (const group of model.fields) {
    if (group.table_id === fact.id) continue;
    const identifier = group.columns.find((c) => c.semantic_role === 'identifier');
    if (identifier && counts.length < 2) {
      counts.push({ ref: { table_id: group.table_id, column: identifier.name }, name: group.table_name });
    }
  }

  let time: FieldRef | null = null;
  for (const group of model.fields) {
    const column = group.columns.find((c) => c.semantic_role === 'time' && c.distinct_count > 2);
    if (column) { time = { table_id: group.table_id, column: column.name }; break; }
  }

  const breakdowns: Plan['breakdowns'] = [];
  for (const group of model.fields) {
    for (const column of group.columns) {
      if (breakdowns.length >= 3) break;
      if (!BREAKDOWN_ROLES.has(column.semantic_role)) continue;
      if (column.distinct_count < 2 || column.distinct_count > MAX_BREAKDOWN_VALUES) continue;
      if (breakdowns.some((b) => b.name === column.name)) continue;
      breakdowns.push({
        ref: { table_id: group.table_id, column: column.name },
        name: column.name,
        role: column.semantic_role,
      });
    }
  }

  // The list wants a human-readable label where one exists, so a column called
  // "name" beats a bare id even though both are identifiers.
  let listDim: Plan['listDim'] = null;
  for (const group of model.fields) {
    if (group.table_id === fact.id) continue;
    const identifiers = group.columns.filter(
      (c) => c.semantic_role === 'identifier' && c.logical_type === 'text' && c.distinct_count >= 5,
    );
    const named = identifiers.find((c) => /name|title|label/i.test(c.name)) ?? identifiers[0];
    if (!named) continue;
    const attributes = group.columns
      .filter((c) => c !== named && BREAKDOWN_ROLES.has(c.semantic_role))
      .slice(0, 2)
      .map((c) => ({ table_id: group.table_id, column: c.name }));
    listDim = { ref: { table_id: group.table_id, column: named.name }, name: group.table_name, attributes };
    break;
  }

  return {
    factTableId: fact.id,
    factTableName: fact.table_name,
    primary: measure
      ? { table_id: fact.id, column: measure.name, aggregation: measure.default_aggregation, name: measure.name }
      : null,
    counts,
    time,
    breakdowns,
    listDim,
  };
}

/**
 * Every query the dashboard needs for a given selection, in a fixed order:
 * headline, trend, records, then one per breakdown.
 *
 * Pure, so the same function serves both the live render and prefetching for a
 * value the pointer is merely hovering.
 */
function specsFor(plan: Plan, active: ActiveFilter | null): (QuerySpec | null)[] {
  const { primary } = plan;
  if (!primary) return [];

  // A chart never filters itself: keeping its own dimension unfiltered is what
  // lets you see the selection in context rather than a single bar.
  const filtersFor = (owner: FieldRef | null): QuerySpec['filters'] => {
    if (!active) return [];
    if (owner && sameField(owner, active)) return [];
    return [{ table_id: active.table_id, column: active.column, operator: 'in', value: [active.value] }];
  };

  const measure = { table_id: primary.table_id, column: primary.column, aggregation: primary.aggregation };

  const measures: QuerySpec['measures'] = [
    { ...measure, label: 'total' },
    { table_id: plan.factTableId, column: null, aggregation: 'count', label: 'rows' },
    ...plan.counts.map((entry, index) => ({
      table_id: entry.ref.table_id, column: entry.ref.column,
      aggregation: 'count_distinct' as const, label: `count${index}`,
    })),
  ];

  return [
    { base_table_id: plan.factTableId, measures, filters: filtersFor(null) },
    plan.time
      ? {
          base_table_id: plan.factTableId,
          dimensions: [{ table_id: plan.time.table_id, column: plan.time.column, label: 'at' }],
          measures: [{ ...measure, label: 'total' }],
          filters: filtersFor(null),
          limit: 400,
        }
      : null,
    plan.listDim
      ? {
          base_table_id: plan.factTableId,
          dimensions: [
            { table_id: plan.listDim.ref.table_id, column: plan.listDim.ref.column, label: 'name' },
            ...plan.listDim.attributes.map((a, i) => ({ ...a, label: `attr${i}` })),
          ],
          measures: [
            { ...measure, label: 'total' },
            { table_id: plan.factTableId, column: null, aggregation: 'count' as const, label: 'rows' },
          ],
          filters: filtersFor(plan.listDim.ref),
          order_by: { field: 'total', direction: 'desc' as const },
          limit: 6,
        }
      : null,
    ...plan.breakdowns.map((entry) => ({
      base_table_id: plan.factTableId,
      dimensions: [{ table_id: entry.ref.table_id, column: entry.ref.column, label: 'name' }],
      measures: [{ ...measure, label: 'total' }],
      filters: filtersFor(entry.ref),
      order_by: { field: 'total', direction: 'desc' as const },
      limit: MAX_BREAKDOWN_VALUES,
    })),
  ];
}

function numberAt(row: Row | undefined, key: string): number | null {
  const value = row?.[key];
  return typeof value === 'number' ? value : null;
}

function textAt(row: Row, key: string): string {
  const value: CellValue = row[key];
  return value == null ? '' : String(value);
}

/** Two-letter badge for a record, so rows are scannable without reading. */
function initials(label: string): string {
  const words = label.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Picks an icon that suits what a table holds, from its name alone. */
function tableIcon(name: string) {
  const lower = name.toLowerCase();
  if (/date|time|day|month|calendar/.test(lower)) return Calendar;
  if (/region|city|state|country|location|geo/.test(lower)) return MapPin;
  if (/customer|user|client|people|employee|person/.test(lower)) return Users;
  if (/product|item|sku|stock|inventory/.test(lower)) return Package;
  return Table2;
}

interface AutoDashboardProps {
  projectId: number;
  model: SemanticModel;
  tables: TableSummary[];
  onOpenTable: (tableId: number) => void;
}

/**
 * The generated dashboard.
 *
 * Nothing here is hand-configured: the plan comes from the semantic model and
 * every figure from the query endpoint, so the same dashboard appears for any
 * project that has a fact table and at least one measure.
 */
export default function AutoDashboard({ projectId, model, tables, onOpenTable }: AutoDashboardProps) {
  const plan = useMemo(() => buildPlan(model), [model]);

  const [headline, setHeadline] = useState<QueryResult | null>(null);
  const [trend, setTrend] = useState<QueryResult | null>(null);
  const [breakdowns, setBreakdowns] = useState<(QueryResult | null)[]>([]);
  const [list, setList] = useState<QueryResult | null>(null);
  // The spinner is only for the very first load. Every later fetch keeps the
  // current numbers on screen and swaps them when the new ones land, so
  // clicking a value never blanks the page.
  const [ready, setReady] = useState(() => plan === null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActiveFilter | null>(null);

  /**
   * Results keyed by the exact query that produced them. Clearing a filter, or
   * re-selecting something seen before, then costs nothing and repaints in the
   * same frame instead of waiting on the network.
   */
  const cache = useRef(new Map<string, QueryResult>());
  useEffect(() => { cache.current.clear(); }, [projectId]);

  // Clicking a value narrows everything else. Clicking it again clears.
  const toggleFilter = useCallback((field: FieldRef, value: string) =>
    setFilter((current) =>
      current && sameField(current, field) && current.value === value
        ? null
        : { ...field, value },
    ), []);
  const clearFilter = useCallback(() => setFilter(null), []);

  // Stable because `plan` is memoised, so these identities survive a re-render
  // and the memoised panels below can actually skip their work.
  const leaderRef = plan?.breakdowns[0]?.ref ?? null;
  const compositionIndex = plan?.breakdowns[1] ? 1 : 0;
  const compositionRef = plan?.breakdowns[compositionIndex]?.ref ?? null;
  const listRef = plan?.listDim?.ref ?? null;

  /** Runs one query, serving it from cache when the exact spec was seen before. */
  const runSpec = useCallback(async (spec: QuerySpec): Promise<QueryResult | null> => {
    const key = JSON.stringify(spec);
    const hit = cache.current.get(key);
    if (hit) return hit;
    try {
      const result = await api.query(projectId, spec);
      cache.current.set(key, result);
      return result;
    } catch {
      // Not cached: a transient failure should not stick to this selection.
      return null;
    }
  }, [projectId]);

  /**
   * Warms the cache for a value the pointer is only hovering, so the click that
   * usually follows repaints from memory instead of waiting on the network.
   */
  const prefetch = useCallback((field: FieldRef, value: string) => {
    if (!plan) return;
    for (const spec of specsFor(plan, { ...field, value })) {
      if (spec && !cache.current.has(JSON.stringify(spec))) void runSpec(spec);
    }
  }, [plan, runSpec]);

  const selectLeader = useCallback(
    (value: string) => { if (leaderRef) toggleFilter(leaderRef, value); }, [leaderRef, toggleFilter]);
  const hoverLeader = useCallback(
    (value: string) => { if (leaderRef) prefetch(leaderRef, value); }, [leaderRef, prefetch]);
  const selectComposition = useCallback(
    (value: string) => { if (compositionRef) toggleFilter(compositionRef, value); },
    [compositionRef, toggleFilter],
  );
  const selectRecord = useCallback(
    (value: string) => { if (listRef) toggleFilter(listRef, value); }, [listRef, toggleFilter]);
  const hoverRecord = useCallback(
    (value: string) => { if (listRef) prefetch(listRef, value); }, [listRef, prefetch]);

  useEffect(() => {
    if (!plan) return;
    let cancelled = false;

    (async () => {
      setRefreshing(true);
      setError(null);
      try {
        const specs = specsFor(plan, filter);
        const [head, series, records, ...breaks] = await Promise.all(
          specs.map((spec) => (spec ? runSpec(spec) : Promise.resolve(null))),
        );

        if (cancelled) return;
        setHeadline(head);
        setTrend(series);
        setList(records);
        setBreakdowns(breaks);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'Could not build the dashboard.');
      } finally {
        if (!cancelled) { setRefreshing(false); setReady(true); }
      }
    })();

    return () => { cancelled = true; };
  }, [plan, filter, runSpec]);

  /* ── Derived display values ──────────────────────────────────────────── */

  const head = headline?.rows[0];
  const total = numberAt(head, 'total');
  const rows = numberAt(head, 'rows');

  const quality = useMemo(() => {
    const scores = tables
      .map((t) => t.summary?.quality_score)
      .filter((s): s is number => typeof s === 'number');
    if (scores.length === 0) return null;
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  }, [tables]);

  const trendPoints = useMemo(() => {
    if (!trend) return [];
    return [...trend.rows]
      .map((row) => ({ at: textAt(row, 'at'), total: numberAt(row, 'total') ?? 0 }))
      .sort((a, b) => a.at.localeCompare(b.at));
  }, [trend]);

  /** Opening third against closing third, which is steadier than first vs last. */
  const growth = useMemo(() => {
    if (trendPoints.length < 4) return null;
    const third = Math.max(1, Math.floor(trendPoints.length / 3));
    const opening = trendPoints.slice(0, third).reduce((a, p) => a + p.total, 0);
    const closing = trendPoints.slice(-third).reduce((a, p) => a + p.total, 0);
    if (opening <= 0) return null;
    return ((closing - opening) / opening) * 100;
  }, [trendPoints]);

  const peak = useMemo(
    () => trendPoints.reduce<{ at: string; total: number } | null>(
      (best, point) => (best === null || point.total > best.total ? point : best), null),
    [trendPoints],
  );

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin text-emerald-400 mr-3" />
        <span className="text-sm">Building the dashboard…</span>
      </div>
    );
  }

  if (!plan || !plan.primary) {
    return (
      <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-950/20 border border-amber-900/50 text-amber-300 text-xs">
        <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
        <p>
          This project has no numeric measure to summarise yet, so there is nothing to put on a dashboard.
          Upload a table with a numeric column, or build charts by hand below.
        </p>
      </div>
    );
  }

  const leaderResult = breakdowns[0] ?? null;
  const primaryName = plan.primary.name;

  return (
    <div className="space-y-4 animate-fade-in">
      {error && (
        <div className="flex items-start gap-3 p-3 rounded-xl bg-red-950/20 border border-red-900/50 text-red-300 text-xs">
          <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {/* Headline band */}
      <div className="relative overflow-hidden rounded-2xl border border-gray-800 bg-gradient-to-br from-emerald-950/25 via-zinc-900/50 to-zinc-900/30 p-5">
        {/* Static wash, no repainting animation. */}
        <div
          className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full opacity-[0.10]"
          style={{ background: `radial-gradient(circle, ${MINT} 0%, transparent 68%)` }}
          aria-hidden
        />
        <div className="relative flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-400/80">
              {plan.factTableName}
            </p>
            <h2 className="text-[26px] font-bold tracking-tight text-white mt-1 leading-tight">
              {compact(total)}{' '}
              <span className="text-base font-medium text-gray-500">total {primaryName}</span>
            </h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              {count(rows)} records across {tables.length} linked {tables.length === 1 ? 'table' : 'tables'}
            </p>

            <div className="mt-3 flex items-center gap-2.5 min-h-[26px]">
              {filter ? (
                <button
                  onClick={clearFilter}
                  className="group inline-flex items-center gap-2 rounded-full border border-emerald-700/60 bg-emerald-500/10 pl-3 pr-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                >
                  <Filter className="h-3 w-3" />
                  <span>
                    {filter.column} is <b className="font-semibold text-white">{filter.value}</b>
                  </span>
                  <X className="h-3.5 w-3.5 text-emerald-500 group-hover:text-white" />
                </button>
              ) : (
                <p className="text-[10.5px] text-gray-600">
                  Click any value to narrow every chart to it.
                </p>
              )}
              {/* Static, so a fast update does not flash a spinner on screen. */}
              {refreshing && <span className="text-[10px] text-emerald-500/60">updating</span>}
            </div>

            <div className="flex flex-wrap gap-2.5 mt-4">
              <StatChip icon={Sigma} label={`Total ${primaryName}`} value={compact(total)} accent />
              <StatChip icon={Hash} label="Records" value={count(rows)} />
              {plan.counts.map((entry, index) => (
                <StatChip
                  key={entry.name}
                  icon={tableIcon(entry.name)}
                  label={entry.name}
                  value={count(numberAt(head, `count${index}`))}
                />
              ))}
            </div>
          </div>

          {quality !== null && <QualityGauge score={quality} />}
        </div>
      </div>

      {/* Leaderboard, trend, breakdown */}
      <div className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.4fr_0.9fr] gap-4">
        <Panel
          title={`Top ${plan.breakdowns[0]?.name ?? 'values'}`}
          hint={`by ${primaryName}`}
        >
          <Leaderboard
            result={leaderResult}
            selected={leaderRef && filter && sameField(leaderRef, filter) ? filter.value : null}
            onSelect={leaderRef ? selectLeader : null}
            onHover={leaderRef ? hoverLeader : null}
          />
        </Panel>

        <Panel>
          {trendPoints.length > 1 ? (
            <>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[26px] font-bold tracking-tight text-white leading-none">
                      {growth === null ? compact(total) : `${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%`}
                    </span>
                    {growth !== null && (
                      <span
                        className={`flex items-center gap-1 text-[10.5px] font-semibold px-1.5 py-0.5 rounded ${
                          growth >= 0
                            ? 'text-emerald-400 bg-emerald-500/10'
                            : 'text-red-400 bg-red-500/10'
                        }`}
                      >
                        {growth >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {growth >= 0 ? 'up' : 'down'}
                      </span>
                    )}
                  </div>
                  <p className="text-[10.5px] text-gray-500 mt-1">
                    {primaryName} over time, opening third against closing third
                  </p>
                </div>
                {peak && (
                  <div className="text-right shrink-0">
                    <p className="text-[9.5px] uppercase tracking-wider text-gray-600">Peak</p>
                    <p className="text-[12px] font-bold text-white tabular-nums">{compact(peak.total)}</p>
                    <p className="text-[9.5px] text-gray-600">{peak.at}</p>
                  </div>
                )}
              </div>

              <div className="h-[164px] mt-3 -mx-1">
                <ResponsiveContainer
                  width="100%" height="100%" minWidth={0}
                  initialDimension={{ width: 520, height: 164 }}
                >
                  <AreaChart data={trendPoints} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
                    <defs>
                      <linearGradient id="autoTrendFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={MINT} stopOpacity={0.38} />
                        <stop offset="100%" stopColor={MINT} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="at" hide />
                    <YAxis hide domain={['dataMin', 'dataMax']} />
                    <Tooltip
                      contentStyle={{
                        background: 'rgba(9,9,11,0.96)', border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 10, fontSize: 11,
                      }}
                      labelStyle={{ color: '#9db0b8' }}
                      formatter={(value) => [exact(Number(value)), primaryName]}
                    />
                    <Area
                      type="monotone" dataKey="total" stroke={MINT} strokeWidth={2}
                      fill="url(#autoTrendFill)" dot={false}
                      activeDot={{ r: 4, fill: '#030712', stroke: MINT, strokeWidth: 2 }}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-between text-[10px] text-gray-600 px-1 pt-1">
                <span>{trendPoints[0]?.at}</span>
                <span>{trendPoints.length} points</span>
                <span>{trendPoints[trendPoints.length - 1]?.at}</span>
              </div>
            </>
          ) : (
            <Empty>No date column reaches this table, so there is no trend to draw.</Empty>
          )}
        </Panel>

        <Panel
          title={plan.breakdowns[compositionIndex] ? `By ${plan.breakdowns[compositionIndex].name}` : 'Breakdown'}
          hint={`by ${primaryName}`}
        >
          <AdaptiveBreakdown
            result={breakdowns[compositionIndex] ?? null}
            measureName={primaryName}
            role={plan.breakdowns[compositionIndex]?.role ?? 'dimension'}
            selected={compositionRef && filter && sameField(compositionRef, filter) ? filter.value : null}
            onSelect={compositionRef ? selectComposition : null}
            onClear={clearFilter}
          />
        </Panel>
      </div>

      {/* Every additional useful dimension gets an insight panel of its own. */}
      {plan.breakdowns.some((_, index) => index !== 0 && index !== compositionIndex) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {plan.breakdowns.map((entry, index) => {
            if (index === 0 || index === compositionIndex) return null;
            const selected = filter && sameField(entry.ref, filter) ? filter.value : null;
            return (
              <Panel key={`${entry.ref.table_id}:${entry.ref.column}`} title={`By ${entry.name}`} hint={`by ${primaryName}`}>
                <AdaptiveBreakdown
                  result={breakdowns[index] ?? null}
                  measureName={primaryName}
                  role={entry.role}
                  selected={selected}
                  onSelect={(value) => toggleFilter(entry.ref, value)}
                  onClear={clearFilter}
                />
              </Panel>
            );
          })}
        </div>
      )}

      {/* One card per table */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        {tables.map((table) => {
          const Icon = tableIcon(table.table_name);
          return (
            <button
              key={table.id}
              onClick={() => onOpenTable(table.id)}
              className="group text-left rounded-2xl bg-zinc-900/40 border border-gray-800 p-3.5 hover:border-emerald-700/60 hover:bg-zinc-900/70 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="h-6 w-6 rounded-lg bg-emerald-500/10 text-emerald-400 grid place-items-center shrink-0">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="text-[10px] uppercase tracking-wider text-gray-500 truncate">
                  {table.table_name}
                </span>
              </div>
              <p className="text-lg font-bold text-white mt-2 tabular-nums">{count(table.row_count)}</p>
              <span className="flex items-center justify-between text-[9.5px] text-gray-600 group-hover:text-emerald-400 border-t border-gray-800 mt-2 pt-2 transition-colors">
                Open table <ArrowUpRight className="h-3 w-3" />
              </span>
            </button>
          );
        })}
      </div>

      {/* Records */}
      {list && list.rows.length > 0 && plan.listDim && (
        <Panel title={`Top ${plan.listDim.name}`} hint={`ranked by ${primaryName}`}>
          <RecordsTable
            result={list}
            attributes={plan.listDim.attributes.map((a) => a.column)}
            measureName={primaryName}
            selected={filter && sameField(plan.listDim.ref, filter) ? filter.value : null}
            onSelect={selectRecord}
            onHover={hoverRecord}
          />
        </Panel>
      )}
    </div>
  );
}

/* ── Small pieces ──────────────────────────────────────────────────────── */

function StatChip({
  icon: Icon, label, value, accent,
}: {
  icon: typeof Sigma; label: string; value: string; accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border px-3.5 py-2.5 min-w-[124px] ${
        accent
          ? 'border-emerald-800/50 bg-emerald-500/[0.07]'
          : 'border-gray-800 bg-zinc-900/50'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-5 w-5 rounded-md grid place-items-center shrink-0 ${
            accent ? 'bg-emerald-400/20 text-emerald-300' : 'bg-white/5 text-gray-400'
          }`}
        >
          <Icon className="h-3 w-3" />
        </span>
        <span className="text-lg font-bold tracking-tight text-white tabular-nums leading-none">{value}</span>
      </div>
      <p className="text-[10.5px] text-gray-500 mt-1.5 truncate">{label}</p>
    </div>
  );
}

function Panel({ title, hint, children }: { title?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-zinc-900/40 border border-gray-800 p-4">
      {title && (
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[12.5px] font-semibold text-white">{title}</p>
          {hint && <p className="text-[9.5px] text-gray-600 truncate">{hint}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-gray-500 py-10 text-center leading-relaxed">{children}</p>;
}

/** Bounded 0 to 100, which is the only thing a gauge can honestly show. */
const QualityGauge = React.memo(function QualityGauge({ score }: { score: number }) {
  const data = [{ name: 'quality', value: score, fill: MINT }];
  return (
    // The arc sweeps more than a semicircle, so the box needs headroom above it.
    <div className="relative shrink-0" style={{ width: 214, height: 158 }}>
      <ResponsiveContainer
        width="100%" height="100%" minWidth={0}
        initialDimension={{ width: 214, height: 158 }}
      >
        <RadialBarChart
          data={data}
          innerRadius={64}
          outerRadius={86}
          startAngle={200}
          endAngle={-20}
          barSize={13}
        >
          {/* The axis carries the 0 to 100 domain; without it the single bar
              fills the whole arc regardless of the score. */}
          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
          <RadialBar
            background={{ fill: 'rgba(255,255,255,0.06)' }}
            dataKey="value"
            cornerRadius={7}
            isAnimationActive={false}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none pb-3">
        <span className="text-[30px] font-bold tracking-tight text-white leading-none tabular-nums">{score}%</span>
        <span className="text-[10.5px] text-gray-500 mt-1">Data quality</span>
      </div>
    </div>
  );
});

/** Ranked rows with exact values and shares, without another bar chart. */
const Leaderboard = React.memo(function Leaderboard({
  result, selected, onSelect, onHover,
}: {
  result: QueryResult | null;
  selected: string | null;
  onSelect: ((value: string) => void) | null;
  onHover: ((value: string) => void) | null;
}) {
  const rows = useMemo(() => {
    if (!result) return [];
    const mapped = result.rows
      .map((row) => ({ name: textAt(row, 'name') || 'Not set', total: numberAt(row, 'total') ?? 0 }))
      .slice(0, 5);
    const sum = mapped.reduce((a, r) => a + r.total, 0);
    return mapped.map((entry) => ({
      ...entry,
      share: sum > 0 ? (entry.total / sum) * 100 : 0,
    }));
  }, [result]);

  if (rows.length === 0) return <Empty>No breakdown available.</Empty>;

  return (
    <div className="space-y-1.5 mt-3">
      {rows.map((entry, index) => {
        const isSelected = selected === entry.name;
        // With a selection active, everything unselected steps back so the
        // chosen row is obvious even when it is not the biggest.
        const dimmed = selected !== null && !isSelected;
        return (
          <button
            key={entry.name}
            type="button"
            disabled={onSelect === null}
            onClick={() => onSelect?.(entry.name)}
            onMouseEnter={() => onHover?.(entry.name)}
            onFocus={() => onHover?.(entry.name)}
            aria-pressed={isSelected}
            className={`relative w-full text-left overflow-hidden rounded-xl border px-3 py-2.5 transition-colors ${
              isSelected
                ? 'border-emerald-400 bg-emerald-500/15'
                : index === 0
                  ? 'border-emerald-700/50 bg-emerald-500/[0.06]'
                  : 'border-gray-800/70 bg-zinc-900/40'
            } ${dimmed ? 'opacity-45' : ''} ${onSelect ? 'hover:border-emerald-600/70 cursor-pointer' : ''}`}
          >
            <span className="relative flex items-center gap-2.5">
              <span
                className={`h-5 w-5 rounded-md grid place-items-center text-[9.5px] font-bold shrink-0 ${
                  index === 0 ? 'bg-emerald-400 text-emerald-950' : 'bg-white/5 text-gray-400'
                }`}
              >
                {index === 0 ? <Crown className="h-3 w-3" /> : index + 1}
              </span>
              <span className="text-[12px] font-semibold text-white truncate flex-1">{entry.name}</span>
              <span className="text-[11px] font-bold text-white tabular-nums shrink-0">
                {compact(entry.total)}
              </span>
              <span className="text-[9.5px] text-gray-500 tabular-nums w-9 text-right shrink-0">
                {entry.share.toFixed(0)}%
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
});

type CompositionDatum = {
  name: string;
  total: number;
  share: number;
  fill: string;
};

type TreemapTileProps = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  depth?: number;
  index?: number;
  data: CompositionDatum[];
  selected: string | null;
  onSelect: ((value: string) => void) | null;
};

/** Directly labelled treemap cell with the same click-to-filter behavior as the donut. */
function TreemapTile({
  x = 0, y = 0, width = 0, height = 0, depth = 0, index = 0,
  data, selected, onSelect,
}: TreemapTileProps) {
  const entry = data[index];
  if (depth !== 1 || !entry || width < 2 || height < 2) return null;

  const isSelected = selected === entry.name;
  const dimmed = selected !== null && !isSelected;
  const labelLength = Math.max(4, Math.floor((width - 18) / 7));
  const label = entry.name.length > labelLength
    ? `${entry.name.slice(0, Math.max(1, labelLength - 1))}…`
    : entry.name;

  return (
    <g
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={`${entry.name}: ${exact(entry.total)}, ${entry.share.toFixed(1)}%`}
      aria-pressed={isSelected}
      onClick={() => onSelect?.(entry.name)}
      onKeyDown={(event) => {
        if (!onSelect || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        onSelect(entry.name);
      }}
      style={{ cursor: onSelect ? 'pointer' : 'default', opacity: dimmed ? 0.32 : 1 }}
    >
      <rect
        x={x + 1}
        y={y + 1}
        width={Math.max(0, width - 2)}
        height={Math.max(0, height - 2)}
        rx={8}
        fill={entry.fill}
        stroke={isSelected ? '#d9fff1' : '#030712'}
        strokeWidth={isSelected ? 2 : 1}
      />
      {width >= 58 && height >= 34 && (
        <text x={x + 10} y={y + 18} fill="#f8fafc" fontSize={10.5} fontWeight={600}>
          {label}
        </text>
      )}
      {width >= 72 && height >= 58 && (
        <>
          <text x={x + 10} y={y + 38} fill="#f8fafc" fontSize={13} fontWeight={700}>
            {compact(entry.total)}
          </text>
          <text x={x + 10} y={y + 53} fill="#a5c8bb" fontSize={9.5}>
            {entry.share.toFixed(0)}% of total
          </text>
        </>
      )}
    </g>
  );
}

function BubbleBreakdown({
  data, selected, onSelect,
}: {
  data: CompositionDatum[];
  selected: string | null;
  onSelect: ((value: string) => void) | null;
}) {
  const visible = data.slice(0, 8);
  const largest = Math.max(...visible.map((entry) => entry.total), 1);
  return (
    <div className="mt-3 flex h-[174px] flex-wrap content-center items-center justify-center gap-2 overflow-hidden">
      {visible.map((entry) => {
        const size = 48 + Math.sqrt(Math.max(0, entry.total) / largest) * 52;
        const isSelected = selected === entry.name;
        return (
          <button
            key={entry.name}
            type="button"
            disabled={onSelect === null}
            onClick={() => onSelect?.(entry.name)}
            aria-pressed={isSelected}
            className={`grid shrink-0 place-items-center rounded-full border text-center transition-colors ${
              isSelected ? 'border-white' : 'border-black/30 hover:border-emerald-200/70'
            } ${selected !== null && !isSelected ? 'opacity-30' : ''}`}
            style={{ width: size, height: size, background: entry.fill }}
          >
            <span className="max-w-[82%] truncate text-[9.5px] font-semibold text-white">{entry.name}</span>
            {size > 74 && <span className="-mt-3 text-[10px] font-bold text-white">{compact(entry.total)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function RadialBreakdown({
  data, selected, onSelect,
}: {
  data: CompositionDatum[];
  selected: string | null;
  onSelect: ((value: string) => void) | null;
}) {
  const visible = data.slice(0, 6).map((entry) => ({
    ...entry,
    fill: selected !== null && selected !== entry.name ? '#18312c' : entry.fill,
  }));
  const maximum = Math.max(...visible.map((entry) => entry.total), 1);
  return (
    <div className="mt-3 grid h-[174px] grid-cols-[1.05fr_0.95fr] items-center gap-2">
      <ResponsiveContainer
        width="100%" height="100%" minWidth={0}
        initialDimension={{ width: 180, height: 174 }}
      >
        <RadialBarChart
          data={visible}
          innerRadius="18%"
          outerRadius="94%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, maximum]} tick={false} />
          <RadialBar dataKey="total" background={{ fill: 'rgba(255,255,255,0.04)' }} cornerRadius={6} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="space-y-1">
        {visible.map((entry) => (
          <button
            key={entry.name}
            type="button"
            onClick={() => onSelect?.(entry.name)}
            className="grid w-full grid-cols-[0.45rem_minmax(0,1fr)_auto] items-center gap-2 rounded px-1 py-0.5 text-left text-[9.5px] text-gray-400 hover:text-white"
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: entry.fill }} />
            <span className="truncate">{entry.name}</span>
            <span className="tabular-nums">{entry.share.toFixed(0)}%</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function WaffleBreakdown({ data }: { data: CompositionDatum[] }) {
  const positive = data.filter((entry) => entry.share > 0);
  const cells = Array.from({ length: 100 }, (_, index) => {
    const percentage = index + 0.5;
    let running = 0;
    return positive.find((entry) => {
      running += entry.share;
      return percentage <= running;
    });
  });
  return (
    <div className="mt-3 grid h-[174px] grid-cols-[132px_minmax(0,1fr)] items-center gap-4">
      <div className="grid grid-cols-10 gap-[3px]" aria-label="100 square share chart">
        {cells.map((entry, index) => (
          <span
            key={index}
            className="aspect-square rounded-[2px]"
            style={{ background: entry?.fill ?? 'rgba(255,255,255,0.04)' }}
            title={entry ? `${entry.name}: ${entry.share.toFixed(1)}%` : undefined}
          />
        ))}
      </div>
      <div className="space-y-1.5 min-w-0">
        {data.slice(0, 6).map((entry) => (
          <div key={entry.name} className="grid grid-cols-[0.45rem_minmax(0,1fr)_auto] items-center gap-2 text-[10px]">
            <span className="h-1.5 w-1.5 rounded-sm" style={{ background: entry.fill }} />
            <span className="truncate text-gray-400">{entry.name}</span>
            <span className="font-semibold text-white tabular-nums">{entry.share.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function GeographicBreakdown({
  data, selected, onSelect,
}: {
  data: CompositionDatum[];
  selected: string | null;
  onSelect: ((value: string) => void) | null;
}) {
  const points = data.flatMap((entry) => {
    const point = geoPointFor(entry.name);
    return point ? [{ ...entry, ...point }] : [];
  });
  const largest = Math.max(...points.map((entry) => entry.total), 1);
  const project = (latitude: number, longitude: number) => ({
    x: 20 + ((longitude - 67) / 30) * 170,
    y: 162 - ((latitude - 7) / 29) * 140,
  });

  return (
    <div className="mt-3 grid h-[174px] grid-cols-[1.2fr_0.8fr] items-center gap-2 overflow-hidden rounded-xl border border-emerald-950/80 bg-emerald-950/10 pr-2">
      <svg viewBox="0 0 210 180" className="h-full w-full" role="img" aria-label="Geographic value map">
        <path
          d="M48 30 L84 21 L112 29 L124 45 L136 55 L157 55 L174 65 L150 73 L130 70 L116 89 L106 111 L96 143 L85 166 L76 143 L71 113 L58 95 L43 73 L36 49 Z"
          fill="rgba(53,224,161,0.045)"
          stroke="rgba(53,224,161,0.18)"
          strokeWidth="1.5"
        />
        {points.map((entry, index) => {
          const point = project(entry.latitude, entry.longitude);
          const radius = 5 + Math.sqrt(Math.max(0, entry.total) / largest) * 8;
          const isSelected = selected === entry.name;
          return (
            <g
              key={entry.name}
              role={onSelect ? 'button' : undefined}
              tabIndex={onSelect ? 0 : undefined}
              aria-label={`${entry.name}: ${exact(entry.total)}`}
              aria-pressed={isSelected}
              onClick={() => onSelect?.(entry.name)}
              onKeyDown={(event) => {
                if (!onSelect || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                onSelect(entry.name);
              }}
              style={{ cursor: onSelect ? 'pointer' : 'default', opacity: selected && !isSelected ? 0.3 : 1 }}
            >
              <circle cx={point.x} cy={point.y} r={radius + 3} fill="rgba(53,224,161,0.12)" />
              <circle
                cx={point.x}
                cy={point.y}
                r={radius}
                fill={entry.fill}
                stroke={isSelected ? '#fff' : '#042f2e'}
                strokeWidth={isSelected ? 2 : 1}
              />
              <text x={point.x} y={point.y + 3} textAnchor="middle" fill="#fff" fontSize="8" fontWeight="700">
                {index + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="space-y-1 min-w-0">
        {points.slice(0, 6).map((entry, index) => (
          <button
            key={entry.name}
            type="button"
            onClick={() => onSelect?.(entry.name)}
            className={`grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-1.5 rounded px-1 py-0.5 text-left text-[9px] hover:bg-white/[0.03] ${
              selected && selected !== entry.name ? 'opacity-30' : ''
            }`}
          >
            <span className="grid h-4 w-4 place-items-center rounded-full text-[8px] font-bold text-white" style={{ background: entry.fill }}>
              {index + 1}
            </span>
            <span className="truncate text-gray-300">{entry.name}</span>
            <span className="font-semibold text-white tabular-nums">{compact(entry.total)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A part-to-whole view that adapts to the data instead of forcing every
 * category set into bars: donut for a few values, treemap for a medium set,
 * and a compact table when geometry would become crowded or misleading.
 */
const AdaptiveBreakdown = React.memo(function AdaptiveBreakdown({
  result, measureName, role, selected, onSelect, onClear,
}: {
  result: QueryResult | null;
  measureName: string;
  role: Column['semantic_role'];
  selected: string | null;
  onSelect: ((value: string) => void) | null;
  onClear: (() => void) | null;
}) {
  const [mode, setMode] = useState<BreakdownMode>('auto');
  const data = useMemo(() => {
    if (!result) return [];
    const values = result.rows.map((row) => ({
      name: textAt(row, 'name') || 'Not set',
      total: numberAt(row, 'total') ?? 0,
    }));
    const sum = values.reduce((total, entry) => total + entry.total, 0);
    return values.map((entry, index) => ({
      ...entry,
      share: sum > 0 ? (entry.total / sum) * 100 : 0,
      fill: COMPOSITION_FILL[index % COMPOSITION_FILL.length],
    }));
  }, [result]);

  if (data.length === 0) return <Empty>No breakdown available.</Empty>;

  const leader = data[0];
  const modes = availableBreakdownModes(role, data.map((entry) => entry.name));
  const selectedMode = modes.includes(mode) ? mode : 'auto';
  const automatic = selectBreakdownView(data.map((entry) => entry.total));
  const view = selectedMode === 'auto' ? automatic : selectedMode;

  return (
    <>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[9px] uppercase tracking-[0.14em] text-gray-600">View</span>
        <select
          value={selectedMode}
          onChange={(event) => setMode(event.target.value as BreakdownMode)}
          aria-label="Chart view"
          className="rounded-lg border border-gray-800 bg-zinc-950 px-2 py-1 text-[10.5px] text-gray-300 outline-none hover:border-emerald-700 focus:border-emerald-500"
        >
          {modes.map((entry) => (
            <option key={entry} value={entry}>{BREAKDOWN_MODE_LABELS[entry]}</option>
          ))}
        </select>
      </div>

      {view === 'donut' && (
        <div className="grid grid-cols-[minmax(116px,0.9fr)_1.1fr] items-center gap-2 h-[174px] mt-2">
          <ResponsiveContainer
            width="100%" height="100%" minWidth={0}
            initialDimension={{ width: 150, height: 174 }}
          >
            <PieChart>
              <Pie
                data={data}
                dataKey="total"
                nameKey="name"
                innerRadius="48%"
                outerRadius="78%"
                paddingAngle={2}
                stroke="#030712"
                strokeWidth={2}
                isAnimationActive={false}
              >
                {data.map((entry) => {
                  const isSelected = selected === entry.name;
                  return (
                    <Cell
                      key={entry.name}
                      fill={entry.fill}
                      fillOpacity={selected !== null && !isSelected ? 0.28 : 1}
                      onClick={() => onSelect?.(entry.name)}
                      style={{ cursor: onSelect ? 'pointer' : 'default' }}
                    />
                  );
                })}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'rgba(9,9,11,0.96)', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 10, fontSize: 11,
                }}
                formatter={(value) => [exact(Number(value)), measureName]}
              />
            </PieChart>
          </ResponsiveContainer>
          <div className="space-y-1 min-w-0">
            {data.map((entry) => {
              const isSelected = selected === entry.name;
              return (
                <button
                  key={entry.name}
                  type="button"
                  disabled={onSelect === null}
                  aria-pressed={isSelected}
                  onClick={() => onSelect?.(entry.name)}
                  className={`w-full grid grid-cols-[0.45rem_minmax(0,1fr)_auto] items-center gap-2 px-1.5 py-1 rounded-md text-left transition-colors ${
                    isSelected ? 'bg-emerald-500/12 text-white' : 'text-gray-400 hover:text-white'
                  } ${selected !== null && !isSelected ? 'opacity-40' : ''}`}
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: entry.fill }} aria-hidden />
                  <span className="truncate text-[10.5px]">{entry.name}</span>
                  <span className="text-[10px] tabular-nums">{entry.share.toFixed(0)}%</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {view === 'treemap' && (
        <div className="h-[174px] mt-3">
          <ResponsiveContainer
            width="100%" height="100%" minWidth={0}
            initialDimension={{ width: 300, height: 174 }}
          >
            <Treemap
              data={data}
              dataKey="total"
              nameKey="name"
              aspectRatio={1.35}
              isAnimationActive={false}
              content={<TreemapTile data={data} selected={selected} onSelect={onSelect} />}
            />
          </ResponsiveContainer>
        </div>
      )}

      {view === 'map' && (
        <GeographicBreakdown data={data} selected={selected} onSelect={onSelect} />
      )}

      {view === 'bubble' && (
        <BubbleBreakdown data={data} selected={selected} onSelect={onSelect} />
      )}

      {view === 'radial' && (
        <RadialBreakdown data={data} selected={selected} onSelect={onSelect} />
      )}

      {view === 'waffle' && <WaffleBreakdown data={data} />}

      {view === 'kpi' && (
        <div className="mt-3 grid h-[174px] place-items-center rounded-xl border border-emerald-900/40 bg-emerald-500/[0.04] text-center">
          <div>
            <p className="text-[10px] uppercase tracking-[0.16em] text-emerald-400/70">Leading value</p>
            <p className="mt-2 text-3xl font-bold tracking-tight text-white tabular-nums">{compact(leader.total)}</p>
            <p className="mt-1 text-[11px] font-semibold text-emerald-300">{leader.name}</p>
            <p className="mt-2 text-[10px] text-gray-500">
              {leader.share.toFixed(1)}% of {data.length} categories
            </p>
          </div>
        </div>
      )}

      {view === 'table' && (
        <div className="mt-3 divide-y divide-white/5">
          {data.slice(0, 6).map((entry, index) => {
            const isSelected = selected === entry.name;
            const shareIsMeaningful = data.every((item) => item.total >= 0)
              && data.some((item) => item.total > 0);
            return (
              <button
                key={entry.name}
                type="button"
                disabled={onSelect === null}
                aria-pressed={isSelected}
                onClick={() => onSelect?.(entry.name)}
                className={`w-full grid grid-cols-[1.4rem_minmax(0,1fr)_auto_auto] items-center gap-2 py-2 text-left transition-colors ${
                  isSelected ? 'text-emerald-300' : 'text-gray-400 hover:text-white'
                } ${selected !== null && !isSelected ? 'opacity-40' : ''}`}
              >
                <span className="text-[9px] text-gray-600 tabular-nums">{index + 1}</span>
                <span className="truncate text-[10.5px]">{entry.name}</span>
                <span className="text-[10.5px] text-white tabular-nums">{compact(entry.total)}</span>
                <span className="w-8 text-right text-[9.5px] text-gray-600 tabular-nums">
                  {shareIsMeaningful ? `${entry.share.toFixed(0)}%` : '—'}
                </span>
              </button>
            );
          })}
          {data.length > 6 && (
            <p className="pt-2 text-[9.5px] text-gray-600">Top 6 of {data.length} categories</p>
          )}
        </div>
      )}

      <p className="flex items-center gap-1.5 text-[10.5px] text-gray-500 mt-2.5 pt-2.5 border-t border-gray-800">
        <Activity className="h-3 w-3 text-emerald-400 shrink-0" />
        <span className="text-white font-bold text-[13px]">
          {leader.share > 0 ? `${leader.share.toFixed(0)}%` : compact(leader.total)}
        </span>
        sits in {leader.name}
        {selected && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-emerald-800/60 px-2 py-1 text-[9.5px] font-semibold text-emerald-300 hover:bg-emerald-500/10"
          >
            <X className="h-3 w-3" /> Clear selection
          </button>
        )}
      </p>
    </>
  );
});

/** Ranked records with exact values; lower dashboard rows deliberately avoid bars. */
const RecordsTable = React.memo(function RecordsTable({
  result, attributes, measureName, selected, onSelect, onHover,
}: {
  result: QueryResult;
  attributes: string[];
  measureName: string;
  selected: string | null;
  onSelect: (value: string) => void;
  onHover: (value: string) => void;
}) {
  const top = Math.max(...result.rows.map((row) => numberAt(row, 'total') ?? 0), 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full mt-3">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left text-[9.5px] uppercase tracking-wider text-gray-500 font-medium py-2 px-2">
              Name
            </th>
            {attributes.map((header) => (
              <th key={header} className="text-left text-[9.5px] uppercase tracking-wider text-gray-500 font-medium py-2 px-2">
                {header}
              </th>
            ))}
            <th className="text-right text-[9.5px] uppercase tracking-wider text-gray-500 font-medium py-2 px-2">
              {measureName}
            </th>
            <th className="text-right text-[9.5px] uppercase tracking-wider text-gray-500 font-medium py-2 px-2">
              vs top
            </th>
            <th className="text-right text-[9.5px] uppercase tracking-wider text-gray-500 font-medium py-2 px-2">
              Records
            </th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, index) => {
            const value = numberAt(row, 'total') ?? 0;
            const name = textAt(row, 'name');
            const isSelected = selected === name;
            return (
              <tr
                key={name}
                onClick={() => onSelect(name)}
                onMouseEnter={() => onHover(name)}
                className={`border-b border-white/5 last:border-0 cursor-pointer transition-colors ${
                  isSelected ? 'bg-emerald-500/10' : 'hover:bg-white/[0.02]'
                } ${selected !== null && !isSelected ? 'opacity-45' : ''}`}
              >
                <td className="py-2.5 px-2 whitespace-nowrap">
                  <span className="flex items-center gap-2.5">
                    <span
                      className={`h-6 w-6 rounded-full grid place-items-center text-[9px] font-bold shrink-0 ${
                        index === 0 ? 'bg-emerald-400 text-emerald-950' : 'bg-zinc-800 text-gray-400'
                      }`}
                    >
                      {initials(name)}
                    </span>
                    <span className="text-[11.5px] text-white">{name}</span>
                  </span>
                </td>
                {attributes.map((_, i) => (
                  <td key={i} className="py-2.5 px-2 text-[11.5px] text-gray-400 whitespace-nowrap">
                    {textAt(row, `attr${i}`)}
                  </td>
                ))}
                <td className="py-2.5 px-2 text-[11.5px] text-white text-right tabular-nums">
                  {exact(value)}
                </td>
                <td className="py-2.5 px-2 text-[10.5px] text-gray-500 text-right tabular-nums">
                  {top > 0 ? `${((value / top) * 100).toFixed(0)}%` : '—'}
                </td>
                <td className="py-2.5 px-2 text-[11.5px] text-gray-400 text-right tabular-nums">
                  {count(numberAt(row, 'rows'))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
