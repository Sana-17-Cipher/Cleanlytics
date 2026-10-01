'use client';

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, ChevronDown, ChevronRight, Info, Table2 } from 'lucide-react';

import {
  ADDITIVITY_NOTE, ROLE_STYLE, compact, count, exact,
  logicalTypeLabel, percent, qualityTone,
} from '../lib/format';
import type { ColumnProfile, TableDetail } from '../lib/types';

interface OverviewModuleProps {
  table: TableDetail;
  onNavigate: (screen: string) => void;
}

/**
 * The analysis screen.
 *
 * Two things it does that the previous version did not: it shows the quality
 * score broken into the four things that produced it, and it explains why each
 * column was classified the way it was. A number nobody can interrogate is not
 * analysis, it is decoration.
 */
export default function OverviewModule({ table, onNavigate }: OverviewModuleProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const profile = table.profile;
  const summary = profile?.summary;

  const grouped = useMemo(() => {
    const groups = new Map<string, ColumnProfile[]>();
    (profile?.columns ?? []).forEach((column) => {
      const list = groups.get(column.semantic_role) ?? [];
      list.push(column);
      groups.set(column.semantic_role, list);
    });
    return groups;
  }, [profile]);

  if (!profile || !summary) {
    return (
      <div className="glass-panel rounded-xl p-10 text-center text-sm text-gray-400">
        This table has not been analysed yet.
      </div>
    );
  }

  const findings = table.quality?.findings ?? [];
  const components = summary.quality_components;
  const weights = summary.quality_weights;

  const componentRows = [
    { key: 'completeness', label: 'Completeness', detail: 'How much of the data is actually filled in' },
    { key: 'uniqueness', label: 'Uniqueness', detail: 'How free the table is of repeated rows' },
    { key: 'consistency', label: 'Consistency', detail: 'Whether the same value is always written the same way' },
    { key: 'validity', label: 'Validity', detail: 'Whether values match the kind of data the column holds' },
  ] as const;

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">{table.table_name}</h2>
          <p className="text-xs text-gray-400 mt-1">
            {count(summary.rows)} rows · {summary.columns} columns · from {table.source_file}
            {table.source_sheet ? ` (sheet “${table.source_sheet}”)` : ''}
          </p>
        </div>
        <button
          onClick={() => onNavigate('data')}
          className="px-3 py-1.5 rounded-lg border border-gray-800 bg-zinc-900/60 text-gray-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 shrink-0"
        >
          <Table2 className="h-3.5 w-3.5" /> View rows
        </button>
      </div>

      {/* Headline figures */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="Rows" value={count(summary.rows)} sub={`${summary.columns} columns`} />
        <Stat
          label="Quality"
          value={`${summary.quality_score}%`}
          sub="weighted across four checks"
          tone={qualityTone(summary.quality_score)}
        />
        <Stat
          label="Missing"
          value={count(summary.total_missing)}
          sub={`of ${count(summary.total_cells)} cells`}
        />
        <Stat
          label="Duplicate rows"
          value={summary.duplicate_rows_measured ? count(summary.duplicate_rows) : 'not checked'}
          sub={summary.duplicate_rows_measured ? 'exact matches across all columns' : 'table too large to check'}
        />
        <Stat
          label="Measures"
          value={String(summary.measure_count)}
          sub={`${summary.dimension_count} to group by · ${summary.time_count} date`}
        />
      </div>

      {/* Quality breakdown: the score, and what produced it */}
      <div className="glass-panel rounded-xl border border-gray-800/60 p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">How the quality score is made up</h3>
          <span className={`text-lg font-extrabold font-mono ${qualityTone(summary.quality_score)}`}>
            {summary.quality_score}%
          </span>
        </div>
        <div className="space-y-2">
          {componentRows.map(({ key, label, detail }) => {
            const value = components[key];
            return (
              <div key={key} className="flex items-center gap-3">
                <span className="text-[11px] text-gray-300 w-28 shrink-0">{label}</span>
                <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${value >= 95 ? 'bg-emerald-500' : value >= 80 ? 'bg-cyan-500' : value >= 60 ? 'bg-amber-500' : 'bg-red-500'}`}
                    style={{ width: `${Math.max(value, 0)}%` }}
                  />
                </div>
                <span className="text-[11px] font-mono text-gray-300 w-12 text-right shrink-0">
                  {value}%
                </span>
                <span className="text-[10px] text-gray-500 w-20 text-right shrink-0 font-mono">
                  {Math.round(weights[key] * 100)}% weight
                </span>
                <span className="text-[10px] text-gray-500 hidden xl:block flex-1">{detail}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Findings */}
      {findings.length > 0 && (
        <button
          onClick={() => onNavigate('clean')}
          className="w-full glass-panel rounded-xl border border-amber-900/40 bg-amber-950/10 p-4 flex items-center justify-between hover:border-amber-800/60 transition text-left"
        >
          <div className="flex items-center gap-3 min-w-0">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-bold text-white">
                {findings.length} thing{findings.length === 1 ? '' : 's'} worth looking at
              </p>
              <p className="text-[11px] text-gray-400 truncate">
                {findings.slice(0, 2).map((f) => f.title).join(' · ')}
                {findings.length > 2 ? ` · and ${findings.length - 2} more` : ''}
              </p>
            </div>
          </div>
          <ArrowRight className="h-4 w-4 text-gray-500 shrink-0" />
        </button>
      )}

      {/* Columns, grouped by what they mean */}
      <div className="glass-panel rounded-xl border border-gray-800/60 overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-800/60">
          <h3 className="text-sm font-bold text-white">Columns</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">
            Grouped by what each one is for. Click any column to see why it was read that way.
          </p>
        </div>

        <div className="divide-y divide-gray-800/40">
          {[...grouped.entries()].map(([role, columns]) => (
            <div key={role}>
              <div className="px-5 py-2 bg-zinc-900/30">
                <span className={`text-[10px] font-bold uppercase tracking-wider ${ROLE_STYLE[columns[0].semantic_role].text}`}>
                  {ROLE_STYLE[columns[0].semantic_role].plural} ({columns.length})
                </span>
              </div>
              {columns.map((column) => (
                <ColumnRow
                  key={column.name}
                  column={column}
                  open={expanded === column.name}
                  onToggle={() => setExpanded(expanded === column.name ? null : column.name)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({
  label, value, sub, tone,
}: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className="glass-panel p-4 rounded-xl">
      <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-extrabold font-mono mt-1 ${tone ?? 'text-white'}`}>{value}</p>
      <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>
    </div>
  );
}

function ColumnRow({
  column, open, onToggle,
}: { column: ColumnProfile; open: boolean; onToggle: () => void }) {
  const style = ROLE_STYLE[column.semantic_role];
  const stats = column.statistics;
  const isNumeric = stats.mean != null || stats.median != null;

  return (
    <div className="px-5 py-3 hover:bg-zinc-900/20 transition">
      <button onClick={onToggle} className="w-full flex items-center gap-3 text-left">
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-gray-600 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-gray-600 shrink-0" />
        )}

        <span className="text-xs font-semibold text-gray-100 truncate w-48 shrink-0">{column.name}</span>

        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${style.bg} ${style.text} ${style.border}`}>
          {logicalTypeLabel(column.logical_type)}
          {column.subtype ? ` · ${column.subtype}` : ''}
        </span>

        <span className="text-[10px] text-gray-500 font-mono shrink-0">
          {column.distinct_is_approximate ? '≈' : ''}
          {count(column.distinct_count)} distinct
        </span>

        {column.null_count > 0 && (
          <span className="text-[10px] text-amber-400/80 font-mono shrink-0">
            {percent(column.null_ratio)} blank
          </span>
        )}

        {column.is_unique && column.distinct_count > 1 && (
          <span className="text-[9px] text-emerald-400 font-bold shrink-0">unique</span>
        )}

        <span className="flex-1" />

        {isNumeric ? (
          <span className="text-[10px] text-gray-400 font-mono shrink-0 hidden lg:block">
            median {compact(stats.median)} · avg {compact(stats.mean)}
          </span>
        ) : column.top_values.length > 0 ? (
          <span className="text-[10px] text-gray-400 shrink-0 truncate max-w-[220px] hidden lg:block">
            most common: {column.top_values[0].value} ({percent(column.top_values[0].share, 0)})
          </span>
        ) : null}
      </button>

      {open && (
        <div className="mt-3 ml-7 space-y-3 pb-1">
          {/* Why it was classified this way */}
          <div className="flex items-start gap-2 text-[11px] text-gray-400 bg-zinc-900/40 border border-gray-800/50 rounded-lg px-3 py-2">
            <Info className="h-3.5 w-3.5 text-cyan-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>
                Read as a <span className={style.text}>{style.label.toLowerCase()}</span>, aggregated by
                default with <span className="font-mono text-gray-200">{column.default_aggregation.replace('_', ' ')}</span>
                {' '}({Math.round(column.confidence * 100)}% confident).
              </p>
              {column.reasons.map((reason) => (
                <p key={reason} className="text-gray-500">· {reason}</p>
              ))}
              {ADDITIVITY_NOTE[column.additivity] && (
                <p className="text-amber-400/80">· {ADDITIVITY_NOTE[column.additivity]}</p>
              )}
            </div>
          </div>

          {/* Numeric spread */}
          {isNumeric &&
  typeof stats.min === 'number' &&
  typeof stats.max === 'number' &&
  stats.q1 != null &&
  stats.q3 != null && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Spread</p>
              <Spread
                min={stats.min ?? 0}
                p05={stats.p05 ?? 0}
                q1={stats.q1}
                median={stats.median ?? 0}
                q3={stats.q3}
                p95={stats.p95 ?? 0}
                max={stats.max ?? 0}
              />
              <div className="flex justify-between text-[10px] text-gray-500 font-mono">
                <span>min {exact(stats.min)}</span>
                <span>q1 {exact(stats.q1)}</span>
                <span>median {exact(stats.median)}</span>
                <span>q3 {exact(stats.q3)}</span>
                <span>max {exact(stats.max)}</span>
              </div>
              {stats.std_dev != null && (
                <p className="text-[10px] text-gray-500">
                  Standard deviation {exact(stats.std_dev)}
                  {stats.zero_count ? ` · ${count(stats.zero_count)} zeros` : ''}
                  {stats.negative_count ? ` · ${count(stats.negative_count)} negative` : ''}
                </p>
              )}
            </div>
          )}

          {/* Top values */}
          {!isNumeric && column.top_values.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">
                Most common values
              </p>
              <div className="space-y-1">
                {column.top_values.slice(0, 6).map((entry) => (
                  <div key={entry.value} className="flex items-center gap-2 text-[11px]">
                    <span className="text-gray-300 truncate w-48 shrink-0">{entry.value}</span>
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div className="h-full bg-cyan-600/70 rounded-full" style={{ width: `${entry.share * 100}%` }} />
                    </div>
                    <span className="text-gray-500 font-mono w-24 text-right shrink-0">
                      {count(entry.count)} ({percent(entry.share, 0)})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Text hygiene */}
          {(stats.whitespace_count || stats.case_variant_count || stats.blank_count) ? (
            <p className="text-[10px] text-amber-400/80">
              {stats.whitespace_count ? `${count(stats.whitespace_count)} padded · ` : ''}
              {stats.case_variant_count ? `${count(stats.case_variant_count)} differ only by capitalisation · ` : ''}
              {stats.blank_count ? `${count(stats.blank_count)} empty strings` : ''}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * A compact box plot: the middle half of the values as a solid bar, the 5th to
 * 95th percentile as a line, and the median marked. Shows at a glance whether a
 * column is evenly spread or dragged around by a handful of extremes.
 */
function Spread({
  min, p05, q1, median, q3, p95, max,
}: { min: number; p05: number; q1: number; median: number; q3: number; p95: number; max: number }) {
  const lo = Math.min(min, p05);
  const hi = Math.max(max, p95);
  const span = hi - lo || 1;
  const at = (value: number) => `${((value - lo) / span) * 100}%`;

  return (
    <div className="relative h-6 w-full">
      <div className="absolute top-1/2 -translate-y-1/2 h-px bg-gray-700 w-full" />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-px bg-gray-500"
        style={{ left: at(p05), width: `${((p95 - p05) / span) * 100}%` }}
      />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-3 rounded-sm bg-cyan-900/70 border border-cyan-700/60"
        style={{ left: at(q1), width: `${((q3 - q1) / span) * 100}%` }}
      />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-4 w-0.5 bg-cyan-300"
        style={{ left: at(median) }}
      />
    </div>
  );
}
