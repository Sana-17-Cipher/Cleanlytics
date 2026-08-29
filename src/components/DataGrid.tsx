'use client';

import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Loader2, Search } from 'lucide-react';

import { api } from '../lib/api';
import { ROLE_STYLE, cell, count } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import type { TableDetail } from '../lib/types';

const PAGE_SIZE = 100;

interface DataGridProps {
  projectId: number;
  table: TableDetail;
}

/**
 * Paged view of the actual rows.
 *
 * Only ever holds one page in memory. The previous version kept every row of
 * the dataset in React state and re-rendered the lot, which is why anything
 * past a few tens of thousands of rows locked the tab up.
 */
export default function DataGrid({ projectId, table }: DataGridProps) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [sort, setSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null);

  const { data: page, error, isStale } = useAsync(
    () => api.getRows(projectId, table.id, {
      offset,
      limit: PAGE_SIZE,
      search: applied || undefined,
      orderBy: sort?.column,
      direction: sort?.direction,
    }),
    [projectId, table.id, offset, applied, sort?.column, sort?.direction],
  );

  // Paging, sorting and the search box reset when the table changes because
  // the caller keys this component by table id, which remounts it. That is
  // cheaper and less error-prone than clearing four pieces of state by hand.
  const loading = isStale;

  const columns = table.columns;
  const total = page?.total ?? 0;
  const pageNumber = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const toggleSort = (column: string) => {
    setOffset(0);
    setSort((current) =>
      current?.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    );
  };

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">{table.table_name}</h2>
          <p className="text-xs text-gray-400 mt-1">
            {count(table.row_count)} rows · {table.column_count} columns
            {applied && ` · ${count(total)} matching “${applied}”`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <form
            onSubmit={(e) => { e.preventDefault(); setOffset(0); setApplied(search.trim()); }}
            className="relative"
          >
            <Search className="h-3.5 w-3.5 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search all columns"
              className="glass-input text-xs pl-8 pr-3 py-1.5 w-52"
            />
          </form>
          <a
            href={api.exportUrl(projectId, table.id, 'csv')}
            className="px-3 py-1.5 rounded-lg border border-gray-800 bg-zinc-900/60 text-gray-300 hover:text-white text-xs font-semibold flex items-center gap-1.5"
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </a>
          <a
            href={api.exportUrl(projectId, table.id, 'xlsx')}
            className="px-3 py-1.5 rounded-lg border border-gray-800 bg-zinc-900/60 text-gray-300 hover:text-white text-xs font-semibold"
          >
            Excel
          </a>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-300 text-xs">{error}</div>
      )}

      <div className="glass-panel rounded-xl border border-gray-800 overflow-hidden">
        <div className="overflow-auto max-h-[62vh]">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-zinc-900/95 backdrop-blur border-b border-gray-800">
                <th className="px-3 py-2.5 w-14 text-[10px] font-bold text-gray-600 uppercase text-right">#</th>
                {columns.map((column) => {
                  const style = ROLE_STYLE[column.semantic_role];
                  const active = sort?.column === column.name;
                  return (
                    <th key={column.name} className="px-3 py-2 min-w-[130px] border-l border-gray-800/40">
                      <button
                        onClick={() => toggleSort(column.name)}
                        className="w-full text-left group"
                        title={`Sort by ${column.name}`}
                      >
                        <span className="flex items-center gap-1 font-semibold text-gray-200 group-hover:text-white">
                          {column.name}
                          {active && <span className="text-cyan-400">{sort.direction === 'asc' ? '↑' : '↓'}</span>}
                        </span>
                        <span className={`block text-[9px] font-normal ${style.text}`}>
                          {style.label.toLowerCase()}
                        </span>
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/40">
              {loading && !page ? (
                <tr>
                  <td colSpan={columns.length + 1} className="py-12 text-center text-gray-500">
                    <Loader2 className="h-5 w-5 animate-spin mx-auto" />
                  </td>
                </tr>
              ) : page?.rows.length ? (
                page.rows.map((row, index) => (
                  <tr key={offset + index} className="hover:bg-zinc-900/30">
                    <td className="px-3 py-1.5 text-right font-mono text-[10px] text-gray-600 bg-zinc-900/20">
                      {offset + index + 1}
                    </td>
                    {columns.map((column) => {
                      const value = row[column.name];
                      const blank = value === null || value === undefined || value === '';
                      return (
                        <td
                          key={column.name}
                          className="px-3 py-1.5 border-l border-gray-800/30 max-w-[280px] truncate"
                          title={blank ? '' : String(value)}
                        >
                          {blank ? (
                            <span className="text-[10px] italic text-gray-700">blank</span>
                          ) : (
                            <span className={typeof value === 'number' ? 'font-mono text-gray-300' : 'text-gray-300'}>
                              {cell(value)}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={columns.length + 1} className="py-12 text-center text-xs text-gray-500">
                    No rows{applied ? ` matching “${applied}”` : ''}.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-2.5 border-t border-gray-800 flex items-center justify-between text-[11px] text-gray-500">
          <span>
            {total > 0
              ? `Showing ${count(offset + 1)}–${count(Math.min(offset + PAGE_SIZE, total))} of ${count(total)}`
              : 'Nothing to show'}
          </span>
          <span className="flex items-center gap-2">
            {loading && <Loader2 className="h-3 w-3 animate-spin" />}
            <button
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0 || loading}
              className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30"
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="font-mono">{pageNumber} / {pageCount}</span>
            <button
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total || loading}
              className="p-1 rounded hover:bg-zinc-800 disabled:opacity-30"
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
