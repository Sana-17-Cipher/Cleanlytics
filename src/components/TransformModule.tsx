'use client';

import React, { useMemo, useState } from 'react';
import { Check, Loader2, Plus, Sigma, Trash2, TriangleAlert } from 'lucide-react';

import { ApiError, api } from '../lib/api';
import { count } from '../lib/format';
import type { Aggregation, ColumnSummary, OperationOutcome, TableDetail } from '../lib/types';

interface TransformModuleProps {
  projectId: number;
  table: TableDetail;
  onTableChanged: (table: TableDetail) => void;
  onHistoryChanged: () => void;
}

type Tab = 'derive' | 'calculate' | 'text' | 'summarise';

const AGGREGATIONS: { value: Aggregation; label: string }[] = [
  { value: 'sum', label: 'Total' },
  { value: 'avg', label: 'Average' },
  { value: 'median', label: 'Median' },
  { value: 'min', label: 'Lowest' },
  { value: 'max', label: 'Highest' },
  { value: 'count', label: 'Count of rows' },
  { value: 'count_distinct', label: 'Count of distinct values' },
];

const DATE_PARTS = [
  { value: 'year', label: 'Year' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'month', label: 'Month (2024-03)' },
  { value: 'month_name', label: 'Month name' },
  { value: 'day_of_week', label: 'Day of week' },
  { value: 'week', label: 'Week' },
];

/**
 * Reshaping the data.
 *
 * Every operation runs on the server against the stored table, so the result
 * is what gets saved. The old version computed a preview in the browser with
 * one implementation and applied the change with a different one in Python,
 * so the preview and the result routinely disagreed: group-by previewed
 * "SUM_of_Sales" and produced "Sales_sum", merging showed blanks where the
 * result had the text "nan", and dividing by zero previewed nothing where the
 * result was infinity.
 */
export default function TransformModule({
  projectId, table, onTableChanged, onHistoryChanged,
}: TransformModuleProps) {
  const [tab, setTab] = useState<Tab>('derive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OperationOutcome | null>(null);

  const columns = table.columns;
  const dateColumns = useMemo(
    () => columns.filter((c) => c.semantic_role === 'time' || c.logical_type === 'date' || c.logical_type === 'datetime'),
    [columns],
  );
  const numericColumns = useMemo(
    () => columns.filter((c) => ['integer', 'decimal', 'currency', 'percentage'].includes(c.logical_type)),
    [columns],
  );
  const groupableColumns = useMemo(
    () => columns.filter((c) => ['category', 'dimension', 'geographic', 'boolean', 'time', 'identifier'].includes(c.semantic_role)),
    [columns],
  );

  const run = async (operation: string, params: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const response = await api.applyOperation(projectId, table.id, operation, params);
      setOutcome(response.result);
      onTableChanged(response.table);
      onHistoryChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That change could not be applied.');
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: Tab; label: string; enabled: boolean; hint: string }[] = [
    { id: 'derive', label: 'Date parts', enabled: dateColumns.length > 0, hint: 'needs a date column' },
    { id: 'calculate', label: 'Calculate', enabled: numericColumns.length >= 1, hint: 'needs a number column' },
    { id: 'text', label: 'Split & combine', enabled: columns.length >= 1, hint: '' },
    { id: 'summarise', label: 'Summarise', enabled: groupableColumns.length > 0, hint: 'needs something to group by' },
  ];

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-white">Reshape</h2>
        <p className="text-xs text-gray-400 mt-1">
          Changes apply to {table.table_name} and are saved straight away. Undo is on the Quality screen.
        </p>
      </div>

      <div className="flex gap-1 p-1 rounded-lg bg-zinc-900/60 border border-gray-800/60 w-fit">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            onClick={() => entry.enabled && setTab(entry.id)}
            disabled={!entry.enabled}
            title={entry.enabled ? undefined : `This table ${entry.hint}`}
            className={`px-3 py-1.5 rounded-md text-[11px] font-semibold transition disabled:opacity-30 disabled:cursor-not-allowed ${
              tab === entry.id ? 'bg-cyan-950/60 text-cyan-300 border border-cyan-800/40' : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-300 text-xs">{error}</div>
      )}

      {outcome && (
        <div className="glass-panel rounded-xl border border-emerald-900/40 bg-emerald-950/10 p-4 space-y-1.5">
          <p className="text-xs font-semibold text-emerald-300 flex items-center gap-2">
            <Check className="h-4 w-4 shrink-0" /> {outcome.description}
          </p>
          <p className="text-[11px] text-gray-400 font-mono">
            {count(outcome.rows_before)} → {count(outcome.rows_after)} rows
            {outcome.columns_added.length > 0 && ` · added ${outcome.columns_added.join(', ')}`}
          </p>
          {outcome.warnings.map((warning) => (
            <p key={warning} className="text-[11px] text-amber-400 flex items-start gap-1.5">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {warning}
            </p>
          ))}
        </div>
      )}

      <div className="glass-panel rounded-xl border border-gray-800 p-5">
        {tab === 'derive' && <DerivePanel columns={dateColumns} busy={busy} onRun={run} />}
        {tab === 'calculate' && <CalculatePanel columns={numericColumns} busy={busy} onRun={run} />}
        {tab === 'text' && <TextPanel columns={columns} busy={busy} onRun={run} />}
        {tab === 'summarise' && (
          <SummarisePanel
            groupable={groupableColumns}
            numeric={numericColumns}
            all={columns}
            busy={busy}
            onRun={run}
          />
        )}
      </div>
    </div>
  );
}

type RunFn = (operation: string, params: Record<string, unknown>) => void;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold text-gray-400">{label}</span>
      {children}
    </label>
  );
}

function DerivePanel({ columns, busy, onRun }: { columns: ColumnSummary[]; busy: boolean; onRun: RunFn }) {
  const [column, setColumn] = useState(columns[0]?.name ?? '');
  const [part, setPart] = useState('month');

  return (
    <div className="space-y-4 max-w-lg">
      <p className="text-[11px] text-gray-500">
        Pull a calendar attribute out of a date so you can group by it.
      </p>
      <Field label="Date column">
        <select value={column} onChange={(e) => setColumn(e.target.value)} className="w-full glass-input text-xs">
          {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Extract">
        <select value={part} onChange={(e) => setPart(e.target.value)} className="w-full glass-input text-xs">
          {DATE_PARTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </Field>
      <ApplyButton
        busy={busy}
        disabled={!column}
        onClick={() => onRun('extract_date_part', { column, part })}
        label={`Add ${column ? `${column}_${part}` : 'column'}`}
      />
    </div>
  );
}

function CalculatePanel({ columns, busy, onRun }: { columns: ColumnSummary[]; busy: boolean; onRun: RunFn }) {
  const [left, setLeft] = useState(columns[0]?.name ?? '');
  const [right, setRight] = useState(columns[1]?.name ?? columns[0]?.name ?? '');
  const [operator, setOperator] = useState('-');
  const [name, setName] = useState('');

  const operators = [
    { value: '+', label: 'plus' },
    { value: '-', label: 'minus' },
    { value: '*', label: 'times' },
    { value: '/', label: 'divided by' },
    { value: 'percent_of', label: 'as a share of' },
  ];

  return (
    <div className="space-y-4 max-w-lg">
      <p className="text-[11px] text-gray-500">
        Build a new column from two existing ones. Dividing by zero leaves a blank rather than infinity.
      </p>
      <div className="grid grid-cols-3 gap-2">
        <Field label="First">
          <select value={left} onChange={(e) => setLeft(e.target.value)} className="w-full glass-input text-xs">
            {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Operation">
          <select value={operator} onChange={(e) => setOperator(e.target.value)} className="w-full glass-input text-xs">
            {operators.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Second">
          <select value={right} onChange={(e) => setRight(e.target.value)} className="w-full glass-input text-xs">
            {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="New column name (optional)">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${left}_${operator}_${right}`}
          className="w-full glass-input text-xs"
        />
      </Field>
      <ApplyButton
        busy={busy}
        disabled={!left || !right}
        onClick={() => onRun('calculate', { left, right, operator, new_column: name || undefined })}
        label="Add the column"
      />
    </div>
  );
}

function TextPanel({ columns, busy, onRun }: { columns: ColumnSummary[]; busy: boolean; onRun: RunFn }) {
  const [mode, setMode] = useState<'split' | 'merge'>('split');
  const [column, setColumn] = useState(columns[0]?.name ?? '');
  const [separator, setSeparator] = useState(',');
  const [targets, setTargets] = useState(['part_1', 'part_2']);
  const [selected, setSelected] = useState<string[]>([]);
  const [mergeName, setMergeName] = useState('');

  return (
    <div className="space-y-4 max-w-lg">
      <div className="flex gap-1 p-1 rounded-lg bg-zinc-900/60 border border-gray-800/60 w-fit">
        {(['split', 'merge'] as const).map((value) => (
          <button
            key={value}
            onClick={() => setMode(value)}
            className={`px-3 py-1 rounded-md text-[11px] font-semibold ${
              mode === value ? 'bg-cyan-950/60 text-cyan-300' : 'text-gray-400'
            }`}
          >
            {value === 'split' ? 'Split one column' : 'Combine columns'}
          </button>
        ))}
      </div>

      {mode === 'split' ? (
        <>
          <Field label="Column to split">
            <select value={column} onChange={(e) => setColumn(e.target.value)} className="w-full glass-input text-xs">
              {columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Split on">
            <input value={separator} onChange={(e) => setSeparator(e.target.value)} className="w-full glass-input text-xs" />
          </Field>
          <div className="space-y-2">
            <span className="text-[11px] font-semibold text-gray-400">Into these columns</span>
            {targets.map((target, index) => (
              <div key={index} className="flex gap-2">
                <input
                  value={target}
                  onChange={(e) => setTargets(targets.map((t, i) => (i === index ? e.target.value : t)))}
                  className="flex-1 glass-input text-xs"
                />
                {targets.length > 1 && (
                  <button
                    onClick={() => setTargets(targets.filter((_, i) => i !== index))}
                    className="text-gray-600 hover:text-red-400 px-1"
                    aria-label="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={() => setTargets([...targets, `part_${targets.length + 1}`])}
              className="text-[11px] text-cyan-400 flex items-center gap-1"
            >
              <Plus className="h-3 w-3" /> Add another
            </button>
          </div>
          <ApplyButton
            busy={busy}
            disabled={!column || !separator || targets.every((t) => !t.trim())}
            onClick={() => onRun('split_column', { column, separator, into: targets.filter((t) => t.trim()) })}
            label="Split the column"
          />
        </>
      ) : (
        <>
          <div className="space-y-2">
            <span className="text-[11px] font-semibold text-gray-400">Columns to combine, in order</span>
            <div className="max-h-40 overflow-y-auto border border-gray-800 rounded-lg p-2 bg-zinc-950/30 space-y-1">
              {columns.map((c) => (
                <label key={c.name} className="flex items-center gap-2 text-xs px-1.5 py-1 hover:bg-zinc-900/50 rounded cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.includes(c.name)}
                    onChange={() =>
                      setSelected(selected.includes(c.name)
                        ? selected.filter((n) => n !== c.name)
                        : [...selected, c.name])
                    }
                    className="h-3.5 w-3.5 rounded border-gray-700 bg-zinc-950"
                  />
                  <span className="text-gray-300 truncate">{c.name}</span>
                </label>
              ))}
            </div>
          </div>
          <Field label="Separator">
            <input value={separator} onChange={(e) => setSeparator(e.target.value)} className="w-full glass-input text-xs" />
          </Field>
          <Field label="New column name (optional)">
            <input
              value={mergeName}
              onChange={(e) => setMergeName(e.target.value)}
              placeholder={selected.slice(0, 3).join('_') || 'combined'}
              className="w-full glass-input text-xs"
            />
          </Field>
          <ApplyButton
            busy={busy}
            disabled={selected.length < 2}
            onClick={() => onRun('merge_columns', { columns: selected, separator, new_column: mergeName || undefined })}
            label="Combine them"
          />
        </>
      )}
    </div>
  );
}

function SummarisePanel({
  groupable, numeric, all, busy, onRun,
}: {
  groupable: ColumnSummary[];
  numeric: ColumnSummary[];
  all: ColumnSummary[];
  busy: boolean;
  onRun: RunFn;
}) {
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [measures, setMeasures] = useState<{ column: string; aggregation: Aggregation; label: string }[]>([
    { column: numeric[0]?.name ?? all[0]?.name ?? '', aggregation: 'sum', label: '' },
  ]);

  const update = (index: number, patch: Partial<{ column: string; aggregation: Aggregation; label: string }>) =>
    setMeasures(measures.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-950/20 border border-amber-900/40 text-[11px] text-amber-300">
        <TriangleAlert className="h-4 w-4 shrink-0 mt-0.5" />
        <span>
          This replaces the detailed rows with the summary. The original rows can be brought back with
          Undo on the Quality screen.
        </span>
      </div>

      <div className="space-y-2">
        <span className="text-[11px] font-semibold text-gray-400">Group by</span>
        <div className="max-h-32 overflow-y-auto border border-gray-800 rounded-lg p-2 bg-zinc-950/30 space-y-1">
          {groupable.map((c) => (
            <label key={c.name} className="flex items-center gap-2 text-xs px-1.5 py-1 hover:bg-zinc-900/50 rounded cursor-pointer">
              <input
                type="checkbox"
                checked={groupBy.includes(c.name)}
                onChange={() =>
                  setGroupBy(groupBy.includes(c.name) ? groupBy.filter((n) => n !== c.name) : [...groupBy, c.name])
                }
                className="h-3.5 w-3.5 rounded border-gray-700 bg-zinc-950"
              />
              <span className="text-gray-300 truncate">{c.name}</span>
              <span className="text-[10px] text-gray-600 ml-auto font-mono">{count(c.distinct_count)} distinct</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-gray-400">Summarise</span>
          <button
            onClick={() => setMeasures([...measures, { column: numeric[0]?.name ?? '', aggregation: 'sum', label: '' }])}
            className="text-[11px] text-cyan-400 flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
        {measures.map((measure, index) => (
          <div key={index} className="flex gap-2 items-center">
            <select
              value={measure.aggregation}
              onChange={(e) => update(index, { aggregation: e.target.value as Aggregation })}
              className="w-40 glass-input text-xs"
            >
              {AGGREGATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            <span className="text-[11px] text-gray-600">of</span>
            <select
              value={measure.column}
              onChange={(e) => update(index, { column: e.target.value })}
              className="flex-1 glass-input text-xs"
            >
              {all.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <input
              value={measure.label}
              onChange={(e) => update(index, { label: e.target.value })}
              placeholder="column name"
              className="w-40 glass-input text-xs"
            />
            {measures.length > 1 && (
              <button
                onClick={() => setMeasures(measures.filter((_, i) => i !== index))}
                className="text-gray-600 hover:text-red-400"
                aria-label="Remove"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <ApplyButton
        busy={busy}
        disabled={groupBy.length === 0 || measures.every((m) => !m.column)}
        onClick={() =>
          onRun('aggregate', {
            group_by: groupBy,
            measures: measures
              .filter((m) => m.column)
              .map((m) => ({ column: m.column, aggregation: m.aggregation, label: m.label || undefined })),
          })
        }
        label="Summarise the table"
      />
    </div>
  );
}

function ApplyButton({
  busy, disabled, onClick, label,
}: { busy: boolean; disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className="w-full py-2.5 rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 text-white text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-40 transition"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sigma className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}
