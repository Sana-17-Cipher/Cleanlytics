'use client';

import React, { useState } from 'react';
import {
  AlertTriangle, CheckCircle2, History, Loader2, RotateCcw, ShieldCheck, TriangleAlert,
} from 'lucide-react';

import { ApiError, api } from '../lib/api';
import { SEVERITY_STYLE, count, timeAgo } from '../lib/format';
import type { HistoryEntry, OperationOutcome, QualityAction, QualityFinding, TableDetail } from '../lib/types';

interface CleanModuleProps {
  projectId: number;
  table: TableDetail;
  history: HistoryEntry[];
  onTableChanged: (table: TableDetail) => void;
  onHistoryChanged: () => void;
}

/**
 * Data repair.
 *
 * Each option below is rendered directly from the operation the server will
 * run, including the sentence describing what it does to the data. Nothing is
 * applied without the user picking it, and destructive choices say how many
 * rows they delete before you press them.
 *
 * This replaces a screen where a button labelled "impute missing values with
 * the median" called an endpoint that deleted the rows instead, because the
 * label and the behaviour were written in different files.
 */
export default function CleanModule({
  projectId, table, history, onTableChanged, onHistoryChanged,
}: CleanModuleProps) {
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastOutcome, setLastOutcome] = useState<OperationOutcome | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const findings = table.quality?.findings ?? [];
  const summary = table.quality?.summary;

  const apply = async (finding: QualityFinding, action: QualityAction) => {
    const key = `${finding.id}:${action.operation}`;
    setRunning(key);
    setError(null);
    setConfirming(null);
    try {
      const response = await api.applyOperation(projectId, table.id, action.operation, action.params);
      setLastOutcome(response.result);
      onTableChanged(response.table);
      onHistoryChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That change could not be applied.');
    } finally {
      setRunning(null);
    }
  };

  const undo = async () => {
    setRunning('undo');
    setError(null);
    try {
      const response = await api.undo(projectId, table.id);
      setLastOutcome(null);
      onTableChanged(response.table);
      onHistoryChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not undo.');
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">Data quality</h2>
          <p className="text-xs text-gray-400 mt-1">
            {summary?.total
              ? `${summary.total} thing${summary.total === 1 ? '' : 's'} found in ${table.table_name}. Every fix says exactly what it will do first.`
              : `Nothing looks wrong with ${table.table_name}.`}
          </p>
        </div>
        {history.length > 0 && (
          <button
            onClick={undo}
            disabled={running !== null}
            className="px-3 py-1.5 rounded-lg border border-gray-800 bg-zinc-900/60 text-gray-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 disabled:opacity-50"
          >
            {running === 'undo' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            Undo last change
          </button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-300 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {/* What the last change actually did, measured after the fact */}
      {lastOutcome && (
        <div className="glass-panel rounded-xl border border-emerald-900/40 bg-emerald-950/10 p-4 space-y-1.5">
          <p className="text-xs font-semibold text-emerald-300 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0" />
            {lastOutcome.description}
          </p>
          <p className="text-[11px] text-gray-400 font-mono">
            {count(lastOutcome.rows_before)} rows → {count(lastOutcome.rows_after)} rows
            {lastOutcome.rows_removed > 0 && ` · ${count(lastOutcome.rows_removed)} removed`}
            {lastOutcome.cells_changed > 0 && ` · ${count(lastOutcome.cells_changed)} values changed`}
            {lastOutcome.columns_added.length > 0 && ` · added ${lastOutcome.columns_added.join(', ')}`}
          </p>
          {lastOutcome.warnings.map((warning) => (
            <p key={warning} className="text-[11px] text-amber-400 flex items-start gap-1.5">
              <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {warning}
            </p>
          ))}
        </div>
      )}

      {findings.length === 0 ? (
        <div className="glass-panel rounded-xl p-10 text-center space-y-2">
          <ShieldCheck className="h-10 w-10 text-emerald-400 mx-auto" />
          <p className="text-sm font-semibold text-gray-200">Nothing to fix</p>
          <p className="text-xs text-gray-500">
            No gaps, duplicates, inconsistent spellings or malformed values were found in this table.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {findings.map((finding) => {
            const tone = SEVERITY_STYLE[finding.severity];
            return (
              <div
                key={finding.id}
                className={`glass-panel rounded-xl border p-4 space-y-3 ${tone.border} ${tone.bg}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-[9px] font-bold uppercase tracking-wider ${tone.text}`}>
                        {tone.label}
                      </span>
                      {finding.column && (
                        <span className="text-[9px] font-mono text-gray-400 bg-zinc-900/70 px-1.5 py-0.5 rounded">
                          {finding.column}
                        </span>
                      )}
                      <span className="text-[9px] text-gray-600 font-mono">
                        {count(finding.affected_rows)} affected
                      </span>
                    </div>
                    <p className="text-xs font-bold text-white">{finding.title}</p>
                    <p className="text-[11px] text-gray-300">{finding.detail}</p>
                    <p className="text-[11px] text-gray-500">{finding.why}</p>
                  </div>
                </div>

                {finding.actions.length === 0 ? (
                  <p className="text-[11px] text-gray-500 italic border-t border-gray-800/50 pt-3">
                    There is no safe automatic fix for this. It needs a look at the source data.
                  </p>
                ) : (
                  <div className="space-y-2 border-t border-gray-800/50 pt-3">
                    {finding.actions.map((action) => {
                      const key = `${finding.id}:${action.operation}`;
                      const isRunning = running === key;
                      const needsConfirm = action.destructive && confirming !== key;

                      return (
                        <div
                          key={key}
                          className="flex items-start justify-between gap-3 bg-zinc-950/40 border border-gray-800/50 rounded-lg px-3 py-2.5"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-[11px] font-semibold text-gray-100 flex items-center gap-1.5 flex-wrap">
                              {action.label}
                              {action.recommended && (
                                <span className="text-[9px] font-bold text-emerald-400 bg-emerald-950/50 border border-emerald-800/40 px-1.5 py-0.5 rounded">
                                  recommended
                                </span>
                              )}
                              {action.destructive && (
                                <span className="text-[9px] font-bold text-red-400 bg-red-950/40 border border-red-900/40 px-1.5 py-0.5 rounded">
                                  removes data
                                </span>
                              )}
                            </p>
                            <p className="text-[11px] text-gray-400">{action.consequence}</p>
                          </div>

                          <button
                            onClick={() => (needsConfirm ? setConfirming(key) : apply(finding, action))}
                            disabled={running !== null}
                            className={`px-3 py-1.5 rounded-lg text-[10px] font-semibold shrink-0 transition disabled:opacity-40 ${
                              confirming === key
                                ? 'bg-red-900/60 text-red-200 border border-red-700'
                                : action.destructive
                                  ? 'bg-zinc-900 text-gray-300 border border-gray-700 hover:border-red-800/60 hover:text-red-300'
                                  : 'bg-emerald-950/50 text-emerald-300 border border-emerald-800/40 hover:bg-emerald-900/50'
                            }`}
                          >
                            {isRunning ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : confirming === key ? (
                              'Confirm'
                            ) : (
                              'Apply'
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Provenance */}
      {history.length > 0 && (
        <div className="glass-panel rounded-xl border border-gray-800/60 overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-800/60 flex items-center gap-2">
            <History className="h-4 w-4 text-gray-500" />
            <h3 className="text-sm font-bold text-white">What has been changed</h3>
          </div>
          <div className="divide-y divide-gray-800/40 max-h-64 overflow-y-auto">
            {history.map((entry) => (
              <div key={entry.id} className="px-5 py-2.5 flex items-start gap-3">
                <CheckCircle2
                  className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${entry.destructive ? 'text-amber-500' : 'text-emerald-500'}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] text-gray-200">{entry.description}</p>
                  <p className="text-[10px] text-gray-600 font-mono">
                    {entry.rows_before != null && entry.rows_after != null
                      ? `${count(entry.rows_before)} → ${count(entry.rows_after)} rows · `
                      : ''}
                    {timeAgo(entry.created_at)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
