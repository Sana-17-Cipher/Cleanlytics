'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Funnel, FunnelChart, LabelList, Pie, PieChart, PolarAngleAxis, PolarGrid,
  PolarRadiusAxis, Radar, RadarChart, RadialBar, RadialBarChart, ResponsiveContainer,
  Scatter, ScatterChart, Tooltip, Treemap, XAxis, YAxis,
} from 'recharts';
import {
  Grid3x3, Loader2, Plus, Save, Settings2, Trash2, TriangleAlert,
} from 'lucide-react';

import { ApiError, api } from '../lib/api';
import { CUSTOM_CHART_OPTIONS } from '../lib/dashboard-widgets';
import type { CustomChartType } from '../lib/dashboard-widgets';
import { compact, count, exact } from '../lib/format';
import type {
  Aggregation, ModelFieldGroup, QueryResult, QuerySpec, SemanticModel,
} from '../lib/types';

const PALETTE = [
  '#06b6d4', '#10b981', '#8b5cf6', '#f59e0b',
  '#ec4899', '#6366f1', '#ef4444', '#14b8a6',
];

const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'rgba(9,9,11,0.96)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 10,
  fontSize: 11,
};

/**
 * Recharts hands formatters a loosely-typed value. Narrowing here keeps the
 * call sites honest instead of casting at each one.
 */
function tooltipNumber(value: unknown): string {
  return typeof value === 'number' ? exact(value) : String(value ?? '');
}

function axisNumber(value: unknown): string {
  return typeof value === 'number' ? compact(value) : String(value ?? '');
}

interface Widget {
  id: string;
  title: string;
  chart: CustomChartType;
  dimension: { table_id: number; column: string; date_part?: string } | null;
  measure: { table_id: number; column: string | null; aggregation: Aggregation };
  limit: number;
}

interface DashboardBuilderProps {
  projectId: number;
  model: SemanticModel;
}

/**
 * Dashboard.
 *
 * Every figure comes from the query endpoint, which means charts can span
 * linked tables and the totals here match the ones on every other screen. The
 * previous version computed aggregates in the browser from whatever rows
 * happened to be loaded, ignored the relationships entirely, and filled the
 * headline sparkline with `Math.random()`.
 */
export default function DashboardBuilder({ projectId, model }: DashboardBuilderProps) {
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [results, setResults] = useState<Record<string, QueryResult | { error: string }>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fieldsByTable = useMemo(() => {
    const map = new Map<number, ModelFieldGroup>();
    model.fields.forEach((group) => map.set(group.table_id, group));
    return map;
  }, [model.fields]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await api.getDashboard(projectId);
        if (cancelled) return;
        const savedWidgets = saved.widgets as Widget[];
        // Earlier versions silently created four suggestion charts with these
        // ids. They stay out of the manual workspace; only graphs the user
        // explicitly added are restored here.
        setWidgets(savedWidgets.filter((widget) => !/^w\d+-/.test(widget.id)));
      } catch {
        if (!cancelled) setWidgets([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  /* ── Run each widget's query ─────────────────────────────────────────── */

  const specFor = useCallback((widget: Widget): QuerySpec => ({
    dimensions: widget.dimension
      ? [{
          table_id: widget.dimension.table_id,
          column: widget.dimension.column,
          date_part: widget.dimension.date_part ?? null,
        }]
      : [],
    measures: [{
      table_id: widget.measure.table_id,
      column: widget.measure.column,
      aggregation: widget.measure.aggregation,
      label: 'value',
    }],
    limit: widget.limit,
  }), []);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    widgets.forEach(async (widget) => {
      try {
        const result = await api.query(projectId, specFor(widget));
        if (!cancelled) setResults((current) => ({ ...current, [widget.id]: result }));
      } catch (cause) {
        if (!cancelled) {
          setResults((current) => ({
            ...current,
            [widget.id]: { error: cause instanceof ApiError ? cause.message : 'Could not load this chart.' },
          }));
        }
      }
    });
    return () => { cancelled = true; };
  }, [widgets, projectId, specFor, loaded]);

  /* ── Actions ─────────────────────────────────────────────────────────── */

  const addWidget = () => {
    const table = model.tables.find((t) => t.kind === 'fact') ?? model.tables[0];
    if (!table) return;
    const factFields = fieldsByTable.get(table.id);
    const dimensionGroup = model.fields.find((group) => group.columns.some((column) =>
      ['category', 'dimension', 'geographic'].includes(column.semantic_role)
      && column.distinct_count >= 2
      && column.distinct_count <= 50));
    const dimension = dimensionGroup?.columns.find((column) =>
      ['category', 'dimension', 'geographic'].includes(column.semantic_role)
      && column.distinct_count >= 2
      && column.distinct_count <= 50);
    const measure = factFields?.columns
      .filter((column) => column.semantic_role === 'measure')
      .sort((a, b) => b.distinct_count - a.distinct_count)[0];

    const widget: Widget = {
      id: `custom-${crypto.randomUUID()}`,
      title: measure && dimension ? `${measure.name} by ${dimension.name}` : `${table.table_name} rows`,
      chart: 'area',
      dimension: dimension && dimensionGroup
        ? { table_id: dimensionGroup.table_id, column: dimension.name }
        : null,
      measure: measure
        ? { table_id: table.id, column: measure.name, aggregation: measure.default_aggregation }
        : { table_id: table.id, column: null, aggregation: 'count' },
      limit: 25,
    };
    setWidgets([...widgets, widget]);
    setEditing(widget.id);
  };

  const updateWidget = (id: string, patch: Partial<Widget>) =>
    setWidgets(widgets.map((w) => (w.id === id ? { ...w, ...patch } : w)));

  const removeWidget = (id: string) => {
    setWidgets(widgets.filter((w) => w.id !== id));
    setResults((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setNotice(null);
    try {
      await api.saveDashboard(projectId, widgets, {});
      setNotice('Dashboard saved.');
    } catch (cause) {
      setNotice(cause instanceof ApiError ? cause.message : 'Could not save.');
    } finally {
      setSaving(false);
      window.setTimeout(() => setNotice(null), 4000);
    }
  };

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin text-cyan-400 mr-3" />
        <span className="text-sm">Building the dashboard…</span>
      </div>
    );
  }

  return (
    <section className="space-y-4 rounded-2xl border border-gray-800 bg-zinc-900/30 p-4 animate-fade-in">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold tracking-tight text-white">Your graphs</h2>
          <p className="text-[11px] text-gray-500 mt-1">
            Add only the graphs you want, then choose the grouping, value, and calculation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {notice && <span className="text-[11px] text-gray-400">{notice}</span>}
          <button
            onClick={addWidget}
            className="px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" /> Add chart
          </button>
          {widgets.length > 0 && (
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-2 rounded-lg border border-gray-800 bg-zinc-900/60 text-gray-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save graphs
            </button>
          )}
        </div>
      </div>

      {widgets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-800 py-7 text-center space-y-1.5">
          <Grid3x3 className="h-6 w-6 text-gray-700 mx-auto" />
          <p className="text-xs font-semibold text-gray-400">No custom graphs</p>
          <p className="text-[10.5px] text-gray-600">Use Add chart when you want one.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {widgets.map((widget) => (
            <WidgetCard
              key={widget.id}
              widget={widget}
              result={results[widget.id]}
              fields={model.fields}
              editing={editing === widget.id}
              onToggleEdit={() => setEditing(editing === widget.id ? null : widget.id)}
              onChange={(patch) => updateWidget(widget.id, patch)}
              onRemove={() => removeWidget(widget.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function WidgetCard({
  widget, result, fields, editing, onToggleEdit, onChange, onRemove,
}: {
  widget: Widget;
  result: QueryResult | { error: string } | undefined;
  fields: ModelFieldGroup[];
  editing: boolean;
  onToggleEdit: () => void;
  onChange: (patch: Partial<Widget>) => void;
  onRemove: () => void;
}) {
  const failed = result && 'error' in result;
  const data = result && !('error' in result) ? result : null;
  const dimensionKey = data?.fields.find((f) => f.kind === 'dimension')?.key;

  const rows = useMemo(() => {
    if (!data) return [];
    return data.rows.map((row) => ({
      name: dimensionKey ? String(row[dimensionKey] ?? 'blank') : 'total',
      value: Number(row.value ?? 0),
    }));
  }, [data, dimensionKey]);

  return (
    <div className="glass-panel rounded-xl border border-gray-800 flex flex-col min-h-[320px]">
      <div className="px-4 pt-3 pb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {editing ? (
            <input
              value={widget.title}
              onChange={(e) => onChange({ title: e.target.value })}
              className="text-xs font-semibold text-white bg-transparent border-b border-cyan-700 outline-none w-full"
            />
          ) : (
            <h4 className="text-xs font-bold text-gray-100 truncate">{widget.title}</h4>
          )}
          {data && (
            <p className="text-[10px] text-gray-600 mt-0.5">
              {data.base_table_name}
              {data.joined_tables.length > 0 && ` + ${data.joined_tables.join(', ')}`}
              {' · '}{count(data.row_count)} groups
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={onToggleEdit} className="p-1 rounded hover:bg-zinc-800 text-gray-500 hover:text-gray-300">
            <Settings2 className="h-3.5 w-3.5" />
          </button>
          <button onClick={onRemove} className="p-1 rounded hover:bg-red-950/40 text-gray-500 hover:text-red-400">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {editing && <WidgetEditor widget={widget} fields={fields} onChange={onChange} />}

      {data && data.warnings.length > 0 && (
        <div className="mx-4 mb-2 px-2.5 py-1.5 rounded bg-amber-950/20 border border-amber-900/40">
          {data.warnings.map((warning) => (
            <p key={warning} className="text-[10px] text-amber-400 flex items-start gap-1.5">
              <TriangleAlert className="h-3 w-3 shrink-0 mt-0.5" /> {warning}
            </p>
          ))}
        </div>
      )}

      <div className="flex-1 px-3 pb-3 min-h-[220px]">
        {failed ? (
          <div className="h-full flex items-center justify-center text-center px-4">
            <p className="text-[11px] text-red-400">{(result as { error: string }).error}</p>
          </div>
        ) : !data ? (
          <div className="h-full flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-gray-600" />
          </div>
        ) : rows.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-[11px] text-gray-600">No data for this combination.</p>
          </div>
        ) : (
          <ChartBody widget={widget} rows={rows} />
        )}
      </div>
    </div>
  );
}

function ChartBody({ widget, rows }: { widget: Widget; rows: { name: string; value: number }[] }) {
  const axis = { stroke: '#374151', tickLine: false as const, axisLine: false as const };
  const tick = { fontSize: 9, fill: '#6b7280' };

  if (widget.chart === 'kpi') {
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    return (
      <div className="h-full flex flex-col items-center justify-center">
        <span className="text-4xl font-extrabold font-mono text-white">{compact(total)}</span>
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
                <td className="px-3 py-1.5 text-gray-200 text-right font-mono">{exact(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (widget.chart === 'pie') {
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    return (
      <ResponsiveContainer width="99%" height="100%" initialDimension={{ width: 500, height: 220 }}>
        <PieChart>
          <Pie data={rows} dataKey="value" nameKey="name" innerRadius="50%" outerRadius="78%" paddingAngle={2} strokeWidth={0}>
            {rows.map((row, index) => <Cell key={row.name} fill={PALETTE[index % PALETTE.length]} />)}
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
    const maximum = Math.max(...rows.map((row) => row.value), 1);
    const radialRows = rows.slice(0, 8).map((row, index) => ({
      ...row,
      fill: PALETTE[index % PALETTE.length],
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
              <Cell key={row.name} fill={PALETTE[index % PALETTE.length]} />
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
          <Scatter data={rows} fill={PALETTE[0]} />
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
            <Line type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} dot={{ r: 2 }} />
          ) : (
            <Area type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} fill={`url(#fill-${widget.id})`} />
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
            {rows.map((row, index) => <Cell key={row.name} fill={PALETTE[index % PALETTE.length]} />)}
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
          {rows.map((row, index) => <Cell key={row.name} fill={PALETTE[index % PALETTE.length]} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function WidgetEditor({
  widget, fields, onChange,
}: { widget: Widget; fields: ModelFieldGroup[]; onChange: (patch: Partial<Widget>) => void }) {
  const aggregations: Aggregation[] = ['sum', 'avg', 'median', 'min', 'max', 'count', 'count_distinct'];

  const encode = (tableId: number, column: string) => `${tableId}::${column}`;
  const decode = (value: string) => {
    const [id, ...rest] = value.split('::');
    return { table_id: Number(id), column: rest.join('::') };
  };

  return (
    <div className="mx-4 mb-2 p-3 rounded-lg bg-zinc-900/50 border border-gray-800/60 grid grid-cols-2 gap-2">
      <label className="space-y-1">
        <span className="text-[9px] font-bold text-gray-500 uppercase">Chart</span>
        <select
          value={widget.chart}
          onChange={(e) => onChange({ chart: e.target.value as CustomChartType })}
          className="w-full glass-input text-[10px] py-1"
        >
          {CUSTOM_CHART_OPTIONS.map((chart) => (
            <option key={chart.value} value={chart.value}>{chart.label}</option>
          ))}
        </select>
      </label>

      <label className="space-y-1">
        <span className="text-[9px] font-bold text-gray-500 uppercase">Group by</span>
        <select
          value={widget.dimension ? encode(widget.dimension.table_id, widget.dimension.column) : ''}
          onChange={(e) => onChange({ dimension: e.target.value ? decode(e.target.value) : null })}
          className="w-full glass-input text-[10px] py-1"
        >
          <option value="">Nothing (one total)</option>
          {fields.map((group) => (
            <optgroup key={group.table_id} label={group.table_name}>
              {group.columns
                .filter((c) => c.semantic_role !== 'measure')
                .map((c) => (
                  <option key={c.name} value={encode(group.table_id, c.name)}>
                    {c.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="space-y-1">
        <span className="text-[9px] font-bold text-gray-500 uppercase">Value</span>
        <select
          value={widget.measure.column ? encode(widget.measure.table_id, widget.measure.column) : ''}
          onChange={(e) => {
            if (!e.target.value) {
              onChange({ measure: { ...widget.measure, column: null, aggregation: 'count' } });
              return;
            }
            const decoded = decode(e.target.value);
            const group = fields.find((g) => g.table_id === decoded.table_id);
            const column = group?.columns.find((c) => c.name === decoded.column);
            onChange({
              measure: {
                table_id: decoded.table_id,
                column: decoded.column,
                // Default to the aggregation the analysis picked, so prices
                // average rather than summing into a meaningless total.
                aggregation: column?.default_aggregation ?? 'sum',
              },
            });
          }}
          className="w-full glass-input text-[10px] py-1"
        >
          <option value="">Count of rows</option>
          {fields.map((group) => (
            <optgroup key={group.table_id} label={group.table_name}>
              {group.columns.map((c) => (
                <option key={c.name} value={encode(group.table_id, c.name)}>{c.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <label className="space-y-1">
        <span className="text-[9px] font-bold text-gray-500 uppercase">How</span>
        <select
          value={widget.measure.aggregation}
          onChange={(e) => onChange({ measure: { ...widget.measure, aggregation: e.target.value as Aggregation } })}
          className="w-full glass-input text-[10px] py-1"
        >
          {aggregations.map((a) => <option key={a} value={a}>{a.replace('_', ' ')}</option>)}
        </select>
      </label>
    </div>
  );
}
