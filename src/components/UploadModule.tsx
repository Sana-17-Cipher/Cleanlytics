'use client';

import React, { useCallback, useRef, useState } from 'react';
import {
  AlertCircle, CheckCircle2, Database, FileSpreadsheet, Link2, Trash2, Upload, X,
} from 'lucide-react';

import { ApiError, api } from '../lib/api';
import { bytes, count, pluralise } from '../lib/format';
import type { TableSummary, UploadResult } from '../lib/types';

const ACCEPTED = ['.csv', '.tsv', '.txt', '.xlsx', '.xls', '.xlsm', '.parquet'];

interface UploadModuleProps {
  projectId: number | null;
  tables: TableSummary[];
  maxUploadMb: number;
  onUploaded: (result: UploadResult) => void;
  onDeleteTable: (tableId: number) => void;
  onSelectTable: (tableId: number) => void;
  activeTableId: number | null;
}

/**
 * File intake.
 *
 * Selecting several files sends them as one request, so they all land in the
 * same project and relationship detection runs across the whole set. The
 * previous version looped and created a separate project per file, which made
 * the multi-table model impossible to reach by dropping files together.
 */
export default function UploadModule({
  projectId,
  tables,
  maxUploadMb,
  onUploaded,
  onDeleteTable,
  onSelectTable,
  activeTableId,
}: UploadModuleProps) {
  const [dragging, setDragging] = useState(false);
  const [queued, setQueued] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<UploadResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (incoming: FileList | null) => {
      if (!incoming?.length) return;
      setError(null);

      const accepted: File[] = [];
      const rejected: string[] = [];
      Array.from(incoming).forEach((file) => {
        const extension = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
        if (!ACCEPTED.includes(extension)) {
          rejected.push(`${file.name} (${extension} is not supported)`);
        } else if (file.size > maxUploadMb * 1024 * 1024) {
          rejected.push(`${file.name} (${bytes(file.size)} exceeds the ${maxUploadMb} MB limit)`);
        } else {
          accepted.push(file);
        }
      });

      if (rejected.length) setError(`Skipped: ${rejected.join(', ')}`);
      setQueued((previous) => {
        const seen = new Set(previous.map((f) => `${f.name}:${f.size}`));
        return [...previous, ...accepted.filter((f) => !seen.has(`${f.name}:${f.size}`))];
      });
    },
    [maxUploadMb],
  );

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const startUpload = async () => {
    if (!projectId || !queued.length) return;
    setBusy(true);
    setProgress(0);
    setError(null);
    setOutcome(null);
    try {
      const result = await api.uploadTables(projectId, queued, setProgress);
      setOutcome(result);
      setQueued([]);
      onUploaded(result);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'The upload failed.');
    } finally {
      setBusy(false);
      setProgress(0);
    }
  };

  const totalQueuedBytes = queued.reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="space-y-5 animate-fade-in">
      <div>
        <h2 className="text-xl font-bold tracking-tight text-white">Data sources</h2>
        <p className="text-xs text-gray-400 mt-1">
          Add several files at once. Each file becomes a table, each Excel sheet becomes its own
          table, and links between them are found automatically.
        </p>
      </div>

      {/* Drop zone */}
      <div
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragging(false); }}
        onDrop={handleDrop}
        onClick={() => !busy && inputRef.current?.click()}
        className={`glass-panel border-dashed rounded-xl p-10 flex flex-col items-center justify-center text-center transition-colors ${
          busy ? 'cursor-wait opacity-70' : 'cursor-pointer'
        } ${dragging ? 'border-emerald-500 bg-emerald-950/20' : 'border-gray-800 hover:border-cyan-500/50'}`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED.join(',')}
          className="hidden"
          disabled={busy}
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
        />
        <div className="h-14 w-14 rounded-full bg-zinc-900/80 border border-gray-800 flex items-center justify-center mb-3">
          <Upload className="h-6 w-6 text-gray-400" />
        </div>
        <p className="text-sm font-semibold text-gray-200">
          {tables.length ? 'Add more files to this project' : 'Drop your files here, or click to browse'}
        </p>
        <p className="text-xs text-gray-500 mt-1.5">
          CSV, Excel and Parquet · up to {maxUploadMb} MB each · select as many as you like
        </p>
      </div>

      {/* Queue */}
      {queued.length > 0 && (
        <div className="glass-panel rounded-xl border border-gray-800 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-200">
              {pluralise(queued.length, 'file')} ready · {bytes(totalQueuedBytes)}
            </p>
            <button
              onClick={() => setQueued([])}
              disabled={busy}
              className="text-[11px] text-gray-500 hover:text-gray-300 disabled:opacity-40"
            >
              Clear
            </button>
          </div>

          <div className="space-y-1.5 max-h-44 overflow-y-auto">
            {queued.map((file, index) => (
              <div
                key={`${file.name}-${file.size}-${index}`}
                className="flex items-center justify-between text-xs bg-zinc-900/40 border border-gray-800/60 rounded-lg px-3 py-2"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <FileSpreadsheet className="h-3.5 w-3.5 text-cyan-400 shrink-0" />
                  <span className="truncate text-gray-200">{file.name}</span>
                </span>
                <span className="flex items-center gap-3 shrink-0 ml-3">
                  <span className="text-gray-500 font-mono text-[10px]">{bytes(file.size)}</span>
                  <button
                    onClick={() => setQueued((q) => q.filter((_, i) => i !== index))}
                    disabled={busy}
                    className="text-gray-600 hover:text-red-400 disabled:opacity-40"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </div>

          {busy && (
            <div className="space-y-1.5">
              <div className="h-1 w-full bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-emerald-500 transition-[width] duration-200"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-gray-500">
                {progress >= 1
                  ? 'Reading the data and analysing it. Large files take a few seconds.'
                  : `Uploading ${Math.round(progress * 100)}%`}
              </p>
            </div>
          )}

          <button
            onClick={startUpload}
            disabled={busy || !projectId}
            className="w-full py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white text-xs font-semibold disabled:opacity-50 transition"
          >
            {busy ? 'Working…' : `Load ${pluralise(queued.length, 'file')}`}
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-3 p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-300 text-xs">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {/* What happened, including per-file failures */}
      {outcome && (
        <div className="glass-panel rounded-xl border border-gray-800 p-4 space-y-3">
          <p className="text-xs font-semibold text-gray-100">{outcome.message}</p>

          {outcome.failed.length > 0 && (
            <div className="space-y-1.5">
              {outcome.failed.map((failure) => (
                <div
                  key={failure.file}
                  className="flex items-start gap-2 text-[11px] text-red-300 bg-red-950/20 border border-red-900/40 rounded-lg px-3 py-2"
                >
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    <span className="font-semibold">{failure.file}</span> — {failure.error}
                  </span>
                </div>
              ))}
            </div>
          )}

          {outcome.relationships.filter((r) => r.status === 'approved').length > 0 && (
            <div className="space-y-1">
              {outcome.relationships
                .filter((r) => r.status === 'approved')
                .map((link) => (
                  <p key={link.id} className="text-[11px] text-emerald-300 flex items-center gap-1.5">
                    <Link2 className="h-3 w-3 shrink-0" />
                    <span className="font-mono">
                      {link.from_table_name}.{link.from_column} → {link.to_table_name}.{link.to_column}
                    </span>
                    <span className="text-gray-500">({link.cardinality_label})</span>
                  </p>
                ))}
            </div>
          )}
        </div>
      )}

      {/* Tables already in the project */}
      {tables.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Database className="h-4 w-4 text-emerald-400" />
            Tables in this project ({tables.length})
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {tables.map((table) => {
              const active = table.id === activeTableId;
              const score = table.summary?.quality_score;
              return (
                <div
                  key={table.id}
                  onClick={() => onSelectTable(table.id)}
                  className={`glass-panel p-4 rounded-xl border cursor-pointer transition space-y-2 ${
                    active ? 'border-cyan-500/50 ring-1 ring-cyan-500/20' : 'border-gray-800 hover:border-gray-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold text-white truncate">{table.table_name}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteTable(table.id); }}
                      className="text-gray-600 hover:text-red-400 shrink-0"
                      aria-label={`Remove ${table.table_name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <p className="text-[10px] text-gray-500 truncate">
                    {table.source_file}
                    {table.source_sheet ? ` · sheet “${table.source_sheet}”` : ''}
                  </p>

                  <div className="flex items-center gap-3 text-[10px] text-gray-500 pt-1 border-t border-gray-800/40">
                    <span>{count(table.row_count)} rows</span>
                    <span>{table.column_count} cols</span>
                    {score != null && (
                      <span className="flex items-center gap-1 ml-auto">
                        <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                        {score}%
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
