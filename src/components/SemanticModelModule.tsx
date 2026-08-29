'use client';

import React, { useState } from 'react';
import {
  ArrowRight, Check, Database, Layers, Link2, Loader2, Play, Sparkles, TriangleAlert, X,
} from 'lucide-react';

import { ApiError, api } from '../lib/api';
import { count, exact, percent } from '../lib/format';
import type { AnalysisSuggestion, QueryResult, Relationship, SemanticModel } from '../lib/types';

interface SemanticModelModuleProps {
  projectId: number;
  model: SemanticModel;
  onModelChanged: () => void;
}

const KIND_STYLE = {
  fact: { label: 'Fact table', text: 'text-emerald-400', bg: 'bg-emerald-950/40', border: 'border-emerald-800/40' },
  dimension: { label: 'Lookup table', text: 'text-cyan-400', bg: 'bg-cyan-950/40', border: 'border-cyan-800/40' },
  bridge: { label: 'Bridge', text: 'text-violet-400', bg: 'bg-violet-950/40', border: 'border-violet-800/40' },
  standalone: { label: 'Not linked', text: 'text-gray-400', bg: 'bg-zinc-900/50', border: 'border-gray-800/40' },
} as const;

/**
 * The data model.
 *
 * The difference from the previous version is that everything here is live. A
 * relationship carries the measurement that produced it, approving one changes
 * what queries are possible, and the suggested analyses at the bottom are
 * runnable specifications rather than two hardcoded example cards that
 * mentioned tables the user might not have.
 */
export default function SemanticModelModule({
  projectId, model, onModelChanged,
}: SemanticModelModuleProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ suggestion: AnalysisSuggestion; result: QueryResult } | null>(null);

  const detect = async () => {
    setBusy('detect');
    setError(null);
    try {
      await api.detectRelationships(projectId);
      onModelChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Detection failed.');
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (relationship: Relationship, status: 'approved' | 'rejected') => {
    setBusy(`rel-${relationship.id}`);
    setError(null);
    try {
      await api.setRelationshipStatus(projectId, relationship.id, status);
      onModelChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not update that link.');
    } finally {
      setBusy(null);
    }
  };

  const run = async (suggestion: AnalysisSuggestion) => {
    setBusy(`run-${suggestion.id}`);
    setError(null);
    try {
      const result = await api.query(projectId, suggestion.spec);
      setPreview({ suggestion, result });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That analysis could not be run.');
    } finally {
      setBusy(null);
    }
  };

  const approved = model.relationships.filter((r) => r.status === 'approved');
  const pending = model.relationships.filter((r) => r.status === 'suggested');
  const rejected = model.relationships.filter((r) => r.status === 'rejected');

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">Data model</h2>
          <p className="text-xs text-gray-400 mt-1">
            How your tables fit together. Approved links let you analyse across tables in one go.
          </p>
        </div>
        {model.tables.length >= 2 && (
          <button
            onClick={detect}
            disabled={busy !== null}
            className="px-3.5 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 disabled:opacity-50"
          >
            {busy === 'detect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Look for links
          </button>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-300 text-xs">{error}</div>
      )}

      {/* Connectivity: the thing that decides whether cross-table analysis works */}
      {model.tables.length >= 2 && (
        <div
          className={`glass-panel rounded-xl border p-4 flex items-start gap-3 ${
            model.is_connected ? 'border-emerald-900/40 bg-emerald-950/10' : 'border-amber-900/40 bg-amber-950/10'
          }`}
        >
          {model.is_connected ? (
            <Link2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <TriangleAlert className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          )}
          <div className="text-[11px]">
            {model.is_connected ? (
              <p className="text-emerald-300 font-semibold">
                All {model.tables.length} tables are connected, so any field can be combined with any other.
              </p>
            ) : (
              <>
                <p className="text-amber-300 font-semibold">
                  These tables form {model.islands.length} separate groups that cannot be analysed together.
                </p>
                <p className="text-gray-400 mt-0.5">
                  {model.islands.map((island) => island.join(' + ')).join('  |  ')}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tables and their role in the model */}
      <div>
        <h3 className="text-sm font-bold text-white mb-2.5 flex items-center gap-2">
          <Database className="h-4 w-4 text-cyan-400" /> Tables
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {model.tables.map((table) => {
            const style = KIND_STYLE[table.kind];
            return (
              <div key={table.id} className="glass-panel rounded-xl border border-gray-800 p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold text-white truncate">{table.table_name}</span>
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${style.bg} ${style.text} ${style.border}`}>
                    {style.label}
                  </span>
                </div>
                <p className="text-[10px] text-gray-500">{table.reason}</p>
                <div className="flex gap-3 text-[10px] text-gray-500 font-mono pt-1 border-t border-gray-800/40">
                  <span>{count(table.row_count)} rows</span>
                  {table.outgoing > 0 && <span>{table.outgoing} out</span>}
                  {table.incoming > 0 && <span>{table.incoming} in</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Relationships */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Link2 className="h-4 w-4 text-emerald-400" /> Links between tables
          </h3>
          <span className="text-[11px] text-gray-500">
            {approved.length} active
            {pending.length > 0 && ` · ${pending.length} awaiting your decision`}
          </span>
        </div>

        {model.relationships.length === 0 ? (
          <div className="glass-panel rounded-xl p-6 text-center space-y-1">
            <p className="text-xs text-gray-400">No links found yet.</p>
            <p className="text-[11px] text-gray-500">
              {model.tables.length < 2
                ? 'Add a second table and the app will look for matching columns automatically.'
                : 'No columns in these tables share enough values to be a reliable link.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {[...pending, ...approved, ...rejected].map((relationship) => (
              <RelationshipRow
                key={relationship.id}
                relationship={relationship}
                busy={busy === `rel-${relationship.id}`}
                disabled={busy !== null}
                onApprove={() => setStatus(relationship, 'approved')}
                onReject={() => setStatus(relationship, 'rejected')}
              />
            ))}
          </div>
        )}
      </div>

      {/* Analyses unlocked by the links */}
      {model.suggestions.length > 0 && (
        <div>
          <h3 className="text-sm font-bold text-white mb-2.5 flex items-center gap-2">
            <Layers className="h-4 w-4 text-violet-400" /> Analyses these links make possible
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {model.suggestions.map((suggestion) => (
              <div key={suggestion.id} className="glass-panel rounded-xl border border-gray-800 p-4 space-y-2">
                <p className="text-xs font-bold text-white">{suggestion.title}</p>
                <p className="text-[11px] text-gray-500 leading-relaxed">{suggestion.description}</p>
                <button
                  onClick={() => run(suggestion)}
                  disabled={busy !== null}
                  className="w-full py-2 rounded-lg bg-zinc-900/70 border border-gray-700 text-gray-200 hover:border-cyan-700 hover:text-cyan-300 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition disabled:opacity-50"
                >
                  {busy === `run-${suggestion.id}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3 w-3" />
                  )}
                  Run it
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {preview && <QueryPreview preview={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function RelationshipRow({
  relationship, busy, disabled, onApprove, onReject,
}: {
  relationship: Relationship;
  busy: boolean;
  disabled: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const approved = relationship.status === 'approved';
  const rejected = relationship.status === 'rejected';

  return (
    <div
      className={`glass-panel rounded-xl border p-3.5 space-y-2 ${
        approved
          ? 'border-emerald-800/40 bg-emerald-950/10'
          : rejected
            ? 'border-gray-800/40 opacity-50'
            : 'border-amber-800/40 bg-amber-950/10'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap text-xs font-mono">
            <span className="font-bold text-white">
              {relationship.from_table_name}.{relationship.from_column}
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-gray-500 shrink-0" />
            <span className="font-bold text-cyan-400">
              {relationship.to_table_name}.{relationship.to_column}
            </span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-zinc-800 text-gray-300 border border-gray-700/40">
              {relationship.cardinality_label}
            </span>
            {relationship.origin === 'manual' && (
              <span className="text-[9px] text-violet-400">added by you</span>
            )}
          </div>

          {relationship.evidence && (
            <p className="text-[11px] text-gray-400">{relationship.evidence}</p>
          )}

          {relationship.notes.map((note) => (
            <p key={note} className="text-[11px] text-amber-400/90 flex items-start gap-1.5">
              <TriangleAlert className="h-3 w-3 shrink-0 mt-0.5" /> {note}
            </p>
          ))}

          <p className="text-[10px] text-gray-600 font-mono">
            {percent(relationship.confidence, 0)} confidence
            {relationship.coverage != null && ` · ${percent(relationship.coverage, 1)} of values match`}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
          ) : approved ? (
            <button
              onClick={onReject}
              disabled={disabled}
              className="px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-zinc-900 border border-gray-800 text-gray-400 hover:text-red-400 hover:border-red-900/50 disabled:opacity-40"
            >
              Turn off
            </button>
          ) : (
            <>
              <button
                onClick={onApprove}
                disabled={disabled}
                className="px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-emerald-950/60 border border-emerald-800/40 text-emerald-300 hover:bg-emerald-900/60 flex items-center gap-1 disabled:opacity-40"
              >
                <Check className="h-3 w-3" /> Use this link
              </button>
              {!rejected && (
                <button
                  onClick={onReject}
                  disabled={disabled}
                  className="px-2 py-1.5 rounded-lg text-[10px] bg-zinc-900 border border-gray-800 text-gray-500 hover:text-red-400 disabled:opacity-40"
                  aria-label="Dismiss this link"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function QueryPreview({
  preview, onClose,
}: { preview: { suggestion: AnalysisSuggestion; result: QueryResult }; onClose: () => void }) {
  const { suggestion, result } = preview;
  const [showSql, setShowSql] = useState(false);
  const columns = result.fields.map((field) => field.key);

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="glass-panel rounded-xl border border-gray-800 max-w-3xl w-full max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-800 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white">{suggestion.title}</h3>
            <p className="text-[11px] text-gray-500 mt-0.5">
              From {result.base_table_name}
              {result.joined_tables.length > 0 && `, joined to ${result.joined_tables.join(' and ')}`}
              {' · '}{count(result.row_count)} rows
              {result.truncated && ' (showing the first page)'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>

        {result.warnings.length > 0 && (
          <div className="px-5 py-3 border-b border-gray-800 space-y-1">
            {result.warnings.map((warning) => (
              <p key={warning} className="text-[11px] text-amber-400 flex items-start gap-1.5">
                <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {warning}
              </p>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-zinc-900/95 backdrop-blur">
              <tr className="border-b border-gray-800">
                {result.fields.map((field) => (
                  <th key={field.key} className="px-4 py-2.5 font-semibold text-gray-300 whitespace-nowrap">
                    {field.key}
                    <span className="block text-[9px] font-normal text-gray-600">
                      {field.table_name}
                      {field.aggregation ? ` · ${field.aggregation.replace('_', ' ')}` : ''}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              {result.rows.map((row, index) => (
                <tr key={index} className="hover:bg-zinc-900/30">
                  {columns.map((key) => {
                    const value = row[key];
                    return (
                      <td key={key} className="px-4 py-2 text-gray-300 whitespace-nowrap font-mono">
                        {value === null || value === undefined
                          ? <span className="text-gray-700">blank</span>
                          : typeof value === 'number' ? exact(value) : String(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-5 py-3 border-t border-gray-800">
          <button
            onClick={() => setShowSql(!showSql)}
            className="text-[11px] text-gray-500 hover:text-gray-300"
          >
            {showSql ? 'Hide' : 'Show'} the query behind these numbers
          </button>
          {showSql && (
            <pre className="mt-2 text-[10px] text-gray-400 font-mono bg-zinc-950/60 border border-gray-800 rounded-lg p-3 overflow-x-auto">
              {result.sql}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
