'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Funnel, FunnelChart, LabelList, Pie, PieChart, PolarAngleAxis, PolarGrid,
  PolarRadiusAxis, Radar, RadarChart, RadialBar, RadialBarChart, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, Treemap, XAxis, YAxis,
} from 'recharts';
import {
  Loader2, Plus, RefreshCw, Save, Settings2, Trash2, TriangleAlert,
} from 'lucide-react';

import { api } from '../lib/api';
import { CUSTOM_CHART_OPTIONS } from '../lib/dashboard-widgets';
import type { CustomChartType } from '../lib/dashboard-widgets';
import { compact, count, exact } from '../lib/format';
import type {
  Aggregation, AnalysisSuggestion, ModelFieldGroup,
  QueryResult, QuerySpec, SemanticModel,
} from '../lib/types';

const PALETTE = [
  '#06b6d4', '#10b981', '#8b5cf6', '#f59e0b',
  '#ec4899', '#6366f1', '#ef4444', '#14b8a6',
];

const TOOLTIP_STYLE: React.CSSProperties = {
  background: '#18181b',
  border: '1px solid #3f3f46',
  borderRadius: 10,
  fontSize: 11,
};

const AGGREGATIONS: Aggregation[] = [
  'sum', 'avg', 'median', 'min', 'max', 'count', 'count_distinct',
];

const DATE_PARTS = [
  'year', 'quarter', 'month', 'month_name', 'week', 'day', 'day_of_week',
];

const NUMERIC = new Set([
  'integer', 'decimal', 'currency', 'percentage',
]);

function tooltipNumber(value: unknown): string {
  return typeof value === 'number' ? exact(value) : String(value ?? '—');
}

function axisNumber(value: unknown): string {
  return typeof value === 'number' ? compact(value) : String(value ?? '');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed.';
}

interface Widget {
  id: string;
  title: string;
  chart: CustomChartType;
  dimension: {
    table_id: number;
    column: string;
    date_part?: string;
  } | null;
  measure: {
    table_id: number;
    column: string | null;
    aggregation: Aggregation;
  };
  limit: number;
  base_table_id?: number;
}

interface DashboardBuilderProps {
  projectId: number;
  model: SemanticModel;
}

type Outcome = QueryResult | { error: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Validate saved structure without dropping extra properties or old IDs. */
function isWidget(value: unknown): value is Widget {
  if (!record(value) || !record(value.measure)) return false;

  const dimension = value.dimension;

  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.title === 'string' &&
    CUSTOM_CHART_OPTIONS.some((option) => option.value === value.chart) &&
    positive(value.measure.table_id) &&
    (value.measure.column === null ||
      typeof value.measure.column === 'string') &&
    AGGREGATIONS.includes(value.measure.aggregation as Aggregation) &&
    positive(value.limit) &&
    (value.base_table_id === undefined || positive(value.base_table_id)) &&
    (
      dimension === null ||
      (
        record(dimension) &&
        positive(dimension.table_id) &&
        typeof dimension.column === 'string' &&
        (
          dimension.date_part == null ||
          DATE_PARTS.includes(String(dimension.date_part))
        )
      )
    )
  );
}

function specFor(widget: Widget): QuerySpec {
  // A KPI requests one aggregate from the backend.
  // It never sums grouped averages, medians, or distinct counts.
  const dimension = widget.chart === 'kpi' ? null : widget.dimension;
  const ordered = widget.chart === 'line' || widget.chart === 'area';

  return {
    base_table_id: widget.base_table_id ?? widget.measure.table_id,
    dimensions: dimension ? [{ ...dimension, label: 'group' }] : [],
    measures: [{ ...widget.measure, label: 'value' }],
    order_by: dimension
      ? {
          field: ordered ? 'group' : 'value',
          direction: ordered ? 'asc' : 'desc',
        }
      : undefined,
    limit: widget.limit,
  };
}

function fromSuggestion(item: AnalysisSuggestion): Widget | null {
  const measures = item.spec.measures ?? [];
  const dimensions = item.spec.dimensions ?? [];

  if (
    measures.length !== 1 ||
    dimensions.length > 1 ||
    item.spec.filters?.length ||
    !CUSTOM_CHART_OPTIONS.some((option) => option.value === item.chart)
  ) {
    return null;
  }

  const measure = measures[0];
  const dimension = dimensions[0];

  return {
    id: `custom-${crypto.randomUUID()}`,
    title: item.title,
    chart: item.chart as CustomChartType,
    base_table_id: item.spec.base_table_id ?? measure.table_id,
    dimension: dimension
      ? {
          table_id: dimension.table_id,
          column: dimension.column,
          date_part: dimension.date_part ?? undefined,
        }
      : null,
    measure: {
      table_id: measure.table_id,
      column: measure.column ?? null,
      aggregation: measure.aggregation,
    },
    limit: item.spec.limit ?? 50,
  };
}

export default function DashboardBuilder(props: DashboardBuilderProps) {
  return <Builder key={props.projectId} {...props} />;
}

function Builder({ projectId, model }: DashboardBuilderProps) {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [layouts, setLayouts] = useState<Record<string, unknown>>({});
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('[]');
  const [notice, setNotice] = useState<string | null>(null);

  const saveLock = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dirty = JSON.stringify(widgets) !== saved;
  const suggestions = model.dashboard_plan?.widgets ?? model.suggestions;

  const fieldsByTable = useMemo(
    () => new Map(model.fields.map((group) => [group.table_id, group])),
    [model.fields],
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoaded(false);
      setLoadError(null);

      try {
        const response = await api.getDashboard(projectId);

        if (
          !Array.isArray(response.widgets) ||
          !response.widgets.every(isWidget) ||
          !record(response.layouts)
        ) {
          throw new Error(
            'Saved dashboard has an unsupported format. It has been preserved; saving is disabled until its format is repaired.',
          );
        }

        if (
          new Set(response.widgets.map((widget) => widget.id)).size !==
          response.widgets.length
        ) {
          throw new Error(
            'Saved dashboard contains duplicate chart IDs. It has been preserved; saving is disabled.',
          );
        }

        if (cancelled) return;

        setWidgets(response.widgets);
        setLayouts(response.layouts);
        setSaved(JSON.stringify(response.widgets));
        setLoaded(true);
      } catch (error) {
        if (!cancelled) setLoadError(message(error));
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [projectId, loadRevision]);

  // Cosmetic edits do not rerun queries.
  const queryRequests = JSON.stringify(
    widgets.map((widget) => ({
      id: widget.id,
      spec: specFor(widget),
    })),
  );

  useEffect(() => {
    if (!loaded) return;

    let cancelled = false;
    let cursor = 0;

    const requests = JSON.parse(queryRequests) as {
      id: string;
      spec: QuerySpec;
    }[];

    const next: Record<string, Outcome> = {};

    async function worker() {
      while (!cancelled && cursor < requests.length) {
        const request = requests[cursor++];

        try {
          const result = await api.query(projectId, request.spec);
          if (!cancelled) next[request.id] = result;
        } catch (error) {
          if (!cancelled) {
            next[request.id] = { error: message(error) };
          }
        }

        if (!cancelled) setResults({ ...next });
      }
    }

    async function run() {
      setResults({});

      await Promise.all(
        Array.from(
          { length: Math.min(3, requests.length) },
          () => worker(),
        ),
      );
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [loaded, projectId, queryRequests, model, refresh]);

  function add(widget?: Widget | null) {
    const table =
      model.tables.find((item) => item.kind === 'fact') ??
      model.tables[0];

    if (!widget && !table) return;

    const next: Widget = widget ?? {
      id: `custom-${crypto.randomUUID()}`,
      title: `${table!.table_name} rows`,
      chart: 'kpi',
      dimension: null,
      measure: {
        table_id: table!.id,
        column: null,
        aggregation: 'count',
      },
      limit: 50,
    };

    setWidgets((current) => [...current, next]);
    setEditing(next.id);
    setNotice(null);
  }

  function update(id: string, patch: Partial<Widget>) {
    setWidgets((current) =>
      current.map((widget) =>
        widget.id === id ? { ...widget, ...patch } : widget,
      ),
    );
    setNotice(null);
  }

  async function save() {
    if (!loaded || saveLock.current) return;

    saveLock.current = true;
    setSaving(true);
    setNotice(null);

    const snapshot = JSON.stringify(widgets);

    try {
      await api.saveDashboard(projectId, widgets, layouts);

      if (mounted.current) {
        setSaved(snapshot);
        setNotice('Dashboard saved.');
      }
    } catch (error) {
      if (mounted.current) setNotice(message(error));
    } finally {
      saveLock.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div className="space-y-2">
        <Warning>{loadError}</Warning>
        <button
          type="button"
          onClick={() => setLoadRevision((value) => value + 1)}
          className="text-xs text-emerald-300"
        >
          Retry loading saved dashboard
        </button>
      </div>
    );
  }

  if (!loaded) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 p-8 text-xs text-gray-400"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading saved charts…
      </p>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-gray-800 bg-zinc-900/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-white">Your graphs</h2>
          <p className="mt-1 text-xs text-gray-400">
            {dirty
              ? 'Unsaved changes. Save before switching projects.'
              : 'Your saved workspace.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!model.tables.length}
            onClick={() => add()}
            className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-xs text-white disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add chart
          </button>

          <button
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
            className="flex items-center gap-1 p-2 text-xs text-gray-300"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>

          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="flex items-center gap-1 rounded-lg border border-gray-700 px-3 py-2 text-xs text-gray-300 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save graphs
          </button>
        </div>
      </div>

      {notice && (
        <p role="status" className="text-xs text-gray-300">
          {notice}
        </p>
      )}

      {suggestions.length > 0 && (
        <label className="block text-xs text-gray-400">
          Start from a suggested analysis
          <select
            value=""
            onChange={(event) => {
              const item = suggestions.find(
                (entry) => entry.id === event.target.value,
              );

              if (item) {
                const widget = fromSuggestion(item);
                if (widget) add(widget);
              }
            }}
            className="ml-2 rounded-lg border border-gray-700 bg-zinc-900 p-2 text-gray-200"
          >
            <option value="">Choose a suggestion…</option>
            {suggestions
              .filter(
                (item) =>
                  (item.spec.measures?.length ?? 0) === 1 &&
                  (item.spec.dimensions?.length ?? 0) <= 1 &&
                  !item.spec.filters?.length &&
                  CUSTOM_CHART_OPTIONS.some(
                    (option) => option.value === item.chart,
                  ),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
          </select>
        </label>
      )}

      {widgets.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-700 p-6 text-center text-xs text-gray-400">
          No custom graphs. Add a chart or copy a suggestion.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {widgets.map((widget) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              result={results[widget.id]}
              fields={model.fields}
              editing={editing === widget.id}
              onToggleEdit={() =>
                setEditing((current) =>
                  current === widget.id ? null : widget.id,
                )
              }
              onChange={(patch) => update(widget.id, patch)}
              onRemove={() => {
                setWidgets((current) =>
                  current.filter((entry) => entry.id !== widget.id),
                );
                setEditing(null);
                setNotice(null);
              }}
              column={fieldsByTable
                .get(widget.measure.table_id)
                ?.columns.find(
                  (column) => column.name === widget.measure.column,
                )}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/20 p-2 text-xs text-amber-300">
      <TriangleAlert className="h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function WidgetCard({
  widget, result, fields, editing,
  onToggleEdit, onChange, onRemove, column,
}: {
  widget: Widget;
  result?: Outcome;
  fields: ModelFieldGroup[];
  editing: boolean;
  onToggleEdit: () => void;
  onChange: (patch: Partial<Widget>) => void;
  onRemove: () => void;
  column?: ModelFieldGroup['columns'][number];
}) {
  const data = result && !('error' in result) ? result : null;
  const dimension = data?.fields.find(
    (field) => field.kind === 'dimension',
  )?.key;

  const rows = data?.rows.map((row) => ({
    name: dimension
      ? String(row[dimension] ?? '(Missing or unmatched)')
      : 'Total',
    value:
      typeof row.value === 'number' && Number.isFinite(row.value)
        ? row.value
        : null,
  })) ?? [];

  const composition =
    widget.chart === 'pie' || widget.chart === 'treemap';

  const additive =
    widget.measure.aggregation === 'count' ||
    (
      widget.measure.aggregation === 'sum' &&
      column?.additivity === 'additive'
    );

  const unsafeComposition =
    composition &&
    (
      !additive ||
      rows.some((row) => row.value == null || row.value < 0) ||
      !rows.some((row) => (row.value ?? 0) > 0)
    );

  const unsafeShape =
    ['radar', 'radial', 'funnel'].includes(widget.chart) &&
    rows.some((row) => row.value == null || row.value < 0);

  const textResult = data?.rows.some(
    (row) => row.value != null && typeof row.value !== 'number',
  );

  const caps: Partial<Record<CustomChartType, number>> = {
    radar: 12,
    radial: 8,
    treemap: 20,
    funnel: 10,
    horizontal_bar: 15,
  };

  const cap = caps[widget.chart];

  const dimensionColumn = fields
    .find((group) => group.table_id === widget.dimension?.table_id)
    ?.columns.find((entry) => entry.name === widget.dimension?.column);

  return (
    <div className="min-w-0 rounded-xl border border-gray-800 bg-zinc-900/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          {editing ? (
            <input
              aria-label="Chart title"
              value={widget.title}
              onChange={(event) => onChange({ title: event.target.value })}
              className="w-full border-b border-emerald-700 bg-transparent text-sm text-white"
            />
          ) : (
            <h3 className="text-sm font-semibold text-white">
              {widget.title}
            </h3>
          )}

          {data && (
            <p className="mt-1 text-xs text-gray-500">
              {data.base_table_name}
              {data.joined_tables.length
                ? ` + ${data.joined_tables.join(', ')}`
                : ''}
              {' · '}{count(data.row_count)} result rows
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            aria-label={`Edit ${widget.title}`}
            onClick={onToggleEdit}
            className="text-gray-400"
          >
            <Settings2 className="h-4 w-4" />
          </button>

          <button
            type="button"
            aria-label={`Remove ${widget.title}`}
            onClick={onRemove}
            className="text-gray-400 hover:text-red-400"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {editing && (
        <WidgetEditor
          widget={widget}
          fields={fields}
          onChange={onChange}
        />
      )}

      <div className="mb-3 space-y-2">
        {data?.warnings.map((warning, index) => (
          <Warning key={index}>{warning}</Warning>
        ))}

        {data?.truncated && (
          <Warning>
            Partial result: the query limit was reached.
            Increase the limit to include more groups.
          </Warning>
        )}

        {unsafeShape && (
          <Warning>
            This chart needs non-negative numeric values.
            Showing the table instead.
          </Warning>
        )}

        {widget.chart === 'pie' && data?.truncated && (
          <Warning>
            Shares describe returned groups only, not the full dataset.
          </Warning>
        )}

        {unsafeComposition && (
          <Warning>
            A composition chart needs non-negative additive values.
            Showing the table instead.
          </Warning>
        )}

        {cap && rows.length > cap && !unsafeComposition && !unsafeShape && (
          <Warning>
            This chart displays the first {cap} of {rows.length} returned
            groups. Choose Table to see all returned groups.
          </Warning>
        )}

        {widget.chart === 'funnel' && (
          <Warning>
            This compares grouped values; stage order and conversion rates
            are not established by the data model.
          </Warning>
        )}

        {widget.chart === 'scatter' && (
          <Warning>
            This shows values by category, not a relationship between
            two numeric variables.
          </Warning>
        )}

        {(widget.chart === 'line' || widget.chart === 'area') &&
          widget.dimension &&
          !['date', 'datetime'].includes(
            dimensionColumn?.logical_type ?? '',
          ) && (
            <Warning>
              The horizontal axis uses group order. This is a time trend
              only if the selected field represents time.
            </Warning>
          )}
      </div>

      <div className="h-64 min-w-0">
        {result && 'error' in result ? (
          <Warning>
            {result.error} Edit the chart or use Refresh to retry.
          </Warning>
        ) : !data ? (
          <p role="status" className="text-xs text-gray-400">
            Loading chart…
          </p>
        ) : !rows.length ? (
          <p className="text-xs text-gray-400">No matching data.</p>
        ) : textResult ? (
          <div className="h-full overflow-auto">
            <table className="w-full text-left text-xs text-gray-300">
              <tbody>
                {data.rows.map((row, index) => (
                  <tr key={index}>
                    {data.fields.map((field) => (
                      <td
                        key={field.key}
                        className="border-b border-gray-800 p-2"
                      >
                        {String(row[field.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ChartBody
            widget={
              unsafeComposition || unsafeShape
                ? { ...widget, chart: 'table' }
                : widget
            }
            rows={rows}
          />
        )}
      </div>

      {data && (
        <details className="mt-3 text-xs text-gray-500">
          <summary className="cursor-pointer">Show query</summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words p-2">
            {data.sql}
          </pre>
        </details>
      )}
    </div>
  );
}

function ChartBody({
  widget,
  rows,
}: {
  widget: Widget;
  rows: { name: string; value: number | null }[];
}) {
  const axis = {
    stroke: '#374151',
    tickLine: false as const,
    axisLine: false as const,
  };

  const tick = { fontSize: 9, fill: '#6b7280' };

  if (widget.chart === 'kpi') {
    const total = rows[0]?.value ?? null;

    return (
      <div className="h-full flex flex-col items-center justify-center">
        <span className="text-4xl font-extrabold font-mono text-white">
          {total == null ? '—' : compact(total)}
        </span>
        <span className="text-[10px] text-gray-500 uppercase tracking-wider mt-2">
          {widget.measure.aggregation.replace('_', ' ')} of{' '}
          {widget.measure.column ?? 'rows'}
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
              <th className="px-3 py-2 text-gray-400 font-semibold">
                Group
              </th>
              <th className="px-3 py-2 text-gray-400 font-semibold text-right">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name} className="border-b border-gray-800/30">
                <td className="px-3 py-1.5 text-gray-300 truncate max-w-[200px]">
                  {row.name}
                </td>
                <td className="px-3 py-1.5 text-gray-200 text-right font-mono">
                  {row.value == null ? '—' : exact(row.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (widget.chart === 'pie') {
    const total = rows.reduce(
      (sum, row) => sum + (row.value ?? 0),
      0,
    );

    return (
      <ResponsiveContainer
        width="99%"
        height="100%"
        initialDimension={{ width: 500, height: 220 }}
      >
        <PieChart>
          <Pie
            data={rows}
            dataKey="value"
            nameKey="name"
            innerRadius="50%"
            outerRadius="78%"
            paddingAngle={2}
            strokeWidth={0}
          >
            {rows.map((row, index) => (
              <Cell
                key={row.name}
                fill={PALETTE[index % PALETTE.length]}
              />
            ))}
          </Pie>

          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={(value: unknown, name: unknown) => {
              const amount = typeof value === 'number' ? value : 0;
              const share = total
                ? ((amount / total) * 100).toFixed(1)
                : '0';

              return [
                `${exact(amount)} (${share}%)`,
                String(name ?? ''),
              ];
            }}
          />

          <Legend
            iconSize={8}
            iconType="circle"
            wrapperStyle={{ fontSize: 10, color: '#9ca3af' }}
          />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (widget.chart === 'radar') {
    return (
      <ResponsiveContainer
        width="99%"
        height="100%"
        initialDimension={{ width: 500, height: 220 }}
      >
        <RadarChart data={rows.slice(0, 12)} outerRadius="72%">
          <PolarGrid stroke="rgba(255,255,255,0.08)" />
          <PolarAngleAxis
            dataKey="name"
            tick={{ fontSize: 9, fill: '#9ca3af' }}
          />
          <PolarRadiusAxis tick={false} axisLine={false} />
          <Radar
            dataKey="value"
            stroke="#35e0a1"
            fill="#35e0a1"
            fillOpacity={0.3}
            strokeWidth={2}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={tooltipNumber}
          />
        </RadarChart>
      </ResponsiveContainer>
    );
  }

  if (widget.chart === 'radial') {
    const maximum = Math.max(
      ...rows.map((row) => row.value ?? 0),
      1,
    );

    const radialRows = rows.slice(0, 8).map((row, index) => ({
      ...row,
      fill: PALETTE[index % PALETTE.length],
    }));

    return (
      <ResponsiveContainer
        width="99%"
        height="100%"
        initialDimension={{ width: 500, height: 220 }}
      >
        <RadialBarChart
          data={radialRows}
          innerRadius="18%"
          outerRadius="92%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis
            type="number"
            domain={[0, maximum]}
            tick={false}
          />
          <RadialBar
            dataKey="value"
            background={{ fill: 'rgba(255,255,255,0.04)' }}
            cornerRadius={6}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={tooltipNumber}
          />
          <Legend
            iconSize={8}
            iconType="circle"
            wrapperStyle={{ fontSize: 9, color: '#9ca3af' }}
          />
        </RadialBarChart>
      </ResponsiveContainer>
    );
  }

  if (widget.chart === 'treemap') {
    return (
      <ResponsiveContainer
        width="99%"
        height="100%"
        initialDimension={{ width: 500, height: 220 }}
      >
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
      <ResponsiveContainer
        width="99%"
        height="100%"
        initialDimension={{ width: 500, height: 220 }}
      >
        <FunnelChart>
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={tooltipNumber}
          />
          <Funnel
            dataKey="value"
            data={rows.slice(0, 10)}
            isAnimationActive={false}
          >
            {rows.slice(0, 10).map((row, index) => (
              <Cell
                key={row.name}
                fill={PALETTE[index % PALETTE.length]}
              />
            ))}
            <LabelList
              dataKey="name"
              position="right"
              fill="#d1d5db"
              fontSize={9}
            />
          </Funnel>
        </FunnelChart>
      </ResponsiveContainer>
    );
  }

  if (widget.chart === 'scatter') {
    return (
      <ResponsiveContainer
        width="99%"
        height="100%"
        initialDimension={{ width: 500, height: 220 }}
      >
        <ScatterChart
          margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.04)"
          />
          <XAxis dataKey="name" {...axis} tick={tick} />
          <YAxis
            dataKey="value"
            {...axis}
            tick={tick}
            tickFormatter={axisNumber}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={tooltipNumber}
          />
          <Scatter data={rows} fill={PALETTE[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  if (widget.chart === 'line' || widget.chart === 'area') {
    const ChartComponent =
      widget.chart === 'line' ? LineChart : AreaChart;

    return (
      <ResponsiveContainer
        width="99%"
        height="100%"
        initialDimension={{ width: 500, height: 220 }}
      >
        <ChartComponent
          data={rows}
          margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
        >
          <defs>
            <linearGradient
              id={`fill-${widget.id}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor="#10b981"
                stopOpacity={0.25}
              />
              <stop
                offset="100%"
                stopColor="#10b981"
                stopOpacity={0}
              />
            </linearGradient>
          </defs>

          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.04)"
            vertical={false}
          />
          <XAxis dataKey="name" {...axis} tick={tick} />
          <YAxis {...axis} tick={tick} tickFormatter={axisNumber} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={tooltipNumber}
          />

          {widget.chart === 'line' ? (
            <Line
              type="linear"
              dataKey="value"
              stroke="#6366f1"
              strokeWidth={2}
              dot={{ r: 2 }}
            />
          ) : (
            <Area
              type="linear"
              dataKey="value"
              stroke="#10b981"
              strokeWidth={2}
              fill={`url(#fill-${widget.id})`}
            />
          )}
        </ChartComponent>
      </ResponsiveContainer>
    );
  }

  if (widget.chart === 'horizontal_bar') {
    return (
      <ResponsiveContainer
        width="99%"
        height="100%"
        initialDimension={{ width: 500, height: 220 }}
      >
        <BarChart
          data={rows.slice(0, 15)}
          layout="vertical"
          margin={{ top: 4, right: 16, left: 4, bottom: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.04)"
            horizontal={false}
          />
          <XAxis
            type="number"
            {...axis}
            tick={tick}
            tickFormatter={axisNumber}
          />
          <YAxis
            dataKey="name"
            type="category"
            {...axis}
            tick={tick}
            width={74}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            formatter={tooltipNumber}
            cursor={{ fill: 'rgba(255,255,255,0.03)' }}
          />
          <Bar
            dataKey="value"
            radius={[0, 5, 5, 0]}
            maxBarSize={24}
          >
            {rows.map((row, index) => (
              <Cell
                key={row.name}
                fill={PALETTE[index % PALETTE.length]}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer
      width="99%"
      height="100%"
      initialDimension={{ width: 500, height: 220 }}
    >
      <BarChart
        data={rows}
        margin={{ top: 8, right: 8, left: -18, bottom: 0 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="rgba(255,255,255,0.04)"
          vertical={false}
        />
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
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          formatter={tooltipNumber}
          cursor={{ fill: 'rgba(255,255,255,0.03)' }}
        />
        <Bar
          dataKey="value"
          radius={[5, 5, 0, 0]}
          maxBarSize={46}
        >
          {rows.map((row, index) => (
            <Cell
              key={row.name}
              fill={PALETTE[index % PALETTE.length]}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function WidgetEditor({
  widget,
  fields,
  onChange,
}: {
  widget: Widget;
  fields: ModelFieldGroup[];
  onChange: (patch: Partial<Widget>) => void;
}) {
  const encode = (table: number, column: string | null) =>
    JSON.stringify([table, column]);

  const decode = (value: string) => {
    const [table_id, column] = JSON.parse(value) as [
      number,
      string | null,
    ];
    return { table_id, column };
  };

  const selected = fields
    .find((group) => group.table_id === widget.measure.table_id)
    ?.columns.find((column) => column.name === widget.measure.column);

  const allowed: Aggregation[] =
    widget.measure.column === null
      ? ['count']
      : NUMERIC.has(selected?.logical_type ?? '')
        ? AGGREGATIONS.filter(
            (aggregation) =>
              aggregation !== 'sum' ||
              selected?.additivity === 'additive',
          )
        : ['count', 'count_distinct', 'min', 'max'];

  const dimension = fields
    .find((group) => group.table_id === widget.dimension?.table_id)
    ?.columns.find((column) => column.name === widget.dimension?.column);

  const input =
    'w-full rounded border border-gray-700 bg-zinc-900 p-2 text-xs text-gray-200';

  return (
    <div className="mb-3 grid grid-cols-1 gap-3 rounded-lg border border-gray-800 p-3 sm:grid-cols-2">
      <label className="space-y-1 text-xs text-gray-400">
        Chart
        <select
          className={input}
          value={widget.chart}
          onChange={(event) => {
            const chart = event.target.value as CustomChartType;

            onChange({
              chart,
              ...(chart === 'kpi' ? { dimension: null } : {}),
            });
          }}
        >
          {CUSTOM_CHART_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="space-y-1 text-xs text-gray-400">
        Group by
        <select
          className={input}
          disabled={widget.chart === 'kpi'}
          value={
            widget.dimension
              ? encode(widget.dimension.table_id, widget.dimension.column)
              : ''
          }
          onChange={(event) => {
            const decoded = event.target.value
              ? decode(event.target.value)
              : null;

            onChange({
              dimension:
                decoded && decoded.column !== null
                  ? {
                      table_id: decoded.table_id,
                      column: decoded.column,
                    }
                  : null,
            });
          }}
        >
          <option value="">Nothing (one aggregate)</option>

          {fields.map((group) => (
            <optgroup key={group.table_id} label={group.table_name}>
              {group.columns.map((column) => (
                <option
                  key={column.name}
                  value={encode(group.table_id, column.name)}
                >
                  {column.name}
                </option>
              ))}
            </optgroup>
          ))}

          {widget.dimension && !dimension && (
            <option
              value={encode(
                widget.dimension.table_id,
                widget.dimension.column,
              )}
            >
              {widget.dimension.column} (missing field)
            </option>
          )}
        </select>
      </label>

      <label className="space-y-1 text-xs text-gray-400">
        Value / source table
        <select
          className={input}
          value={encode(widget.measure.table_id, widget.measure.column)}
          onChange={(event) => {
            const decoded = decode(event.target.value);

            const column = fields
              .find((group) => group.table_id === decoded.table_id)
              ?.columns.find((entry) => entry.name === decoded.column);

            const aggregation =
              decoded.column === null
                ? 'count'
                : NUMERIC.has(column?.logical_type ?? '')
                  ? column?.default_aggregation ?? 'avg'
                  : 'count_distinct';

            onChange({
              measure: { ...decoded, aggregation },
              base_table_id: decoded.table_id,
            });
          }}
        >
          {fields.map((group) => (
            <optgroup key={group.table_id} label={group.table_name}>
              <option value={encode(group.table_id, null)}>
                Count rows in {group.table_name}
              </option>

              {group.columns.map((column) => (
                <option
                  key={column.name}
                  value={encode(group.table_id, column.name)}
                >
                  {column.name}
                </option>
              ))}
            </optgroup>
          ))}

          {widget.measure.column !== null && !selected && (
            <option
              value={encode(widget.measure.table_id, widget.measure.column)}
            >
              {widget.measure.column} (missing field)
            </option>
          )}
        </select>
      </label>

      <label className="space-y-1 text-xs text-gray-400">
        Calculation
        <select
          className={input}
          value={widget.measure.aggregation}
          onChange={(event) =>
            onChange({
              measure: {
                ...widget.measure,
                aggregation: event.target.value as Aggregation,
              },
            })
          }
        >
          {!allowed.includes(widget.measure.aggregation) && (
            <option value={widget.measure.aggregation} disabled>
              {widget.measure.aggregation} (unsupported for this field)
            </option>
          )}

          {allowed.map((aggregation) => (
            <option key={aggregation} value={aggregation}>
              {aggregation.replace('_', ' ')}
            </option>
          ))}
        </select>
      </label>

      {widget.dimension &&
        dimension &&
        ['date', 'datetime'].includes(dimension.logical_type) && (
          <label className="space-y-1 text-xs text-gray-400">
            Date grouping
            <select
              className={input}
              value={widget.dimension.date_part ?? ''}
              onChange={(event) =>
                onChange({
                  dimension: {
                    ...widget.dimension!,
                    date_part: event.target.value || undefined,
                  },
                })
              }
            >
              <option value="">Original date / timestamp</option>
              {DATE_PARTS.map((part) => (
                <option key={part} value={part}>
                  {part.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        )}

      <label className="space-y-1 text-xs text-gray-400">
        Maximum result groups
        <input
          className={input}
          type="number"
          min={1}
          max={1000}
          value={widget.limit}
          onChange={(event) => {
            const limit = event.target.valueAsNumber;

            if (
              Number.isInteger(limit) &&
              limit >= 1 &&
              limit <= 1000
            ) {
              onChange({ limit });
            }
          }}
        />
      </label>

      <p className="text-xs text-gray-500 sm:col-span-2">
        Cross-table charts require one approved join path. The backend
        rejects joins that would multiply totals. Saving stores the chart
        configuration; Refresh retrieves current figures.
      </p>
    </div>
  );
}