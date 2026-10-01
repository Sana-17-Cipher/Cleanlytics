'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  FileSpreadsheet,
  Link2,
  Loader2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { ApiError, api } from '../lib/api';
import { bytes, count, pluralise } from '../lib/format';
import type { TableSummary, UploadResult } from '../lib/types';

const ACCEPTED = [
  '.csv',
  '.tsv',
  '.txt',
  '.xlsx',
  '.xls',
  '.xlsm',
  '.parquet',
];

interface UploadModuleProps {
  projectId: number | null;
  tables: TableSummary[];
  maxUploadMb: number;
  onUploaded: (result: UploadResult) => void | Promise<void>;
  onDeleteTable: (tableId: number) => void;
  onSelectTable: (tableId: number) => void;
  activeTableId: number | null;
}

function fileKey(file: File) {
  return JSON.stringify([
    file.name,
    file.size,
    file.lastModified,
  ]);
}

export default function UploadModule(props: UploadModuleProps) {
  // Reset selections when the user switches projects.
  return (
    <ProjectUpload
      key={props.projectId ?? 'no-project'}
      {...props}
    />
  );
}

function ProjectUpload({
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
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const disabled = busy || projectId === null;
  const totalBytes = queued.reduce(
    (sum, file) => sum + file.size,
    0,
  );
  const uploadPercent = Math.round(progress * 100);

  const approved =
    outcome?.relationships.filter(
      (relationship) => relationship.status === 'approved',
    ) ?? [];

  const pending =
    outcome?.relationships.filter(
      (relationship) => relationship.status === 'suggested',
    ).length ?? 0;

  function addFiles(incoming: FileList | null) {
    if (
      !incoming?.length ||
      inFlight.current ||
      projectId === null
    ) {
      return;
    }

    const accepted: File[] = [];
    const rejected: string[] = [];

    for (const file of Array.from(incoming)) {
      const extension =
        `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;

      if (!ACCEPTED.includes(extension)) {
        rejected.push(`${file.name}: unsupported format.`);
      } else if (file.size === 0) {
        rejected.push(`${file.name}: the file is empty.`);
      } else if (file.size > maxUploadMb * 1024 * 1024) {
        rejected.push(
          `${file.name}: exceeds the ${maxUploadMb} MB limit.`,
        );
      } else {
        accepted.push(file);
      }
    }

    setError(rejected.length ? rejected.join(' ') : null);

    setQueued((previous) => {
      const seen = new Set(previous.map(fileKey));
      const next = [...previous];

      for (const file of accepted) {
        const key = fileKey(file);

        if (seen.has(key)) continue;

        seen.add(key);
        next.push(file);
      }

      return next;
    });
  }

  async function startUpload() {
    if (
      projectId === null ||
      queued.length === 0 ||
      inFlight.current
    ) {
      return;
    }

    inFlight.current = true;
    setBusy(true);
    setProgress(0);
    setError(null);
    setOutcome(null);

    try {
      const result = await api.uploadTables(
        projectId,
        [...queued],
        (fraction) => {
          if (mounted.current && Number.isFinite(fraction)) {
            setProgress(Math.max(0, Math.min(1, fraction)));
          }
        },
      );

      if (!mounted.current) return;

      setOutcome(result);

      // A workbook can partially succeed. Automatically retrying
      // the entire file could duplicate sheets already imported.
      setQueued([]);

      try {
        await onUploaded(result);
      } catch {
        if (mounted.current) {
          setError(
            'The server responded, but the project view could not refresh. ' +
            'Reload the project before uploading again.',
          );
        }
      }
    } catch (cause) {
      if (mounted.current) {
        const message =
          cause instanceof ApiError
            ? cause.message
            : 'The upload could not be completed.';

        setError(
          `${message} Check the project before retrying; ` +
          'the server may have received some files.',
        );
      }
    } finally {
      inFlight.current = false;

      if (mounted.current) {
        setBusy(false);
        setProgress(0);
      }
    }
  }

  return (
    <div
      className="space-y-5 animate-fade-in"
      aria-busy={busy}
    >
      <div>
        <h2 className="text-xl font-bold text-white">
          Data sources
        </h2>
        <p className="text-xs text-gray-400 mt-1">
          Upload related files together. Each Excel sheet becomes
          a table. The system profiles columns and searches for
          relationships.
        </p>
      </div>

      {projectId === null && (
        <p
          role="status"
          className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-4 text-xs text-amber-200"
        >
          Create or select a project before uploading files.
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED.join(',')}
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault();

          if (disabled) return;

          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = disabled
            ? 'none'
            : 'copy';
        }}
        onDragLeave={(event) => {
          event.preventDefault();

          dragDepth.current = Math.max(
            0,
            dragDepth.current - 1,
          );

          if (dragDepth.current === 0) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);

          if (!disabled) {
            addFiles(event.dataTransfer.files);
          }
        }}
        className={`glass-panel w-full border-dashed rounded-xl p-10 flex flex-col items-center gap-3 text-center transition focus-visible:outline-2 focus-visible:outline-cyan-400 disabled:opacity-50 ${
          dragging
            ? 'border-emerald-500 bg-emerald-950/20'
            : 'border-gray-800 hover:border-cyan-500/50'
        }`}
      >
        <Upload className="h-8 w-8 text-cyan-400" />

        <span className="text-sm font-semibold text-gray-200">
          Drop files here or click to browse
        </span>

        <span className="text-xs text-gray-500">
          CSV, TSV, Excel and Parquet · up to {maxUploadMb} MB
          per file
        </span>
      </button>

      {queued.length > 0 && (
        <div className="glass-panel rounded-xl border border-gray-800 p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-gray-200">
              {pluralise(queued.length, 'file')} selected
              {' · '}
              {bytes(totalBytes)}
            </p>

            <button
              type="button"
              disabled={busy}
              onClick={() => setQueued([])}
              className="text-xs text-gray-400 disabled:opacity-40"
            >
              Clear selection
            </button>
          </div>

          <div className="space-y-2 max-h-48 overflow-y-auto">
            {queued.map((file) => (
              <div
                key={fileKey(file)}
                className="flex items-center gap-3 rounded-lg border border-gray-800 px-3 py-2 text-xs"
              >
                <FileSpreadsheet className="h-4 w-4 text-cyan-400 shrink-0" />

                <span
                  title={file.name}
                  className="flex-1 min-w-0 truncate text-gray-200"
                >
                  {file.name}
                </span>

                <span className="text-gray-500 shrink-0">
                  {bytes(file.size)}
                </span>

                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Remove ${file.name}`}
                  className="text-gray-500 hover:text-red-400 disabled:opacity-40"
                  onClick={() => {
                    setQueued((files) =>
                      files.filter(
                        (entry) => fileKey(entry) !== fileKey(file),
                      ),
                    );
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={startUpload}
            disabled={disabled}
            className="w-full flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-600 to-emerald-600 py-3 text-xs font-semibold text-white disabled:opacity-50"
          >
            {busy && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}

            {busy
              ? 'Working…'
              : `Upload and analyse ${pluralise(queued.length, 'file')}`}
          </button>
        </div>
      )}

      {busy && (
        <div
          className="space-y-2"
          role="status"
          aria-live="polite"
        >
          <progress
            aria-label="File transfer progress"
            value={progress}
            max={1}
            className="w-full h-2 accent-emerald-400"
          />

          <p className="text-xs text-gray-400">
            {progress >= 1
              ? 'Files transferred. Waiting for the server to finish processing…'
              : `Uploading files: ${uploadPercent}%`}
          </p>

          <p className="text-xs text-gray-500">
            Keep this screen open until processing finishes.
          </p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/20 p-4 text-xs text-red-300"
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {outcome && (
        <div
          className="glass-panel rounded-xl border border-gray-800 p-4 space-y-3"
          aria-live="polite"
        >
          <p className="text-sm font-semibold text-white">
            {outcome.message}
          </p>

          <p className="text-xs text-gray-400">
            {outcome.tables.length} tables loaded
            {' · '}
            {outcome.failed.length} file errors
          </p>

          {outcome.failed.map((failure, index) => (
            <p
              key={`${failure.file}-${index}`}
              className="rounded-lg bg-red-950/20 p-3 text-xs text-red-300"
            >
              <strong>{failure.file}</strong>: {failure.error}
            </p>
          ))}

          {outcome.failed.length > 0 && (
            <p className="text-xs text-amber-300">
              Check which tables loaded before selecting failed
              files again. A workbook may have loaded some sheets
              successfully.
            </p>
          )}

          {approved.map((link) => (
            <p
              key={link.id}
              className="flex items-start gap-2 text-xs text-emerald-300"
            >
              <Link2 className="h-4 w-4 shrink-0" />

              <span className="break-words">
                {link.from_table_name}.{link.from_column}
                {' → '}
                {link.to_table_name}.{link.to_column}
                {' '}
                ({link.cardinality_label})
              </span>
            </p>
          ))}

          {pending > 0 && (
            <p className="text-xs text-amber-300">
              {pluralise(pending, 'relationship')} waiting for
              review in Model.
            </p>
          )}
        </div>
      )}

      {tables.length > 0 && (
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-sm font-bold text-white">
            <Database className="h-4 w-4 text-emerald-400" />
            Tables in this project ({tables.length})
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {tables.map((table) => (
              <div
                key={table.id}
                className={`glass-panel rounded-xl border p-4 space-y-3 ${
                  table.id === activeTableId
                    ? 'border-cyan-500/50 ring-1 ring-cyan-500/20'
                    : 'border-gray-800'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onSelectTable(table.id)}
                    title={table.table_name}
                    className="min-w-0 truncate text-left text-sm font-semibold text-white hover:text-cyan-300 disabled:opacity-50"
                  >
                    {table.table_name}
                  </button>

                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onDeleteTable(table.id)}
                    aria-label={`Remove ${table.table_name}`}
                    className="text-gray-500 hover:text-red-400 disabled:opacity-40"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                <p
                  title={table.source_file}
                  className="text-xs text-gray-500 truncate"
                >
                  {table.source_file}
                  {table.source_sheet
                    ? ` · ${table.source_sheet}`
                    : ''}
                </p>

                <div className="flex flex-wrap items-center gap-3 border-t border-gray-800 pt-2 text-xs text-gray-400">
                  <span>{count(table.row_count)} rows</span>
                  <span>{table.column_count} columns</span>

                  {table.summary?.quality_score != null && (
                    <span className="flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      {table.summary.quality_score}% quality
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}