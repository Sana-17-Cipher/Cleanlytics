'use client';

import React, { useMemo } from 'react';
import {
  Activity, AlertTriangle, ArrowRight, BarChart3,
  Calendar, CheckCircle2, Database, Hash, Layers,
  ShieldCheck, Tag, TrendingUp, Type, Zap,
} from 'lucide-react';
import type {
  SemanticProfile, QualitySuggestion, TransformationSuggestion,
  MeasureRecommendation, TransformationEntry,
} from '../utils/profiler';
import { Dataset } from '../utils/parser';

interface OverviewModuleProps {
  dataset: Dataset;
  profile: SemanticProfile | null;
  qualitySuggestions: QualitySuggestion[];
  transformSuggestions: TransformationSuggestion[];
  measureRecommendations: MeasureRecommendation[];
  transformHistory: TransformationEntry[];
  onNavigate: (module: string) => void;
  onApplySuggestion: (suggestion: QualitySuggestion | TransformationSuggestion) => void;
  isProfileLoading: boolean;
}

/* ─── Helpers ─────────────────────────────────────────────────────── */

const ROLE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  measure:    { bg: 'bg-emerald-950/40', text: 'text-emerald-400', border: 'border-emerald-800/30' },
  dimension:  { bg: 'bg-cyan-950/40',    text: 'text-cyan-400',    border: 'border-cyan-800/30' },
  time:       { bg: 'bg-amber-950/40',   text: 'text-amber-400',   border: 'border-amber-800/30' },
  id:         { bg: 'bg-gray-900/40',    text: 'text-gray-400',    border: 'border-gray-800/30' },
  geographic: { bg: 'bg-violet-950/40',  text: 'text-violet-400',  border: 'border-violet-800/30' },
  category:   { bg: 'bg-blue-950/40',    text: 'text-blue-400',    border: 'border-blue-800/30' },
  boolean:    { bg: 'bg-pink-950/40',    text: 'text-pink-400',    border: 'border-pink-800/30' },
  text:       { bg: 'bg-gray-900/40',    text: 'text-gray-400',    border: 'border-gray-800/30' },
};

const ROLE_ICONS: Record<string, any> = {
  measure:    TrendingUp,
  dimension:  Tag,
  time:       Calendar,
  id:         Hash,
  geographic: Database,
  category:   Layers,
  boolean:    Activity,
  text:       Type,
};

const SEVERITY_COLORS: Record<string, string> = {
  high:   'text-red-400 bg-red-950/30 border-red-900/30',
  medium: 'text-amber-400 bg-amber-950/30 border-amber-900/30',
  low:    'text-gray-400 bg-zinc-900/30 border-gray-800/30',
};

const TIER_LABELS: Record<string, { label: string; color: string }> = {
  A: { label: 'Safe to auto-apply', color: 'text-emerald-400' },
  B: { label: 'Recommended', color: 'text-cyan-400' },
  C: { label: 'Review carefully', color: 'text-amber-400' },
};

/* ─── Component ───────────────────────────────────────────────────── */

export default function OverviewModule({
  dataset,
  profile,
  qualitySuggestions,
  transformSuggestions,
  measureRecommendations,
  transformHistory,
  onNavigate,
  onApplySuggestion,
  isProfileLoading,
}: OverviewModuleProps) {

  const summary = profile?.summary;
  const columns = profile?.columns || [];

  // Group columns by semantic role
  const roleGroups = useMemo(() => {
    const groups: Record<string, typeof columns> = {};
    columns.forEach(col => {
      const role = col.semantic_role || 'text';
      if (!groups[role]) groups[role] = [];
      groups[role].push(col);
    });
    return groups;
  }, [columns]);

  // Top quality issues (max 5)
  const topIssues = qualitySuggestions.slice(0, 5);

  // Top transform suggestions (max 4)
  const topTransforms = transformSuggestions.slice(0, 4);

  // Top measure recommendations (max 4)
  const topMeasures = measureRecommendations.slice(0, 4);

  if (isProfileLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 animate-fade-in">
        <div className="h-12 w-12 rounded-xl bg-cyan-950/40 border border-cyan-800/30 flex items-center justify-center mb-4 animate-pulse">
          <Zap className="h-6 w-6 text-cyan-400" />
        </div>
        <p className="text-sm font-semibold text-gray-300">Analyzing dataset structure...</p>
        <p className="text-xs text-gray-500 mt-1">Detecting column types, semantic roles, and quality issues</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ═══════ Header ═══════ */}
      <div>
        <h2 className="text-xl font-bold tracking-tight text-white">Dataset Overview</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Semantic analysis of <span className="text-gray-400 font-medium">{dataset.fileName}</span>
        </p>
      </div>

      {/* ═══════ Summary Cards ═══════ */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {/* Rows */}
        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Records</p>
          <p className="text-xl font-extrabold text-white font-mono">{(summary?.rows || dataset.rows.length).toLocaleString()}</p>
          <p className="text-[10px] text-gray-500">{summary?.columns || dataset.headers.length} columns</p>
        </div>

        {/* Quality Score */}
        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Quality Score</p>
          <p className={`text-xl font-extrabold font-mono ${
            (summary?.quality_score || 0) >= 90 ? 'text-emerald-400' :
            (summary?.quality_score || 0) >= 70 ? 'text-amber-400' : 'text-red-400'
          }`}>
            {summary?.quality_score || 0}%
          </p>
          <p className="text-[10px] text-gray-500">
            {summary?.total_missing || 0} missing values
          </p>
        </div>

        {/* Measures */}
        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Measures</p>
          <p className="text-xl font-extrabold text-emerald-400 font-mono">{summary?.measure_count || 0}</p>
          <p className="text-[10px] text-gray-500">Summable / aggregatable</p>
        </div>

        {/* Dimensions */}
        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Dimensions</p>
          <p className="text-xl font-extrabold text-cyan-400 font-mono">{summary?.dimension_count || 0}</p>
          <p className="text-[10px] text-gray-500">Categories & descriptors</p>
        </div>

        {/* Time Fields */}
        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Time Fields</p>
          <p className="text-xl font-extrabold text-amber-400 font-mono">{summary?.time_count || 0}</p>
          <p className="text-[10px] text-gray-500">
            {summary?.duplicate_rows ? `${summary.duplicate_rows} duplicates` : 'No duplicates'}
          </p>
        </div>
      </div>

      {/* ═══════ Two-Column Layout ═══════ */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">

        {/* Left Column — Semantic Structure */}
        <div className="xl:col-span-2 space-y-5">

          {/* Semantic Structure */}
          <div className="glass-panel rounded-xl border border-gray-800/40 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800/50 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Layers className="h-4 w-4 text-cyan-400" />
                  Semantic Structure
                </h3>
                <p className="text-[10px] text-gray-500 mt-0.5">How CLEANYTICS understands each column</p>
              </div>
              <button
                onClick={() => onNavigate('transform')}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 transition"
              >
                Edit Model <ArrowRight className="h-3 w-3" />
              </button>
            </div>

            <div className="p-4 space-y-2">
              {Object.entries(roleGroups).map(([role, cols]) => {
                const color = ROLE_COLORS[role] || ROLE_COLORS.text;
                const RoleIcon = ROLE_ICONS[role] || Type;
                return (
                  <div key={role} className="space-y-1.5">
                    <div className="flex items-center gap-2 mb-1">
                      <RoleIcon className={`h-3.5 w-3.5 ${color.text}`} />
                      <span className={`text-[10px] font-bold uppercase tracking-wider ${color.text}`}>
                        {role}s ({cols.length})
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {cols.map(col => (
                        <div
                          key={col.name}
                          className={`px-2.5 py-1.5 rounded-lg text-[11px] font-medium border ${color.bg} ${color.text} ${color.border} flex items-center gap-1.5`}
                          title={`${col.detected_type} · ${col.aggregation_behavior} · ${Math.round(col.confidence * 100)}% confidence`}
                        >
                          <span>{col.name}</span>
                          <span className="text-[8px] opacity-60 font-mono">
                            {col.aggregation_behavior !== 'NONE' ? col.aggregation_behavior : col.detected_type}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recommended Measures */}
          {topMeasures.length > 0 && (
            <div className="glass-panel rounded-xl border border-gray-800/40 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-800/50 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-emerald-400" />
                  Recommended Measures
                </h3>
                <button
                  onClick={() => onNavigate('transform')}
                  className="text-[10px] text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 transition"
                >
                  View All <ArrowRight className="h-3 w-3" />
                </button>
              </div>
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {topMeasures.map(m => (
                  <div
                    key={m.id}
                    className="p-3 rounded-lg border border-gray-800/40 bg-zinc-900/20 hover:border-emerald-800/30 transition space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white">{m.name}</span>
                      <span className="text-[9px] font-mono text-emerald-400 bg-emerald-950/30 px-1.5 py-0.5 rounded border border-emerald-900/30">
                        {m.aggregation}
                      </span>
                    </div>
                    <p className="text-[10px] text-gray-400 font-mono">{m.formula}</p>
                    <p className="text-[10px] text-gray-500 leading-relaxed">{m.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transformation Suggestions */}
          {topTransforms.length > 0 && (
            <div className="glass-panel rounded-xl border border-gray-800/40 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-800/50 flex items-center justify-between">
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Zap className="h-4 w-4 text-violet-400" />
                  Suggested Transformations
                </h3>
                <button
                  onClick={() => onNavigate('transform')}
                  className="text-[10px] text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 transition"
                >
                  View All <ArrowRight className="h-3 w-3" />
                </button>
              </div>
              <div className="p-4 space-y-2">
                {topTransforms.map(s => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-gray-800/40 bg-zinc-900/20 hover:border-violet-800/30 transition group"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-white">{s.name}</p>
                      <p className="text-[10px] text-gray-500 mt-0.5">{s.reason}</p>
                    </div>
                    <button
                      onClick={() => onApplySuggestion(s as any)}
                      className="px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-violet-950/40 text-violet-400 border border-violet-800/30 hover:bg-violet-900/40 transition opacity-0 group-hover:opacity-100 shrink-0 ml-3"
                    >
                      Apply
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right Column — Quality & Actions */}
        <div className="space-y-5">

          {/* Attention Required */}
          <div className="glass-panel rounded-xl border border-gray-800/40 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-800/50 flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                Attention Required
              </h3>
              {topIssues.length > 0 && (
                <span className="text-[9px] font-bold text-amber-400 bg-amber-950/30 px-1.5 py-0.5 rounded border border-amber-900/30">
                  {qualitySuggestions.length} issues
                </span>
              )}
            </div>

            <div className="p-3 space-y-2 max-h-[360px] overflow-y-auto">
              {topIssues.length === 0 ? (
                <div className="text-center py-8">
                  <CheckCircle2 className="h-8 w-8 text-emerald-400 mx-auto mb-2" />
                  <p className="text-xs text-gray-400 font-medium">No critical issues detected</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Dataset quality looks good</p>
                </div>
              ) : (
                topIssues.map(issue => {
                  const tier = TIER_LABELS[issue.risk_tier];
                  return (
                    <div
                      key={issue.id}
                      className={`p-3 rounded-lg border ${SEVERITY_COLORS[issue.severity]} space-y-2 group`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-[11px] font-semibold leading-snug">{issue.description}</p>
                          <p className="text-[10px] opacity-70 mt-1">{issue.recommendation}</p>
                        </div>
                        <span className={`text-[8px] font-bold shrink-0 ${tier.color}`}>
                          {issue.risk_tier}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] opacity-50">{tier.label}</span>
                        <button
                          onClick={() => onApplySuggestion(issue as any)}
                          className="px-2.5 py-1 rounded text-[9px] font-semibold bg-zinc-900/60 border border-gray-700/40 hover:bg-zinc-800 hover:text-white text-gray-400 transition opacity-0 group-hover:opacity-100"
                        >
                          Apply Fix
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {qualitySuggestions.length > 5 && (
              <div className="px-5 py-3 border-t border-gray-800/50">
                <button
                  onClick={() => onNavigate('cleaning')}
                  className="w-full text-[10px] text-cyan-400 hover:text-cyan-300 font-semibold flex items-center justify-center gap-1 transition"
                >
                  View all {qualitySuggestions.length} issues <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>

          {/* Next Steps / Guided Actions */}
          <div className="glass-panel rounded-xl border border-gray-800/40 p-5 space-y-3">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <ArrowRight className="h-4 w-4 text-cyan-400" />
              Next Steps
            </h3>

            <div className="space-y-2">
              {qualitySuggestions.length > 0 && (
                <button
                  onClick={() => onNavigate('cleaning')}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-800/40 bg-zinc-900/20 hover:border-cyan-800/30 hover:bg-cyan-950/10 transition text-xs group flex items-center justify-between"
                >
                  <div>
                    <p className="font-semibold text-gray-200">Review quality issues</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">{qualitySuggestions.length} issues detected</p>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-gray-600 group-hover:text-cyan-400 transition" />
                </button>
              )}

              {transformSuggestions.length > 0 && (
                <button
                  onClick={() => onNavigate('transform')}
                  className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-800/40 bg-zinc-900/20 hover:border-cyan-800/30 hover:bg-cyan-950/10 transition text-xs group flex items-center justify-between"
                >
                  <div>
                    <p className="font-semibold text-gray-200">Apply transformations</p>
                    <p className="text-[10px] text-gray-500 mt-0.5">{transformSuggestions.length} suggestions available</p>
                  </div>
                  <ArrowRight className="h-3.5 w-3.5 text-gray-600 group-hover:text-cyan-400 transition" />
                </button>
              )}

              <button
                onClick={() => onNavigate('dashboard')}
                className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-800/40 bg-zinc-900/20 hover:border-cyan-800/30 hover:bg-cyan-950/10 transition text-xs group flex items-center justify-between"
              >
                <div>
                  <p className="font-semibold text-gray-200">Build dashboard</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">Auto-generate visualizations from semantic model</p>
                </div>
                <ArrowRight className="h-3.5 w-3.5 text-gray-600 group-hover:text-cyan-400 transition" />
              </button>
            </div>
          </div>

          {/* Recent Changes */}
          {transformHistory.length > 0 && (
            <div className="glass-panel rounded-xl border border-gray-800/40 p-5 space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Activity className="h-4 w-4 text-emerald-400" />
                Recent Changes
              </h3>
              <div className="space-y-1.5 max-h-[150px] overflow-y-auto">
                {transformHistory.slice(-5).reverse().map(entry => (
                  <div key={entry.id} className="flex items-start gap-2 text-[10px]">
                    <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-gray-300 font-medium leading-snug">{entry.description}</p>
                      <p className="text-gray-600 font-mono mt-0.5">
                        {entry.source === 'suggestion' ? 'Auto-suggestion' : 'Manual'}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
