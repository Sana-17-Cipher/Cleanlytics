'use client';

import React, { useState } from 'react';
import { Loader2, Printer, TriangleAlert } from 'lucide-react';

import { api } from '../lib/api';
import { count, exact, percent } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import type { QueryResult, SemanticModel, TableDetail } from '../lib/types';

interface ReportGeneratorProps {
  projectId: number;
  table: TableDetail;
  model: SemanticModel;
}

interface Section {
  title: string;
  description: string;
  result: QueryResult;
}

/**
 * Printable report.
 *
 * Everything here is read back from the analysis engine: the same quality
 * score the Analysis screen shows, and breakdowns computed by the same query
 * endpoint the dashboard uses. The previous version recomputed a different
 * quality score with a different formula, so the two screens disagreed about
 * the same file, and its "trend" chart plotted categories sorted by size.
 */
export default function ReportGenerator({ projectId, table, model }: ReportGeneratorProps) {
  const [title, setTitle] = useState(`${table.table_name} report`);
  const [organisation, setOrganisation] = useState('');
  const [author, setAuthor] = useState('');
  const profile = table.profile;
  const summary = profile?.summary;

  const { data: sections, error, isStale: loading } = useAsync(async () => {
    const chosen = model.suggestions.slice(0, 4);
    const built: Section[] = [];
    for (const suggestion of chosen) {
      try {
        const result = await api.query(projectId, { ...suggestion.spec, limit: 15 });
        if (result.rows.length > 0) {
          built.push({ title: suggestion.title, description: suggestion.description, result });
        }
      } catch {
        // One breakdown failing should not cost the whole report.
      }
    }
    return built;
  }, [projectId, model.suggestions.map((s) => s.id).join(',')]);

  if (!profile || !summary) {
    return (
      <div className="glass-panel rounded-xl p-10 text-center text-sm text-gray-400">
        This table has not been analysed yet.
      </div>
    );
  }

  const findings = table.quality?.findings ?? [];
  const measures = profile.columns.filter((c) => c.semantic_role === 'measure');

  return (
    <div className="space-y-5 animate-fade-in">
      {/* Controls, hidden when printing */}
      <div className="no-print space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight text-white">Report</h2>
            <p className="text-xs text-gray-400 mt-1">
              Built from the same analysis as every other screen. Print to PDF from your browser.
            </p>
          </div>
          <button
            onClick={() => window.print()}
            disabled={loading}
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shrink-0 disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" /> Save as PDF
          </button>
        </div>

        <div className="glass-panel rounded-xl border border-gray-800 p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="space-y-1">
            <span className="text-[11px] font-semibold text-gray-400">Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full glass-input text-xs" />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-semibold text-gray-400">Organisation</span>
            <input
              value={organisation}
              onChange={(e) => setOrganisation(e.target.value)}
              placeholder="optional"
              className="w-full glass-input text-xs"
            />
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-semibold text-gray-400">Prepared by</span>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="optional"
              className="w-full glass-input text-xs"
            />
          </label>
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-300 text-xs">{error}</div>
        )}
      </div>

      {/* The report itself */}
      <div className="printable-report bg-white text-gray-900 rounded-xl p-10 space-y-9">
        <header className="border-b-2 border-gray-900 pb-6">
          <h1 className="text-3xl font-bold">{title}</h1>
          <p className="text-sm text-gray-600 mt-2">
            {[organisation, author].filter(Boolean).join(' · ')}
            {(organisation || author) && ' · '}
            {new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Source: {table.source_file}
            {table.source_sheet ? ` (sheet “${table.source_sheet}”)` : ''}
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-lg font-bold border-b border-gray-300 pb-1">What is in this data</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <ReportStat label="Rows" value={count(summary.rows)} />
            <ReportStat label="Columns" value={String(summary.columns)} />
            <ReportStat label="Quality score" value={`${summary.quality_score}%`} />
            <ReportStat
              label="Missing values"
              value={`${count(summary.total_missing)} (${percent(summary.total_missing / Math.max(summary.total_cells, 1))})`}
            />
          </div>
          <p className="text-sm text-gray-700 leading-relaxed">
            The quality score combines completeness ({summary.quality_components.completeness}%),
            uniqueness ({summary.quality_components.uniqueness}%),
            consistency ({summary.quality_components.consistency}%) and
            validity ({summary.quality_components.validity}%), weighted 35/25/20/20.
            {summary.duplicate_rows_measured
              ? ` ${count(summary.duplicate_rows)} duplicate rows were found.`
              : ' The table was too large to check for duplicate rows.'}
          </p>
        </section>

        {measures.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-lg font-bold border-b border-gray-300 pb-1">Key figures</h2>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-gray-100">
                  {['Measure', 'Total', 'Average', 'Median', 'Lowest', 'Highest'].map((heading) => (
                    <th key={heading} className="p-2 text-left font-semibold border border-gray-300">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {measures.map((measure) => (
                  <tr key={measure.name}>
                    <td className="p-2 border border-gray-300 font-medium">
                      {measure.name}
                      {measure.additivity === 'non_additive' && (
                        <span className="block text-[10px] text-gray-500">
                          a rate or price, so the total is not meaningful
                        </span>
                      )}
                    </td>
                    <td className="p-2 border border-gray-300 font-mono">
                      {measure.additivity === 'non_additive' ? '—' : exact(measure.statistics.sum)}
                    </td>
                    <td className="p-2 border border-gray-300 font-mono">{exact(measure.statistics.mean)}</td>
                    <td className="p-2 border border-gray-300 font-mono">{exact(measure.statistics.median)}</td>
                    <td className="p-2 border border-gray-300 font-mono">{exact(measure.statistics.min)}</td>
                    <td className="p-2 border border-gray-300 font-mono">{exact(measure.statistics.max)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Working out the breakdowns…
          </div>
        ) : (
          (sections ?? []).map((section) => (
            <section key={section.title} className="space-y-3">
              <h2 className="text-lg font-bold border-b border-gray-300 pb-1">{section.title}</h2>
              <p className="text-sm text-gray-600">{section.description}</p>
              {section.result.warnings.map((warning) => (
                <p key={warning} className="text-xs text-amber-700 flex items-start gap-1.5">
                  <TriangleAlert className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {warning}
                </p>
              ))}
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-100">
                    {section.result.fields.map((field) => (
                      <th key={field.key} className="p-2 text-left font-semibold border border-gray-300">
                        {field.key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {section.result.rows.map((row, index) => (
                    <tr key={index}>
                      {section.result.fields.map((field) => {
                        const value = row[field.key];
                        return (
                          <td key={field.key} className="p-2 border border-gray-300 font-mono">
                            {value === null || value === undefined
                              ? '—'
                              : typeof value === 'number' ? exact(value) : String(value)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-gray-500">
                Calculated from {section.result.base_table_name}
                {section.result.joined_tables.length > 0 &&
                  `, joined to ${section.result.joined_tables.join(' and ')}`}
                .
              </p>
            </section>
          ))
        )}

        {findings.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-lg font-bold border-b border-gray-300 pb-1">Data quality notes</h2>
            <ul className="space-y-2 text-sm">
              {findings.slice(0, 10).map((finding) => (
                <li key={finding.id} className="flex gap-2">
                  <span className="font-bold text-gray-500">·</span>
                  <span>
                    <span className="font-semibold">{finding.title}.</span> {finding.detail}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="pt-4 border-t border-gray-300 text-xs text-gray-500">
          Produced by CLEANYTICS from {table.source_file}. All figures are calculated directly from the
          data with no estimation or sampling.
        </footer>
      </div>

      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; }
          .printable-report {
            position: absolute; inset: 0; margin: 0; border-radius: 0;
            box-shadow: none; width: 100%;
          }
          aside, nav { display: none !important; }
        }
      `}</style>
    </div>
  );
}

function ReportStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-gray-50">
      <p className="text-[11px] text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-xl font-bold mt-0.5">{value}</p>
    </div>
  );
}
