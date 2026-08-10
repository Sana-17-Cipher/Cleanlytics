'use client';

import React, { useState, useMemo, useRef } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import {
  FileText, Printer, ChevronRight, ChevronLeft, Settings, BarChart3,
  PieChart as PieIcon, TrendingUp, CheckSquare, Square, Star, Shield,
  Building2, User, Calendar, Palette, Hash, AlertTriangle, Target,
  Award, ArrowUpRight, ArrowDownRight, Minus, LayoutDashboard
} from 'lucide-react';
import { Dataset } from '../utils/parser';

interface ReportGeneratorProps {
  dataset: Dataset;
}

type Step = 'config' | 'kpi' | 'charts' | 'preview';

interface ReportConfig {
  title: string;
  company: string;
  author: string;
  dateRange: string;
  theme: 'light' | 'dark';
  template: 'sales' | 'inventory' | 'hr' | 'finance' | 'marketing';
  confidential: boolean;
}

const CHART_PALETTE = ['#06b6d4', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899', '#6366f1', '#ef4444', '#14b8a6'];

const TEMPLATES: Record<string, { label: string; icon: string; color: string }> = {
  sales:     { label: 'Sales Report',     icon: '📈', color: '#06b6d4' },
  inventory: { label: 'Inventory Report', icon: '📦', color: '#10b981' },
  hr:        { label: 'HR Report',        icon: '👥', color: '#8b5cf6' },
  finance:   { label: 'Finance Report',   icon: '💰', color: '#f59e0b' },
  marketing: { label: 'Marketing Report', icon: '🎯', color: '#ec4899' },
};

function fmt(n: number): string {
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export default function ReportGenerator({ dataset }: ReportGeneratorProps) {
  const [step, setStep] = useState<Step>('config');

  const [config, setConfig] = useState<ReportConfig>({
    title: 'Business Performance Report',
    company: 'My Company',
    author: 'Analyst',
    dateRange: `Jan ${new Date().getFullYear()} - Dec ${new Date().getFullYear()}`,
    theme: 'light',
    template: 'sales',
    confidential: false,
  });

  const numericCols = useMemo(() => dataset.headers.filter(h => dataset.types[h] === 'number'), [dataset]);
  const catCols = useMemo(() => dataset.headers.filter(h => dataset.types[h] === 'string'), [dataset]);

  const kpiOptions = useMemo(() => [
    { id: 'total_records', label: 'Total Records', icon: Hash },
    ...numericCols.slice(0, 6).flatMap(col => [
      { id: `sum_${col}`, label: `Total ${col}`, icon: ArrowUpRight },
      { id: `avg_${col}`, label: `Avg ${col}`, icon: Minus },
      { id: `max_${col}`, label: `Max ${col}`, icon: Star },
      { id: `min_${col}`, label: `Min ${col}`, icon: ArrowDownRight },
    ])
  ], [numericCols]);

  const [selectedKPIs, setSelectedKPIs] = useState<string[]>(['total_records', ...(numericCols.slice(0, 2).flatMap(c => [`sum_${c}`, `avg_${c}`]))]);

  const chartOptions = [
    { id: 'bar', label: 'Bar Chart', icon: BarChart3 },
    { id: 'line', label: 'Line Chart', icon: TrendingUp },
    { id: 'pie', label: 'Pie Chart', icon: PieIcon },
    { id: 'area', label: 'Area Chart', icon: LayoutDashboard },
  ];
  const [selectedCharts, setSelectedCharts] = useState<string[]>(['bar', 'pie']);

  const toggleItem = (list: string[], setList: React.Dispatch<React.SetStateAction<string[]>>, id: string) => {
    setList(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  /* ─── Analytics Engine ─── */
  const analytics = useMemo(() => {
    const rows = dataset.rows;
    const total = rows.length;

    // Duplicate count
    const seen = new Set<string>();
    let dupes = 0;
    rows.forEach(r => {
      const key = JSON.stringify(r);
      if (seen.has(key)) dupes++;
      else seen.add(key);
    });

    // Missing values
    let missing = 0;
    let totalCells = rows.length * dataset.headers.length;
    rows.forEach(r => {
      dataset.headers.forEach(h => {
        if (r[h] === null || r[h] === undefined || r[h] === '') missing++;
      });
    });
    const missingPct = totalCells > 0 ? ((missing / totalCells) * 100).toFixed(1) : '0';
    const qualityScore = Math.max(0, Math.round(100 - (missing / totalCells) * 60 - (dupes / total) * 40));

    // KPI values
    const kpiValues: Record<string, number> = { total_records: total };
    numericCols.forEach(col => {
      const vals = rows.map(r => Number(r[col])).filter(v => !isNaN(v));
      kpiValues[`sum_${col}`] = vals.reduce((a, b) => a + b, 0);
      kpiValues[`avg_${col}`] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      kpiValues[`max_${col}`] = vals.length ? Math.max(...vals) : 0;
      kpiValues[`min_${col}`] = vals.length ? Math.min(...vals) : 0;
    });

    // Chart data (top cat col vs first numeric)
    const catCol = catCols[0] || dataset.headers[0];
    const numCol = numericCols[0];
    let chartData: { name: string; value: number }[] = [];
    if (catCol && numCol) {
      const grouped: Record<string, number[]> = {};
      rows.forEach(r => {
        const k = String(r[catCol] ?? 'N/A');
        if (!grouped[k]) grouped[k] = [];
        grouped[k].push(Number(r[numCol]) || 0);
      });
      chartData = Object.entries(grouped)
        .map(([name, vals]) => ({ name, value: Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100 }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);
    }

    // Business highlights using groupby logic
    let highlights: string[] = [];
    if (chartData.length > 0 && numCol) {
      const top = chartData[0];
      const bottom = chartData[chartData.length - 1];
      const total_sum = chartData.reduce((a, b) => a + b.value, 0);
      const topPct = total_sum > 0 ? ((top.value / total_sum) * 100).toFixed(0) : '0';
      highlights.push(`Dataset contains ${total.toLocaleString()} records with ${dataset.headers.length} columns.`);
      highlights.push(`"${top.name}" generated the highest ${numCol} with ${fmt(top.value)} (${topPct}% of total).`);
      if (bottom.name !== top.name) highlights.push(`"${bottom.name}" recorded the lowest ${numCol} at ${fmt(bottom.value)}.`);
      if (dupes > 0) highlights.push(`${dupes} duplicate records were identified in the dataset.`);
      if (missing > 0) highlights.push(`${missingPct}% of total data cells contain missing values.`);
      if (chartData.length >= 3) {
        const second = chartData[1];
        const secondPct = total_sum > 0 ? ((second.value / total_sum) * 100).toFixed(0) : '0';
        highlights.push(`"${second.name}" contributed ${secondPct}% of total ${numCol}.`);
      }
    } else {
      highlights.push(`Dataset contains ${total.toLocaleString()} records with ${dataset.headers.length} columns.`);
    }

    // Statistical summary per numeric col
    const stats = numericCols.slice(0, 5).map(col => ({
      col,
      ...dataset.stats[col],
      mode: (() => {
        const vals = rows.map(r => r[col]).filter(v => v !== null);
        const freq: Record<string, number> = {};
        vals.forEach(v => { const k = String(v); freq[k] = (freq[k] || 0) + 1; });
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N/A';
      })(),
    }));

    // Data dictionary
    const dictionary = dataset.headers.map(h => ({
      name: h,
      type: dataset.types[h],
      missing: dataset.nullCounts[h] ?? 0,
      missingPct: total > 0 ? ((dataset.nullCounts[h] ?? 0) / total * 100).toFixed(1) : '0',
      unique: new Set(rows.map(r => String(r[h]))).size,
    }));

    return { total, dupes, missing, missingPct, qualityScore, kpiValues, chartData, catCol, numCol, highlights, stats, dictionary };
  }, [dataset, numericCols, catCols]);

  const STEPS: { id: Step; label: string }[] = [
    { id: 'config', label: 'Configuration' },
    { id: 'kpi', label: 'KPI Selection' },
    { id: 'charts', label: 'Chart Selection' },
    { id: 'preview', label: 'Preview & Export' },
  ];
  const stepIdx = STEPS.findIndex(s => s.id === step);

  const handlePrint = () => window.print();

  const themeClass = config.theme === 'light'
    ? 'bg-white text-gray-900'
    : 'bg-gray-900 text-gray-100';

  const cardClass = config.theme === 'light'
    ? 'bg-gray-50 border border-gray-200'
    : 'bg-zinc-800 border border-gray-700';

  const tableHeadClass = config.theme === 'light'
    ? 'bg-gray-100 text-gray-700'
    : 'bg-zinc-700 text-gray-300';

  const tableRowClass = config.theme === 'light'
    ? 'border-gray-200 text-gray-800'
    : 'border-gray-700 text-gray-200';

  const accentColor = TEMPLATES[config.template]?.color ?? '#06b6d4';

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ─── Stepper Header (no-print) ─── */}
      <div className="no-print flex-shrink-0 bg-zinc-950 border-b border-gray-800 px-8 py-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <FileText className="text-blue-400" size={22} />
            <h2 className="text-xl font-bold text-white">Report Generator</h2>
          </div>
          {step === 'preview' && (
            <button
              onClick={handlePrint}
              className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors text-sm"
            >
              <Printer size={16} /> Save as PDF
            </button>
          )}
        </div>

        {/* Steps */}
        <div className="flex items-center gap-0">
          {STEPS.map((s, i) => (
            <React.Fragment key={s.id}>
              <button
                onClick={() => setStep(s.id)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  step === s.id
                    ? 'bg-blue-600 text-white'
                    : i < stepIdx
                    ? 'bg-green-900/50 text-green-400'
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                <span className="mr-1.5">{i + 1}.</span>{s.label}
              </button>
              {i < STEPS.length - 1 && <ChevronRight size={16} className="text-gray-600 mx-1" />}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* ─── Step Panels (no-print) ─── */}
      <div className="no-print flex-1 overflow-y-auto">

        {/* STEP 1: Configuration */}
        {step === 'config' && (
          <div className="p-8 max-w-3xl mx-auto">
            <h3 className="text-lg font-semibold text-white mb-6 flex items-center gap-2"><Settings size={18}/> Report Configuration</h3>
            <div className="grid grid-cols-2 gap-6">
              {[
                { label: 'Report Title', key: 'title', placeholder: 'Sales Performance Report' },
                { label: 'Company Name', key: 'company', placeholder: 'ABC Pvt Ltd' },
                { label: 'Author', key: 'author', placeholder: 'John' },
                { label: 'Date Range', key: 'dateRange', placeholder: 'Jan 2026 - Dec 2026' },
              ].map(({ label, key, placeholder }) => (
                <div key={key}>
                  <label className="block text-sm text-gray-400 mb-1">{label}</label>
                  <input
                    className="w-full bg-zinc-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                    placeholder={placeholder}
                    value={(config as any)[key]}
                    onChange={e => setConfig(prev => ({ ...prev, [key]: e.target.value }))}
                  />
                </div>
              ))}

              <div>
                <label className="block text-sm text-gray-400 mb-1">Theme</label>
                <div className="flex gap-3">
                  {(['light', 'dark'] as const).map(t => (
                    <button key={t} onClick={() => setConfig(p => ({ ...p, theme: t }))}
                      className={`flex-1 py-2 rounded-lg border text-sm capitalize transition-colors ${config.theme === t ? 'border-blue-500 bg-blue-900/30 text-blue-300' : 'border-gray-700 text-gray-400 hover:border-gray-500'}`}>
                      {t === 'light' ? '☀️ Light' : '🌙 Dark'}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Confidential</label>
                <button onClick={() => setConfig(p => ({ ...p, confidential: !p.confidential }))}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg border text-sm transition-colors ${config.confidential ? 'border-red-500 bg-red-900/30 text-red-300' : 'border-gray-700 text-gray-400'}`}>
                  <Shield size={14} /> {config.confidential ? 'Marked Confidential' : 'Not Confidential'}
                </button>
              </div>
            </div>

            <div className="mt-6">
              <label className="block text-sm text-gray-400 mb-3">Report Template</label>
              <div className="grid grid-cols-5 gap-3">
                {Object.entries(TEMPLATES).map(([key, t]) => (
                  <button key={key} onClick={() => setConfig(p => ({ ...p, template: key as any }))}
                    className={`p-3 rounded-xl border text-center text-xs transition-all ${config.template === key ? 'border-blue-500 bg-blue-900/30' : 'border-gray-700 hover:border-gray-500'}`}>
                    <div className="text-2xl mb-1">{t.icon}</div>
                    <div className="text-gray-300">{t.label}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-8 flex justify-end">
              <button onClick={() => setStep('kpi')}
                className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors">
                Next: KPI Selection <ChevronRight size={16}/>
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: KPI Selection */}
        {step === 'kpi' && (
          <div className="p-8 max-w-3xl mx-auto">
            <h3 className="text-lg font-semibold text-white mb-6 flex items-center gap-2"><Hash size={18}/> KPI Selection</h3>
            <p className="text-gray-400 text-sm mb-4">Choose which KPIs to include in the report. Only selected KPIs will appear.</p>
            <div className="grid grid-cols-2 gap-3">
              {kpiOptions.map(({ id, label, icon: Icon }) => {
                const selected = selectedKPIs.includes(id);
                return (
                  <button key={id} onClick={() => toggleItem(selectedKPIs, setSelectedKPIs, id)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${selected ? 'border-blue-500 bg-blue-900/20' : 'border-gray-700 hover:border-gray-500'}`}>
                    {selected ? <CheckSquare size={18} className="text-blue-400 shrink-0"/> : <Square size={18} className="text-gray-500 shrink-0"/>}
                    <div>
                      <p className="text-sm font-medium text-white">{label}</p>
                      {analytics.kpiValues[id] !== undefined && (
                        <p className="text-xs text-gray-400">{fmt(analytics.kpiValues[id])}</p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="mt-8 flex justify-between">
              <button onClick={() => setStep('config')} className="flex items-center gap-2 px-6 py-2 border border-gray-700 text-gray-300 rounded-lg hover:border-gray-500 transition-colors">
                <ChevronLeft size={16}/> Back
              </button>
              <button onClick={() => setStep('charts')} className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors">
                Next: Chart Selection <ChevronRight size={16}/>
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Chart Selection */}
        {step === 'charts' && (
          <div className="p-8 max-w-3xl mx-auto">
            <h3 className="text-lg font-semibold text-white mb-6 flex items-center gap-2"><BarChart3 size={18}/> Chart Selection</h3>
            <p className="text-gray-400 text-sm mb-4">Select which chart types to include in the report.</p>
            <div className="grid grid-cols-2 gap-4">
              {chartOptions.map(({ id, label, icon: Icon }) => {
                const selected = selectedCharts.includes(id);
                return (
                  <button key={id} onClick={() => toggleItem(selectedCharts, setSelectedCharts, id)}
                    className={`flex items-center gap-4 p-4 rounded-xl border transition-all ${selected ? 'border-blue-500 bg-blue-900/20' : 'border-gray-700 hover:border-gray-500'}`}>
                    {selected ? <CheckSquare size={20} className="text-blue-400 shrink-0"/> : <Square size={20} className="text-gray-500 shrink-0"/>}
                    <Icon size={20} className={selected ? 'text-blue-400' : 'text-gray-500'} />
                    <span className="text-sm font-medium text-white">{label}</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-8 flex justify-between">
              <button onClick={() => setStep('kpi')} className="flex items-center gap-2 px-6 py-2 border border-gray-700 text-gray-300 rounded-lg hover:border-gray-500 transition-colors">
                <ChevronLeft size={16}/> Back
              </button>
              <button onClick={() => setStep('preview')} className="flex items-center gap-2 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors">
                Generate Report <ChevronRight size={16}/>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── PRINTABLE REPORT PREVIEW ─── */}
      {step === 'preview' && (
        <div id="report-preview" className={`printable-report flex-1 overflow-y-auto ${themeClass}`}>
          <div className="max-w-5xl mx-auto p-10">

            {/* COVER PAGE */}
            <div className="mb-12 pb-12 border-b-2" style={{ borderColor: accentColor }}>
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: accentColor }}>
                    {TEMPLATES[config.template].icon} {TEMPLATES[config.template].label}
                  </div>
                  <h1 className="text-5xl font-bold mb-4 leading-tight">{config.title}</h1>
                  <div className={`flex gap-6 text-sm ${config.theme === 'light' ? 'text-gray-600' : 'text-gray-400'}`}>
                    <span className="flex items-center gap-1"><Building2 size={13}/> {config.company}</span>
                    <span className="flex items-center gap-1"><User size={13}/> {config.author}</span>
                    <span className="flex items-center gap-1"><Calendar size={13}/> {config.dateRange}</span>
                  </div>
                </div>
                {config.confidential && (
                  <div className="border-2 border-red-500 text-red-500 text-xs font-bold px-3 py-2 rotate-[-5deg] uppercase tracking-widest">
                    Confidential
                  </div>
                )}
              </div>
              <div className="mt-6 text-xs" style={{ color: accentColor }}>
                Generated on {new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })} · CLEANYTICS
              </div>
            </div>

            {/* SECTION: Executive Summary */}
            <section className="mb-12">
              <h2 className="text-2xl font-bold mb-4 pb-2 border-b" style={{ borderColor: accentColor, color: accentColor }}>Executive Summary</h2>
              <ul className={`space-y-2 text-sm ${config.theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                {analytics.highlights.map((h, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span style={{ color: accentColor }} className="mt-0.5 shrink-0">▸</span> {h}
                  </li>
                ))}
              </ul>
            </section>

            {/* SECTION: KPI Cards */}
            {selectedKPIs.length > 0 && (
              <section className="mb-12">
                <h2 className="text-2xl font-bold mb-4 pb-2 border-b" style={{ borderColor: accentColor, color: accentColor }}>Key Performance Indicators</h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {selectedKPIs.map(id => {
                    const kpi = kpiOptions.find(k => k.id === id);
                    const value = analytics.kpiValues[id];
                    if (!kpi || value === undefined) return null;
                    const Icon = kpi.icon;
                    return (
                      <div key={id} className={`${cardClass} rounded-xl p-4`}>
                        <div className="flex items-center justify-between mb-2">
                          <p className={`text-xs ${config.theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>{kpi.label}</p>
                          <Icon size={14} style={{ color: accentColor }}/>
                        </div>
                        <p className="text-2xl font-bold" style={{ color: accentColor }}>{fmt(value)}</p>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {/* SECTION: Data Quality Summary */}
            <section className="mb-12">
              <h2 className="text-2xl font-bold mb-4 pb-2 border-b" style={{ borderColor: accentColor, color: accentColor }}>Data Quality Summary</h2>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                {[
                  { label: 'Total Rows', value: analytics.total.toLocaleString() },
                  { label: 'Total Columns', value: dataset.headers.length },
                  { label: 'Duplicate Rows', value: analytics.dupes },
                  { label: 'Missing Values', value: `${analytics.missingPct}%` },
                  { label: 'Quality Score', value: `${analytics.qualityScore}/100` },
                ].map(({ label, value }) => (
                  <div key={label} className={`${cardClass} rounded-xl p-4 text-center`}>
                    <p className={`text-xs mb-1 ${config.theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>{label}</p>
                    <p className="text-xl font-bold">{value}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* SECTION: Charts */}
            {analytics.chartData.length > 0 && selectedCharts.length > 0 && (
              <section className="mb-12">
                <h2 className="text-2xl font-bold mb-6 pb-2 border-b" style={{ borderColor: accentColor, color: accentColor }}>Dashboard Charts</h2>
                <div className="grid grid-cols-2 gap-6">
                  {selectedCharts.includes('bar') && (
                    <div className={`${cardClass} rounded-xl p-4`}>
                      <p className={`text-sm font-semibold mb-3 ${config.theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                        {analytics.numCol} by {analytics.catCol} — Bar Chart
                      </p>
                      <ResponsiveContainer width="100%" height={200}>
                        <BarChart data={analytics.chartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke={config.theme === 'light' ? '#e5e7eb' : '#374151'} />
                          <XAxis dataKey="name" tick={{ fontSize: 10, fill: config.theme === 'light' ? '#4b5563' : '#9ca3af' }} />
                          <YAxis tick={{ fontSize: 10, fill: config.theme === 'light' ? '#4b5563' : '#9ca3af' }} />
                          <Tooltip />
                          <Bar dataKey="value" fill={accentColor} radius={[4, 4, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  {selectedCharts.includes('pie') && (
                    <div className={`${cardClass} rounded-xl p-4`}>
                      <p className={`text-sm font-semibold mb-3 ${config.theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                        {analytics.catCol} Distribution — Pie Chart
                      </p>
                      <ResponsiveContainer width="100%" height={200}>
                        <PieChart>
                          <Pie data={analytics.chartData.slice(0, 6)} dataKey="value" nameKey="name" outerRadius={80} label={({ name }) => name}>
                            {analytics.chartData.slice(0, 6).map((_, i) => (
                              <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  {selectedCharts.includes('line') && (
                    <div className={`${cardClass} rounded-xl p-4`}>
                      <p className={`text-sm font-semibold mb-3 ${config.theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                        {analytics.numCol} Trend — Line Chart
                      </p>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={analytics.chartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke={config.theme === 'light' ? '#e5e7eb' : '#374151'} />
                          <XAxis dataKey="name" tick={{ fontSize: 10, fill: config.theme === 'light' ? '#4b5563' : '#9ca3af' }} />
                          <YAxis tick={{ fontSize: 10, fill: config.theme === 'light' ? '#4b5563' : '#9ca3af' }} />
                          <Tooltip />
                          <Line type="monotone" dataKey="value" stroke={accentColor} strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  {selectedCharts.includes('area') && (
                    <div className={`${cardClass} rounded-xl p-4`}>
                      <p className={`text-sm font-semibold mb-3 ${config.theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                        {analytics.numCol} Area — Area Chart
                      </p>
                      <ResponsiveContainer width="100%" height={200}>
                        <AreaChart data={analytics.chartData}>
                          <defs>
                            <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={accentColor} stopOpacity={0.3} />
                              <stop offset="95%" stopColor={accentColor} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke={config.theme === 'light' ? '#e5e7eb' : '#374151'} />
                          <XAxis dataKey="name" tick={{ fontSize: 10, fill: config.theme === 'light' ? '#4b5563' : '#9ca3af' }} />
                          <YAxis tick={{ fontSize: 10, fill: config.theme === 'light' ? '#4b5563' : '#9ca3af' }} />
                          <Tooltip />
                          <Area type="monotone" dataKey="value" stroke={accentColor} fill="url(#areaGrad)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>
              </section>
            )}

            {/* SECTION: Statistical Summary */}
            {analytics.stats.length > 0 && (
              <section className="mb-12">
                <h2 className="text-2xl font-bold mb-4 pb-2 border-b" style={{ borderColor: accentColor, color: accentColor }}>Statistical Summary</h2>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className={tableHeadClass}>
                        {['Column', 'Mean', 'Median', 'Mode', 'Min', 'Max', 'Std Dev'].map(h => (
                          <th key={h} className={`p-3 text-left font-semibold border ${config.theme === 'light' ? 'border-gray-200' : 'border-gray-700'}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {analytics.stats.map(s => (
                        <tr key={s.col} className={`border-b ${tableRowClass}`}>
                          <td className={`p-3 font-medium border ${config.theme === 'light' ? 'border-gray-200' : 'border-gray-700'}`}>{s.col}</td>
                          {[s.mean, s.median, undefined, s.min, s.max, s.stdDev].map((v, i) => (
                            <td key={i} className={`p-3 border ${config.theme === 'light' ? 'border-gray-200' : 'border-gray-700'}`}>
                              {i === 2 ? s.mode : (v !== undefined ? fmt(v) : '—')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* SECTION: Business Highlights */}
            <section className="mb-12">
              <h2 className="text-2xl font-bold mb-4 pb-2 border-b" style={{ borderColor: accentColor, color: accentColor }}>Business Highlights</h2>
              <div className="grid grid-cols-2 gap-4">
                {analytics.chartData.slice(0, 4).map((d, i) => (
                  <div key={i} className={`${cardClass} rounded-xl p-4 flex items-center gap-4`}>
                    <div className="text-2xl">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '📊'}</div>
                    <div>
                      <p className={`text-xs ${config.theme === 'light' ? 'text-gray-500' : 'text-gray-400'}`}>{analytics.catCol}</p>
                      <p className="font-bold text-base">{d.name}</p>
                      <p className="text-sm" style={{ color: accentColor }}>{analytics.numCol}: {fmt(d.value)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* SECTION: Data Dictionary */}
            <section className="mb-12">
              <h2 className="text-2xl font-bold mb-4 pb-2 border-b" style={{ borderColor: accentColor, color: accentColor }}>Data Dictionary</h2>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className={tableHeadClass}>
                    {['Column Name', 'Data Type', 'Unique Values', 'Missing Values', '% Missing'].map(h => (
                      <th key={h} className={`p-3 text-left font-semibold border ${config.theme === 'light' ? 'border-gray-200' : 'border-gray-700'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {analytics.dictionary.map((d, i) => (
                    <tr key={i} className={`border-b ${tableRowClass}`}>
                      <td className={`p-3 font-medium border ${config.theme === 'light' ? 'border-gray-200' : 'border-gray-700'}`}>{d.name}</td>
                      <td className={`p-3 border capitalize ${config.theme === 'light' ? 'border-gray-200 text-emerald-700' : 'border-gray-700 text-emerald-400'}`}>{d.type}</td>
                      <td className={`p-3 border ${config.theme === 'light' ? 'border-gray-200' : 'border-gray-700'}`}>{d.unique.toLocaleString()}</td>
                      <td className={`p-3 border ${config.theme === 'light' ? 'border-gray-200 text-rose-600' : 'border-gray-700 text-rose-400'}`}>{d.missing}</td>
                      <td className={`p-3 border ${config.theme === 'light' ? 'border-gray-200 text-rose-600' : 'border-gray-700 text-rose-400'}`}>{d.missingPct}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            {/* CONCLUSION */}
            <section className="mb-12">
              <h2 className="text-2xl font-bold mb-4 pb-2 border-b" style={{ borderColor: accentColor, color: accentColor }}>Conclusion</h2>
              <p className={`text-sm leading-relaxed ${config.theme === 'light' ? 'text-gray-700' : 'text-gray-300'}`}>
                This report was automatically generated from the dataset <strong>{dataset.fileName}</strong> containing {analytics.total.toLocaleString()} records and {dataset.headers.length} columns.
                A data quality score of <strong>{analytics.qualityScore}/100</strong> was computed based on completeness and uniqueness.
                All KPIs, statistics, and business highlights presented in this report are derived from groupby aggregations and descriptive statistical calculations — no artificial intelligence was used.
              </p>
            </section>

            {/* FOOTER */}
            <div className={`pt-4 border-t text-xs flex justify-between ${config.theme === 'light' ? 'border-gray-300 text-gray-400' : 'border-gray-700 text-gray-600'}`}>
              <span>© {new Date().getFullYear()} {config.company} · Prepared by {config.author}</span>
              <span>Generated by CLEANYTICS · {new Date().toLocaleDateString()}</span>
            </div>
          </div>
        </div>
      )}

      {/* Back button for preview */}
      {step === 'preview' && (
        <div className="no-print flex-shrink-0 bg-zinc-950 border-t border-gray-800 px-8 py-3 flex justify-between items-center">
          <button onClick={() => setStep('charts')} className="flex items-center gap-2 px-5 py-2 border border-gray-700 text-gray-300 rounded-lg hover:border-gray-500 transition-colors text-sm">
            <ChevronLeft size={16}/> Back to Charts
          </button>
          <p className="text-xs text-gray-500">Use browser print dialog to save as PDF. Choose "Save as PDF" as destination.</p>
        </div>
      )}

      {/* ─── Print Styles ─── */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          .no-print { display: none !important; }
          body { margin: 0; }
          #report-preview, .printable-report {
            overflow: visible !important;
            height: auto !important;
          }
        }
      `}} />
    </div>
  );
}
