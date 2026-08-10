'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import {
  Plus, Trash2, SlidersHorizontal, Layers, ChevronDown,
  Filter, RefreshCw, TrendingUp,
  BarChart3, LineChart as LineChartIcon, PieChart as PieChartIcon,
  AreaChart as AreaChartIcon, Table2, ScatterChart as ScatterIcon,
  X, Activity, Hash, Type,
  Calendar, ArrowUpRight, ArrowDownRight, GripVertical, Settings, Download
} from 'lucide-react';
import { Responsive, WidthProvider } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Dataset } from '../utils/parser';
import type { SemanticProfile, DataTableMeta, RelationshipCandidate } from '../utils/profiler';

const ResponsiveGridLayout = WidthProvider(Responsive);

/* ─────────────────────────── TYPES ─────────────────────────── */

interface DashboardWidget {
  id: string;
  type: 'bar' | 'line' | 'pie' | 'area' | 'scatter' | 'table' | 'kpi';
  title: string;
  xCol: string;
  yCol: string;
  agg: 'sum' | 'mean' | 'count' | 'min' | 'max' | 'none';
}

interface KPIItem {
  id: string;
  label: string;
  value: number;
  subtitle: string;
  change: number;
  sparkData: { v: number }[];
  sparkColor: string;
}

interface DashboardBuilderProps {
  dataset: Dataset;
  profile?: SemanticProfile | null;
  tables?: DataTableMeta[];
  relationships?: RelationshipCandidate[];
}

/* ─────────────────────────── CONSTANTS ─────────────────────────── */

const CHART_PALETTE = [
  '#06b6d4', '#10b981', '#8b5cf6', '#f59e0b',
  '#ec4899', '#6366f1', '#ef4444', '#14b8a6',
  '#f97316', '#a855f7', '#22d3ee', '#84cc16',
];

const GRADIENT_DEFS = [
  { id: 'gCyan',    from: '#06b6d4', to: '#0891b2' },
  { id: 'gEmerald', from: '#10b981', to: '#059669' },
  { id: 'gViolet',  from: '#8b5cf6', to: '#7c3aed' },
  { id: 'gAmber',   from: '#f59e0b', to: '#d97706' },
  { id: 'gPink',    from: '#ec4899', to: '#db2777' },
  { id: 'gIndigo',  from: '#6366f1', to: '#4f46e5' },
];

const TOOLTIP_STYLE: React.CSSProperties = {
  background: 'rgba(9, 9, 11, 0.95)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: '10px',
  backdropFilter: 'blur(12px)',
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
};

const KPI_COLORS = ['#06b6d4', '#10b981', '#8b5cf6', '#f59e0b'];

const CHART_TYPE_OPTIONS = [
  { value: 'bar',     label: 'Bar',     Icon: BarChart3 },
  { value: 'line',    label: 'Line',    Icon: LineChartIcon },
  { value: 'area',    label: 'Area',    Icon: AreaChartIcon },
  { value: 'pie',     label: 'Donut',   Icon: PieChartIcon },
  { value: 'scatter', label: 'Scatter', Icon: ScatterIcon },
  { value: 'table',   label: 'Table',   Icon: Table2 },
  { value: 'kpi',     label: 'KPI Card', Icon: Hash },
] as const;

const AGG_OPTIONS = [
  { value: 'sum',   label: 'Sum' },
  { value: 'mean',  label: 'Average' },
  { value: 'count', label: 'Count' },
  { value: 'min',   label: 'Min' },
  { value: 'max',   label: 'Max' },
  { value: 'none',  label: 'None (Raw)' },
] as const;

/* ─────────────────────────── FORMAT HELPERS ─────────────────────────── */

function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

/* ─────────────────────────── ANIMATED NUMBER ─────────────────────────── */

function AnimatedNumber({ value }: { value: number }) {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);

  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    const start = performance.now();
    const duration = 1200;

    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (to - from) * eased);
      if (progress < 1) requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);
    prevRef.current = to;
  }, [value]);

  return <span>{formatCompact(display)}</span>;
}

/* ─────────────────────────── MAIN COMPONENT ─────────────────────────── */

export default function DashboardBuilder({ dataset, profile, tables = [], relationships = [] }: DashboardBuilderProps) {
  const { headers, rows, types } = dataset;

  const [mounted, setMounted] = useState(false);
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [layouts, setLayouts] = useState<{ [key: string]: any[] }>({});
  const [showFilters, setShowFilters] = useState(false);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Record<string, string>>({});
  const [editingWidgetId, setEditingWidgetId] = useState<string | null>(null);
  const [savingLayout, setSavingLayout] = useState(false);

  const saveLayout = async () => {
    if (!dataset.projectId || dataset.projectId === 'undefined') {
      alert("Please save your project first (Data Upload / Cleaning tab) before saving custom layouts!");
      return;
    }
    setSavingLayout(true);
    try {
      const res = await fetch(`/api/projects/${dataset.projectId}/dashboard`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ widgets, layouts }),
      });
      if (!res.ok) throw new Error("Save failed");
      alert("Dashboard widgets and layouts saved successfully!");
    } catch (err) {
      console.error(err);
      alert("Failed to save dashboard.");
    } finally {
      setSavingLayout(false);
    }
  };

  // Column classification
  const numericCols = useMemo(() => headers.filter(h => types[h] === 'number'), [headers, types]);
  const categoricalCols = useMemo(() => headers.filter(h => types[h] === 'string'), [headers, types]);
  const dateCols = useMemo(() => headers.filter(h => types[h] === 'date'), [headers, types]);

  // ─── KPIs ───
  const kpis = useMemo<KPIItem[]>(() => {
    const items: KPIItem[] = [];

    items.push({
      id: 'kpi-records', label: 'Total Records', value: rows.length,
      subtitle: `${headers.length} columns`,
      change: 0,
      sparkData: Array.from({ length: 12 }, (_, i) => ({
        v: Math.floor(rows.length * (0.7 + Math.random() * 0.3) * ((i + 1) / 12)),
      })),
      sparkColor: KPI_COLORS[0],
    });

    numericCols.slice(0, 3).forEach((col, idx) => {
      const vals = rows.map(r => Number(r[col])).filter(v => !isNaN(v));
      if (vals.length === 0) return;

      const total = vals.reduce((a, b) => a + b, 0);
      const avg = total / vals.length;
      const isSum = idx === 0;
      const value = isSum ? total : avg;

      const half = Math.floor(vals.length / 2);
      const firstHalf = vals.slice(0, half);
      const secondHalf = vals.slice(half);
      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / (firstHalf.length || 1);
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / (secondHalf.length || 1);
      const change = firstAvg !== 0 ? ((secondAvg - firstAvg) / Math.abs(firstAvg)) * 100 : 0;

      const sampleSize = 12;
      const step = Math.max(1, Math.floor(vals.length / sampleSize));
      const sparkData = Array.from({ length: sampleSize }, (_, i) => ({
        v: vals[Math.min(i * step, vals.length - 1)] || 0,
      }));

      items.push({
        id: `kpi-${col}`, label: isSum ? `Total ${col}` : `Avg ${col}`, value,
        subtitle: `${isSum ? 'sum' : 'average'} of ${vals.length.toLocaleString()} values`,
        change: Math.round(change * 10) / 10,
        sparkData,
        sparkColor: KPI_COLORS[(idx + 1) % KPI_COLORS.length],
      });
    });

    return items;
  }, [rows, headers, numericCols]);

  // ─── Auto-generate or Load widgets + layouts on mount ───
  useEffect(() => {
    setMounted(true);
    if (headers.length === 0) return;

    const loadSavedDashboard = async () => {
      if (dataset.projectId && dataset.projectId !== 'undefined') {
        try {
          const res = await fetch(`/api/projects/${dataset.projectId}/dashboard`);
          if (res.ok) {
            const data = await res.json();
            if (data.widgets && data.widgets.length > 0) {
              setWidgets(data.widgets);
              setLayouts(data.layouts || {});
              return;
            }
          }
        } catch (err) {
          console.error("Error loading saved dashboard:", err);
        }
      }

      // Fallback: Auto-generate widgets
      const auto: DashboardWidget[] = [];
      const lgLayout: any[] = [];
      let widgetIdx = 0;
      let gridY = 0;

      const smartMeasures = profile ? profile.columns.filter(c => c.semantic_role === 'measure').map(c => c.name) : numericCols;
      const smartDimensions = profile ? profile.columns.filter(c => ['dimension', 'category', 'id', 'geographic'].includes(c.semantic_role || '')).map(c => c.name) : categoricalCols;
      const smartTime = profile ? profile.columns.filter(c => c.semantic_role === 'time').map(c => c.name) : dateCols;

      // 1. Bar chart
      if (smartDimensions.length > 0 && smartMeasures.length > 0) {
        const bestCat = smartDimensions.find(c => {
          const uniq = new Set(rows.map(r => r[c])).size;
          return uniq >= 2 && uniq <= 20;
        }) || smartDimensions[0];

        const id = `auto-bar-${widgetIdx++}`;
        auto.push({ id, type: 'bar', title: `${smartMeasures[0]} by ${bestCat}`, xCol: bestCat, yCol: smartMeasures[0], agg: 'sum' });
        lgLayout.push({ i: id, x: 0, y: gridY, w: 8, h: 4 });
      }

      // 2. Donut chart
      if (smartDimensions.length > 0 && smartMeasures.length > 0) {
        const pieCat = smartDimensions.find(c => {
          const uniq = new Set(rows.map(r => r[c])).size;
          return uniq >= 2 && uniq <= 10;
        }) || smartDimensions[0];

        const id = `auto-pie-${widgetIdx++}`;
        auto.push({ id, type: 'pie', title: `${pieCat} Distribution`, xCol: pieCat, yCol: smartMeasures[0], agg: 'sum' });
        lgLayout.push({ i: id, x: 8, y: gridY, w: 4, h: 4 });
      }

      gridY += 4;

      // 3. Line chart (time series)
      if (smartTime.length > 0 && smartMeasures.length > 0) {
        const id = `auto-line-${widgetIdx++}`;
        auto.push({ id, type: 'line', title: `${smartMeasures[0]} Trend over ${smartTime[0]}`, xCol: smartTime[0], yCol: smartMeasures[0], agg: 'sum' });
        lgLayout.push({ i: id, x: 0, y: gridY, w: 12, h: 4 });
        gridY += 4;
      }

      // 4. Area chart
      if (smartMeasures.length >= 2 && (smartTime.length > 0 || smartDimensions.length > 0)) {
        const xCol = smartTime[0] || smartDimensions[0];
        const id = `auto-area-${widgetIdx++}`;
        auto.push({ id, type: 'area', title: `${smartMeasures[1]} by ${xCol}`, xCol, yCol: smartMeasures[1], agg: 'sum' });
        lgLayout.push({ i: id, x: 0, y: gridY, w: 7, h: 4 });
      }

      // 5. Scatter
      if (smartMeasures.length >= 2) {
        const id = `auto-scatter-${widgetIdx++}`;
        auto.push({ id, type: 'scatter', title: `${smartMeasures[0]} vs ${smartMeasures[1]}`, xCol: smartMeasures[0], yCol: smartMeasures[1], agg: 'sum' });
        lgLayout.push({ i: id, x: 7, y: gridY, w: 5, h: 4 });
      }

      setWidgets(auto);
      setLayouts({ lg: lgLayout, md: lgLayout, sm: lgLayout.map(l => ({ ...l, x: 0, w: 12 })) });
    };

    loadSavedDashboard();
  }, [dataset, profile]);

  // ─── Filtered rows ───
  const filteredRows = useMemo(() => {
    return rows.filter(row => {
      for (const [col, filterVal] of Object.entries(activeFilters)) {
        if (filterVal && String(row[col] ?? '') !== filterVal) return false;
      }
      return true;
    });
  }, [rows, activeFilters]);

  const getUniqueValues = useCallback((col: string) => {
    const vals = new Set<string>();
    rows.forEach(r => { if (r[col] != null) vals.add(String(r[col])); });
    return Array.from(vals).sort().slice(0, 100);
  }, [rows]);

  // ─── Compute chart data ───
  const computeWidgetData = useCallback((widget: DashboardWidget) => {
    if (!widget.xCol || !widget.yCol) return [];

    // KPI Card Calculation
    if (widget.type === 'kpi') {
      const vals = filteredRows.map(r => Number(r[widget.yCol])).filter(v => !isNaN(v));
      let value = 0;
      if (vals.length > 0) {
        switch (widget.agg) {
          case 'sum':   value = vals.reduce((a, b) => a + b, 0); break;
          case 'mean':  value = vals.reduce((a, b) => a + b, 0) / vals.length; break;
          case 'count': value = vals.length; break;
          case 'min':   value = Math.min(...vals); break;
          case 'max':   value = Math.max(...vals); break;
          case 'none':  value = vals[0] || 0; break;
        }
      }
      
      // Sample last 12 values for the KPI sparkline
      const sampleSize = 12;
      const step = Math.max(1, Math.floor(vals.length / sampleSize));
      const sparkData = Array.from({ length: sampleSize }, (_, i) => ({
        v: vals[Math.min(i * step, vals.length - 1)] || 0,
      }));
      
      return [{ name: widget.title, value: Math.round(value * 100) / 100, sparkData }];
    }

    // Raw/Unaggregated data mapping
    if (widget.agg === 'none') {
      const isDateLikeX = types[widget.xCol] === 'date' || /date|month|year/i.test(widget.xCol);
      
      let data = filteredRows.slice(0, 150).map(row => {
        let xVal = row[widget.xCol];
        if (xVal == null) xVal = 'N/A';
        else if (xVal instanceof Date) xVal = `${xVal.getFullYear()}-${String(xVal.getMonth() + 1).padStart(2, '0')}`;
        else xVal = String(xVal);

        const yVal = Number(row[widget.yCol]);
        return { name: xVal, value: isNaN(yVal) ? 0 : yVal };
      });

      if (isDateLikeX) {
        data.sort((a, b) => a.name.localeCompare(b.name));
      }
      return data;
    }

    // Standard Aggregated calculation
    const groups: Record<string, number[]> = {};
    filteredRows.forEach(row => {
      let xVal = row[widget.xCol];
      if (xVal == null) xVal = 'N/A';
      else if (xVal instanceof Date) xVal = `${xVal.getFullYear()}-${String(xVal.getMonth() + 1).padStart(2, '0')}`;
      else xVal = String(xVal);

      const yVal = Number(row[widget.yCol]);
      if (!isNaN(yVal)) {
        if (!groups[xVal as string]) groups[xVal as string] = [];
        groups[xVal as string].push(yVal);
      }
    });

    let data = Object.entries(groups).map(([name, values]) => {
      let value = 0;
      switch (widget.agg) {
        case 'sum':   value = values.reduce((a, b) => a + b, 0); break;
        case 'mean':  value = values.reduce((a, b) => a + b, 0) / values.length; break;
        case 'count': value = values.length; break;
        case 'min':   value = Math.min(...values); break;
        case 'max':   value = Math.max(...values); break;
      }
      return { name, value: Math.round(value * 100) / 100 };
    });

    const isDateLike = types[widget.xCol] === 'date' || /date|month|year/i.test(widget.xCol);
    if (isDateLike) data.sort((a, b) => a.name.localeCompare(b.name));
    else data.sort((a, b) => b.value - a.value);

    if (widget.type === 'pie' && data.length > 8) {
      const top = data.slice(0, 7);
      const othersVal = data.slice(7).reduce((a, c) => a + c.value, 0);
      return [...top, { name: 'Others', value: othersVal }];
    }

    return data.slice(0, 25);
  }, [filteredRows, types]);

  // ─── Widget management ───
  const addWidget = (type: DashboardWidget['type']) => {
    const xCol = type === 'scatter'
      ? (numericCols[0] || headers[0] || '')
      : (categoricalCols[0] || dateCols[0] || headers[0] || '');
    const yCol = numericCols[0] || headers[0] || '';

    const w: DashboardWidget = {
      id: `widget-${Date.now()}`,
      type,
      title: type === 'kpi' ? `Total ${yCol}` : `${type.charAt(0).toUpperCase() + type.slice(1)} Chart`,
      xCol,
      yCol,
      agg: 'sum',
    };

    setWidgets(prev => [...prev, w]);

    // Add to layout at bottom
    setLayouts(prev => {
      const lg = prev.lg || [];
      const maxY = lg.reduce((max, l) => Math.max(max, l.y + l.h), 0);
      
      // Dynamic grid dimensions depending on widget type
      const gridW = type === 'kpi' ? 3 : type === 'pie' ? 4 : type === 'table' ? 12 : 6;
      const gridH = type === 'kpi' ? 2 : 4;

      const newLayout: any = {
        i: w.id, x: 0, y: maxY,
        w: gridW,
        h: gridH,
      };
      return { ...prev, lg: [...lg, newLayout], md: [...(prev.md || []), newLayout], sm: [...(prev.sm || []), { ...newLayout, x: 0, w: 12 }] };
    });

    setShowAddPanel(false);
    setEditingWidgetId(w.id);
  };

  const removeWidget = (id: string) => {
    setWidgets(prev => prev.filter(w => w.id !== id));
    setLayouts(prev => {
      const result: typeof prev = {};
      for (const [bp, layout] of Object.entries(prev)) {
        result[bp] = layout.filter(l => l.i !== id);
      }
      return result;
    });
    if (editingWidgetId === id) setEditingWidgetId(null);
  };

  const updateWidget = (id: string, updates: Partial<DashboardWidget>) => {
    setWidgets(prev => prev.map(w => w.id === id ? { ...w, ...updates } : w));
  };

  const handleLayoutChange = (currentLayout: any, allLayouts: any) => {
    setLayouts(allLayouts);
  };

  // ─── Filter management ───
  const filterableCols = useMemo(() =>
    headers.filter(h => { const uniq = new Set(rows.map(r => r[h])).size; return uniq >= 2 && uniq <= 50; }),
    [headers, rows]
  );

  // ─── Render chart (KEY FIX: explicit pixel dimensions) ───
  const renderChart = useCallback((widget: DashboardWidget, data: any[]) => {
    if (data.length === 0) {
      return (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="text-gray-500 text-xs">No data available</span>
        </div>
      );
    }

    const axisProps = { stroke: '#374151', fontSize: 10, tickLine: false as const, axisLine: false as const };
    const isNumericX = types[widget.xCol] === 'number' && widget.type === 'scatter';
    const xAxisType = isNumericX ? 'number' : 'category';

    switch (widget.type) {
      case 'kpi': {
        const kpiVal = data[0]?.value ?? 0;
        const spark = data[0]?.sparkData ?? [];
        return (
          <div className="w-full h-full flex flex-col justify-between p-2 relative overflow-hidden group">
            {/* Glowing background */}
            <div className="absolute -top-8 -right-8 h-20 w-20 rounded-full opacity-10 bg-cyan-400 blur-xl group-hover:opacity-20 transition-opacity" />
            
            <div className="relative z-10 pt-1">
              <div className="flex items-baseline justify-between">
                <span className="text-[28px] font-extrabold font-mono tracking-tight text-white leading-none">
                  <AnimatedNumber value={kpiVal} />
                </span>
                <span className="text-[9px] font-bold text-gray-500 bg-zinc-800/40 px-1.5 py-0.5 rounded border border-gray-800/40">
                  {widget.agg.toUpperCase()}
                </span>
              </div>
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider mt-1.5 truncate">
                {widget.yCol}
              </p>
            </div>

            {/* Sparkline */}
            <div className="h-10 w-full mt-2 relative z-10 shrink-0">
              <ResponsiveContainer width="99%" height="100%">
                <AreaChart data={spark}>
                  <defs>
                    <linearGradient id={`kpi-widget-spark-${widget.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#06b6d4" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="v" stroke="#06b6d4" strokeWidth={1.5} fillOpacity={1} fill={`url(#kpi-widget-spark-${widget.id})`} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      }

      case 'bar':
        return (
          <ResponsiveContainer width="99%" height="99%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <defs>
                {GRADIENT_DEFS.map(g => (
                  <linearGradient key={g.id} id={g.id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={g.from} stopOpacity={0.9} />
                    <stop offset="100%" stopColor={g.to} stopOpacity={0.6} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="name" type={xAxisType} {...axisProps} tick={{ fontSize: 9, fill: '#6b7280' }} interval={0} angle={data.length > 6 ? -30 : 0} textAnchor={data.length > 6 ? 'end' : 'middle'} height={data.length > 6 ? 55 : 30} />
              <YAxis {...axisProps} tick={{ fontSize: 9, fill: '#6b7280' }} tickFormatter={(v: any) => formatCompact(v)} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9ca3af', fontSize: 11 }} itemStyle={{ color: '#fff', fontSize: 11 }} formatter={(value: any) => [formatCompact(value), widget.yCol]} cursor={{ fill: 'rgba(255,255,255,0.03)' }} />
              <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={45}>
                {data.map((_, i) => <Cell key={i} fill={`url(#${GRADIENT_DEFS[i % GRADIENT_DEFS.length].id})`} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        );

      case 'line':
        return (
          <ResponsiveContainer width="99%" height="99%">
            <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="name" type={xAxisType} {...axisProps} tick={{ fontSize: 9, fill: '#6b7280' }} />
              <YAxis {...axisProps} tick={{ fontSize: 9, fill: '#6b7280' }} tickFormatter={(v: any) => formatCompact(v)} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9ca3af', fontSize: 11 }} itemStyle={{ color: '#fff', fontSize: 11 }} formatter={(value: any) => [formatCompact(value), widget.yCol]} />
              <Line type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3, fill: '#6366f1', strokeWidth: 0 }} activeDot={{ r: 5, fill: '#818cf8', stroke: '#6366f1', strokeWidth: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        );

      case 'area':
        return (
          <ResponsiveContainer width="99%" height="99%">
            <AreaChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="areaFillG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="name" type={xAxisType} {...axisProps} tick={{ fontSize: 9, fill: '#6b7280' }} />
              <YAxis {...axisProps} tick={{ fontSize: 9, fill: '#6b7280' }} tickFormatter={(v: any) => formatCompact(v)} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: '#9ca3af', fontSize: 11 }} itemStyle={{ color: '#fff', fontSize: 11 }} formatter={(value: any) => [formatCompact(value), widget.yCol]} />
              <Area type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#areaFillG)" />
            </AreaChart>
          </ResponsiveContainer>
        );

      case 'pie': {
        const total = data.reduce((acc, d) => acc + d.value, 0);
        return (
          <ResponsiveContainer width="99%" height="99%">
            <PieChart>
              <Pie data={data} cx="50%" cy="50%" innerRadius="50%" outerRadius="78%" paddingAngle={3} dataKey="value" strokeWidth={0}>
                {data.map((_, i) => <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />)}
              </Pie>
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: '#fff', fontSize: 11 }} formatter={(value: any, name: any) => [`${formatCompact(value)} (${((value / total) * 100).toFixed(1)}%)`, name]} />
              <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10, color: '#9ca3af', paddingTop: 4 }} />
              <text x="50%" y="48%" textAnchor="middle" fill="#fff" fontSize={15} fontWeight={700}>{formatCompact(total)}</text>
              <text x="50%" y="57%" textAnchor="middle" fill="#6b7280" fontSize={9}>Total</text>
            </PieChart>
          </ResponsiveContainer>
        );
      }

      case 'scatter':
        return (
          <ResponsiveContainer width="99%" height="99%">
            <ScatterChart margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="name" type={xAxisType} {...axisProps} tick={{ fontSize: 9, fill: '#6b7280' }} name={widget.xCol} />
              <YAxis dataKey="value" {...axisProps} tick={{ fontSize: 9, fill: '#6b7280' }} name={widget.yCol} />
              <Tooltip contentStyle={TOOLTIP_STYLE} itemStyle={{ color: '#fff', fontSize: 11 }} cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.15)' }} />
              <Scatter data={data.map(d => ({ name: Number(d.name) || 0, value: d.value }))} fill="#f59e0b">
                {data.map((_, i) => <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} opacity={0.8} />)}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        );

      case 'table':
        return (
          <div style={{ width: '100%', height: '100%', overflow: 'auto' }} className="rounded-lg border border-gray-800/40">
            <table className="w-full text-left">
              <thead className="sticky top-0 z-10">
                <tr className="bg-zinc-900/80 backdrop-blur-sm border-b border-gray-800">
                  <th className="p-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider">{widget.xCol}</th>
                  <th className="p-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider text-right">{widget.yCol} ({widget.agg})</th>
                  <th className="p-2.5 text-[10px] font-bold text-gray-400 uppercase tracking-wider text-right w-[120px]">Distribution</th>
                </tr>
              </thead>
              <tbody>
                {data.map((item, idx) => {
                  const maxVal = Math.max(...data.map(d => d.value));
                  const pct = maxVal > 0 ? (item.value / maxVal) * 100 : 0;
                  return (
                    <tr key={idx} className="border-b border-gray-800/20 hover:bg-zinc-900/30 transition-colors">
                      <td className="p-2.5 text-xs text-gray-300 font-medium truncate max-w-[150px]">{item.name}</td>
                      <td className="p-2.5 text-xs text-gray-200 text-right font-mono font-semibold">{formatCompact(item.value)}</td>
                      <td className="p-2.5"><div className="w-full bg-zinc-800/50 rounded-full h-1.5 overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${CHART_PALETTE[idx % CHART_PALETTE.length]}cc, ${CHART_PALETTE[idx % CHART_PALETTE.length]}80)` }} /></div></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );

      default:
        return null;
    }
  }, [types]);

  if (!mounted) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-400">
        <RefreshCw className="h-6 w-6 animate-spin text-cyan-400 mr-3" />
        <span className="text-sm font-medium">Initializing BI Dashboard Engine...</span>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ═══════ Header ═══════ */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">Business Intelligence Dashboard</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Drag widgets to rearrange · Resize from edges · Auto-generated from <span className="text-gray-400 font-medium">{dataset.fileName}</span> · {filteredRows.length.toLocaleString()} records
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={`px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
              showFilters || Object.values(activeFilters).filter(v => v).length > 0
                ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/40'
                : 'bg-zinc-900/60 text-gray-400 border border-gray-800 hover:text-gray-200 hover:border-gray-700'
            }`}
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {Object.values(activeFilters).filter(v => v).length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-400 text-[9px] font-bold">
                {Object.values(activeFilters).filter(v => v).length}
              </span>
            )}
          </button>
          <div className="relative">
            <button
              onClick={() => setShowAddPanel(!showAddPanel)}
              className="px-3 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 hover:from-cyan-400 hover:to-emerald-400 transition shadow-lg shadow-cyan-500/10"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Widget
            </button>
            {showAddPanel && (
              <div className="absolute right-0 top-full mt-2 z-50 p-3 rounded-xl border border-gray-800 bg-zinc-950/95 backdrop-blur-xl shadow-2xl shadow-black/50 min-w-[220px] animate-fade-in">
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2 px-1">Choose Visualization</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {CHART_TYPE_OPTIONS.map(opt => {
                    const Icon = opt.Icon;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => addWidget(opt.value as DashboardWidget['type'])}
                        className="p-2.5 rounded-lg border border-gray-800/60 bg-zinc-900/30 hover:border-cyan-500/40 hover:bg-cyan-950/20 text-xs text-gray-400 hover:text-white transition flex items-center gap-2"
                      >
                        <Icon className="h-3.5 w-3.5 text-cyan-400" />
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {dataset.projectId && (
            <button
              onClick={saveLayout}
              disabled={savingLayout}
              className="px-3 py-2 rounded-lg bg-zinc-900/60 border border-gray-800 text-gray-300 text-xs font-semibold hover:bg-zinc-800 hover:text-white transition flex items-center gap-1.5"
            >
              {savingLayout ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin text-cyan-400" />
              ) : (
                <Download className="h-3.5 w-3.5 text-cyan-400" />
              )}
              Save Layout
            </button>
          )}
        </div>
      </div>

      {/* ═══════ KPI Strip ═══════ */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((kpi, idx) => (
          <div
            key={kpi.id}
            className="relative overflow-hidden rounded-xl border border-gray-800/40 p-4 flex flex-col justify-between group hover:shadow-lg transition-all duration-300"
            style={{ background: `linear-gradient(135deg, ${kpi.sparkColor}08, ${kpi.sparkColor}03)`, minHeight: 140 }}
          >
            <div className="absolute -top-8 -right-8 h-24 w-24 rounded-full opacity-20 group-hover:opacity-40 transition-opacity duration-500" style={{ background: `radial-gradient(circle, ${kpi.sparkColor}40, transparent)` }} />

            <div className="relative z-10">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">{kpi.label}</p>
              <div className="flex items-end justify-between">
                <p className="text-2xl font-extrabold font-mono tracking-tight" style={{ color: kpi.sparkColor }}>
                  <AnimatedNumber value={kpi.value} />
                </p>
                {kpi.change !== 0 && (
                  <div className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-bold ${kpi.change > 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                    {kpi.change > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {Math.abs(kpi.change).toFixed(1)}%
                  </div>
                )}
              </div>
              <p className="text-[10px] text-gray-500 mt-0.5">{kpi.subtitle}</p>
            </div>

            {/* Sparkline with explicit height */}
            <div style={{ height: 40, width: '100%', marginTop: 8 }} className="relative z-10">
              <ResponsiveContainer width="99%" height={40}>
                <AreaChart data={kpi.sparkData}>
                  <defs>
                    <linearGradient id={`spark-${kpi.id}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={kpi.sparkColor} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={kpi.sparkColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="v" stroke={kpi.sparkColor} strokeWidth={1.5} fillOpacity={1} fill={`url(#spark-${kpi.id})`} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        ))}
      </div>

      {/* ═══════ Filter Bar ═══════ */}
      {showFilters && (
        <div className="glass-panel rounded-xl p-4 animate-fade-in border border-gray-800/60">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[10px] font-bold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" /> Global Filters
            </span>
            {Object.entries(activeFilters).map(([col, val]) => (
              <div key={col} className="flex items-center gap-1.5 bg-zinc-900/60 border border-gray-800 rounded-lg px-2 py-1.5">
                <span className="text-[10px] font-semibold text-gray-400">{col}:</span>
                <select value={val} onChange={e => setActiveFilters(prev => ({ ...prev, [col]: e.target.value }))} className="bg-transparent text-xs text-gray-200 outline-none cursor-pointer border-none p-0">
                  <option value="" className="bg-zinc-950">All</option>
                  {getUniqueValues(col).map(v => <option key={v} value={v} className="bg-zinc-950">{v}</option>)}
                </select>
                <button onClick={() => setActiveFilters(prev => { const c = { ...prev }; delete c[col]; return c; })} className="text-gray-500 hover:text-red-400 transition"><X className="h-3 w-3" /></button>
              </div>
            ))}
            <select value="" onChange={e => { if (e.target.value) setActiveFilters(prev => ({ ...prev, [e.target.value]: '' })); }} className="glass-input text-xs py-1.5 px-2 rounded-lg cursor-pointer">
              <option value="">+ Add filter...</option>
              {filterableCols.filter(c => !activeFilters.hasOwnProperty(c)).map(c => <option key={c} value={c} className="bg-zinc-950">{c}</option>)}
            </select>
            {Object.keys(activeFilters).length > 0 && (
              <button onClick={() => setActiveFilters({})} className="text-[10px] text-red-400 hover:text-red-300 font-semibold transition">Clear all</button>
            )}
          </div>
        </div>
      )}

      {/* ═══════ Draggable Widget Grid ═══════ */}
      {widgets.length === 0 ? (
        <div className="glass-panel rounded-xl flex flex-col items-center justify-center py-24 text-center">
          <Layers className="h-14 w-14 text-gray-700 mb-4" />
          <p className="text-sm font-semibold text-gray-400">Dashboard is empty</p>
          <p className="text-xs text-gray-500 mt-1 max-w-[280px]">
            Click &quot;Add Widget&quot; above to start building your custom BI dashboard.
          </p>
        </div>
      ) : (
        <ResponsiveGridLayout
          className="layout"
          layouts={layouts}
          breakpoints={{ lg: 1200, md: 768, sm: 0 }}
          cols={{ lg: 12, md: 12, sm: 12 }}
          rowHeight={70}
          onLayoutChange={handleLayoutChange}
          isDraggable={true}
          isResizable={true}
          draggableHandle=".drag-handle"
          margin={[14, 14]}
          containerPadding={[0, 0]}
        >
          {widgets.map(w => {
            const data = computeWidgetData(w);
            const isEditing = editingWidgetId === w.id;
            const chartTypeInfo = CHART_TYPE_OPTIONS.find(o => o.value === w.type);
            const ChartIcon = chartTypeInfo?.Icon || BarChart3;

            return (
              <div
                key={w.id}
                className={`group rounded-xl overflow-hidden border transition-all duration-200 flex flex-col h-full ${
                  isEditing
                    ? 'border-cyan-500/40 ring-1 ring-cyan-500/10 shadow-lg shadow-cyan-500/5'
                    : 'border-gray-800/50 hover:border-gray-700/60'
                }`}
                style={{ background: 'rgba(17, 24, 39, 0.5)', backdropFilter: 'blur(12px)' }}
              >
                {/* Widget Header */}
                <div className="flex items-center justify-between px-3.5 pt-3 pb-1 relative z-10 shrink-0">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <div className="drag-handle cursor-grab active:cursor-grabbing p-0.5 rounded hover:bg-zinc-800 transition">
                      <GripVertical className="h-3.5 w-3.5 text-gray-600" />
                    </div>
                    <div className="h-5 w-5 rounded-md bg-zinc-800/60 flex items-center justify-center shrink-0">
                      <ChartIcon className="h-3 w-3 text-cyan-400" />
                    </div>
                    {isEditing ? (
                      <input type="text" value={w.title} onChange={e => updateWidget(w.id, { title: e.target.value })} className="text-xs font-semibold text-white bg-transparent border-b border-cyan-500/40 outline-none flex-1 min-w-0 py-0.5" autoFocus />
                    ) : (
                      <h4 className="text-xs font-semibold text-gray-200 truncate">{w.title}</h4>
                    )}
                  </div>

                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity ml-2">
                    <button onClick={() => setEditingWidgetId(isEditing ? null : w.id)} className={`p-1 rounded transition ${isEditing ? 'bg-cyan-950/40 text-cyan-400' : 'hover:bg-zinc-800 text-gray-500 hover:text-gray-300'}`} title="Configure">
                      <Settings className="h-3 w-3" />
                    </button>
                    <button onClick={() => removeWidget(w.id)} className="p-1 rounded hover:bg-red-950/40 text-gray-500 hover:text-red-400 transition" title="Remove">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {/* Config Panel */}
                {isEditing && (
                  <div className="px-3.5 py-2 border-t border-gray-800/40 bg-zinc-900/30 flex flex-wrap items-center gap-3 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <label className="text-[9px] font-bold text-gray-500 uppercase">Type</label>
                      <select value={w.type} onChange={e => updateWidget(w.id, { type: e.target.value as any })} className="glass-input text-[10px] py-1 px-1.5 rounded">
                        {CHART_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-zinc-950">{o.label}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <label className="text-[9px] font-bold text-gray-500 uppercase">X</label>
                      <select value={w.xCol} onChange={e => updateWidget(w.id, { xCol: e.target.value })} className="glass-input text-[10px] py-1 px-1.5 rounded max-w-[120px]">
                        {headers.map(h => <option key={h} value={h} className="bg-zinc-950">{h}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <label className="text-[9px] font-bold text-gray-500 uppercase">Y</label>
                      <select value={w.yCol} onChange={e => updateWidget(w.id, { yCol: e.target.value })} className="glass-input text-[10px] py-1 px-1.5 rounded max-w-[120px]">
                        {headers.map(h => <option key={h} value={h} className="bg-zinc-950">{h}</option>)}
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <label className="text-[9px] font-bold text-gray-500 uppercase">Agg</label>
                      <select value={w.agg} onChange={e => updateWidget(w.id, { agg: e.target.value as any })} className="glass-input text-[10px] py-1 px-1.5 rounded">
                        {AGG_OPTIONS.map(o => <option key={o.value} value={o.value} className="bg-zinc-950">{o.label}</option>)}
                      </select>
                    </div>
                  </div>
                )}

                {/* Chart Area — KEY FIX: position:relative + absolute child for Recharts */}
                <div className="flex-1 min-h-0 px-3 pb-3 pt-1" style={{ position: 'relative' }}>
                  <div style={{ position: 'absolute', top: 4, left: 12, right: 12, bottom: 12 }}>
                    {renderChart(w, data)}
                  </div>
                </div>

                {/* Footer */}
                <div className="px-3.5 py-1.5 border-t border-gray-800/30 flex items-center justify-between text-[9px] text-gray-500 shrink-0">
                  <span>{data.length} data points</span>
                  <span className="font-mono">{w.agg.toUpperCase()} · {w.yCol}</span>
                </div>
              </div>
            );
          })}
        </ResponsiveGridLayout>
      )}

      {/* ═══════ Summary Bar ═══════ */}
      <div className="glass-panel rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3 border border-gray-800/40">
        <div className="flex items-center gap-4 text-[10px] text-gray-500">
          <span className="flex items-center gap-1.5"><Activity className="h-3.5 w-3.5 text-cyan-400" /><strong className="text-gray-300">{widgets.length}</strong> Active Widgets</span>
          <span className="flex items-center gap-1.5"><Hash className="h-3.5 w-3.5 text-emerald-400" /><strong className="text-gray-300">{numericCols.length}</strong> Numeric Cols</span>
          <span className="flex items-center gap-1.5"><Type className="h-3.5 w-3.5 text-violet-400" /><strong className="text-gray-300">{categoricalCols.length}</strong> Categorical Cols</span>
          <span className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5 text-amber-400" /><strong className="text-gray-300">{dateCols.length}</strong> Date Cols</span>
        </div>
        <span className="text-[9px] text-gray-600">
          {Object.values(activeFilters).filter(v => v).length > 0 ? `Showing ${filteredRows.length.toLocaleString()} filtered records` : `All ${rows.length.toLocaleString()} records`}
        </span>
      </div>
    </div>
  );
}
