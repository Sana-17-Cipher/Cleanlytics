'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, Printer, RefreshCw, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { count, exact, percent } from '../lib/format';
import type {
  AnalysisSuggestion, CellValue, ColumnProfile, QualityComponentName,
  QueryField, QuerySpec, QueryResult, SemanticModel, TableDetail,
} from '../lib/types';

interface ReportGeneratorProps {
  projectId: number;
  table: TableDetail;
  model: SemanticModel;
}
interface Section {
  suggestion: AnalysisSuggestion;
  result?: QueryResult;
  error?: string;
}
const DISPLAY_ROWS = 30;
const QUALITY_KEYS: QualityComponentName[] = ['completeness', 'uniqueness', 'consistency', 'validity'];

function reportDocument(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cleanlytics report</title><style>
    body{font:13px/1.6 Arial,sans-serif;color:#111;margin:28px;max-width:1050px}h1{font-size:26px}h2{font-size:19px;margin-top:28px;border-bottom:1px solid #bbb}h3{font-size:15px}section{margin:22px 0}article{margin:18px 0}p{margin:8px 0}li{margin:8px 0}figure{margin:20px 0}figcaption{font-weight:bold;margin:12px 0}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #ccc;padding:7px;text-align:left;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px}svg[data-report-chart]{display:block;width:100%;height:auto;break-inside:avoid}svg:not([data-report-chart]){display:none}footer{margin-top:24px;border-top:1px solid #ccc;padding-top:12px}@page{size:A4;margin:16mm}@media print{body{margin:0;font-size:11px}}
  </style></head><body>${body}</body></html>`;
}

function display(value: CellValue | undefined): string {
  if (value == null) return '—';
  return typeof value === 'number' ? exact(value) : String(value);
}
function numeric(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? exact(value) : '—';
}
function belongsToTable(suggestion: AnalysisSuggestion, tableId: number): boolean {
  return (suggestion.spec.base_table_id ?? suggestion.spec.measures?.[0]?.table_id) === tableId;
}
function measureNote(column: ColumnProfile): string {
  const notes: string[] = [];
  if (column.needs_review) notes.push('Field classification needs review.');
  if (column.additivity === 'semi_additive') notes.push('Snapshot values: no total across time. These statistics are not a closing balance.');
  if (column.additivity === 'non_additive') notes.push('Non-additive field: no total shown.');
  if (column.logical_type === 'percentage') notes.push('The average is unweighted; a weighted rate requires numerator and denominator fields.');
  if (column.statistics.quantiles_approximate) notes.push('Median is approximate.');
  if ((column.statistics.non_finite_count ?? 0) > 0) notes.push('Non-finite numeric values are excluded from statistics.');
  return notes.join(' ');
}

/** Reset report title and query state when changing project or table. */
export default function ReportGenerator(props: ReportGeneratorProps) {
  return <Report key={`${props.projectId}:${props.table.id}`} {...props} />;
}
function Report({ projectId, table, model }: ReportGeneratorProps) {
  const [title, setTitle] = useState(`${table.table_name} report`);
  const [organisation, setOrganisation] = useState('');
  const [author, setAuthor] = useState('');
  const [notes, setNotes] = useState('');
  const [includeSql, setIncludeSql] = useState(false);
  const [includeAppendix, setIncludeAppendix] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const [goals, setGoals] = useState<ReportGoal[]>([]);
  const [targetMetric, setTargetMetric] = useState('');
  const [targetValue, setTargetValue] = useState('');
  const [targetDirection, setTargetDirection] = useState<'higher' | 'lower'>('higher');
  const [targetError, setTargetError] = useState<string | null>(null);
  const [builtFor, setBuiltFor] = useState<{ chosen: AnalysisSuggestion[]; table: TableDetail; revision: number; projectId: number } | null>(null);
  const reportRef = useRef<HTMLDivElement>(null);
  const profile = table.profile;
  const summary = profile?.summary;

  const chosen = useMemo(() => {
    const source = model.dashboard_plan?.version === 1 ? model.dashboard_plan.widgets : model.suggestions;
    const ids = new Set<string>();
    return source.filter((suggestion) => {
      if (!belongsToTable(suggestion, table.id) || ids.has(suggestion.id)) return false;
      ids.add(suggestion.id);
      return true;
    });
  }, [model, table.id]);

  const ready = !loading && generatedAt !== null && builtFor?.chosen === chosen &&
    builtFor.table === table && builtFor.revision === revision && builtFor.projectId === projectId;
  const snapshot = useMemo<DashboardSnapshot | null>(() => ready ? {
    origin: 'report', projectId, sourceId: table.id, sourceName: table.table_name,
    sourceRows: table.row_count, purpose: title,
    capturedAt: generatedAt!, resultsAt: generatedAt!, analyses: sections,
    selection: [
      `Source: ${table.table_name}`,
      'Scope: supported report analyses for the selected table. Dashboard filters and hidden-chart settings are not automatically inherited.',
      chosen.some((item) => item.spec.filters?.length)
        ? 'Some analyses contain their own filters. Their scopes are listed with the query evidence.'
        : 'No query filters: these analyses cover the selected table as defined by their queries.',
    ],
  } : null, [ready, projectId, table, title, generatedAt, sections, chosen]);
  const business = useMemo(() => snapshot ? buildFindings(snapshot, goals) : null, [snapshot, goals]);
  const story = useMemo(() => snapshot && business ? buildReportStory(snapshot, business) : null, [snapshot, business]);
  function evidenceTitles(ids: string[]) {
    return ids.map((id) => sections.find((section) => section.suggestion.id === id)?.suggestion.title ?? id).join(' · ');
  }

  useEffect(() => {
    let cancelled = false;
    async function build() {
      setLoading(true); setSections([]); setGeneratedAt(null);
      const built: Section[] = Array(chosen.length);
      let cursor = 0;
      async function worker() {
        while (!cancelled && cursor < chosen.length) {
          const index = cursor++;
          const suggestion = chosen[index];
          try {
            const result = await api.query(projectId, suggestion.spec);
            built[index] = { suggestion, result };
          } catch (error) {
            built[index] = { suggestion, error: error instanceof Error ? error.message : 'Analysis unavailable.' };
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, chosen.length) }, () => worker()));
      if (cancelled) return;
      setSections(built); setGeneratedAt(new Date().toISOString());
      setBuiltFor({ chosen, table, revision, projectId }); setLoading(false);
    }
    void build();
    return () => { cancelled = true; };
  }, [projectId, chosen, table, revision]);

  function addTarget() {
    const value = Number(targetValue);
    if (!ready || !business?.metrics.some((metric) => metric.id === targetMetric) || !targetValue.trim() || !Number.isFinite(value)) {
      setTargetError('Choose an available measure and enter a numeric target for the scope shown in this report.'); return;
    }
    setGoals((current) => [...current.filter((goal) => goal.metricId !== targetMetric),
      { metricId: targetMetric, target: value, direction: targetDirection }]);
    setTargetValue(''); setTargetError(null);
  }
  function downloadFindings() {
    if (!snapshot || !business || !story) return;
    const header = [title, organisation && `Organisation: ${organisation}`, author && `Prepared by: ${author}`].filter(Boolean).join('\n');
    const base = findingsMarkdown(snapshot, business, [header, notes].filter(Boolean).join('\n\n'), includeAppendix);
    const images: Record<string, string> = {};
    reportRef.current?.querySelectorAll<SVGSVGElement>('svg[data-report-chart]').forEach((svg) => {
      const bytes = new TextEncoder().encode(svg.outerHTML);
      images[svg.dataset.reportChart!] = `data:image/svg+xml;base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))}`;
    });
    const scopeStart = base.indexOf('\n## Scope\n');
    const authorStart = base.indexOf('\n## Author notes\n');
    const limitationsStart = base.indexOf('\n## Limitations\n');
    const appendixStart = base.indexOf('\n## Supporting measures\n');
    const authorNotes = authorStart >= 0 ? base.slice(authorStart, limitationsStart) : '';
    const appendix = includeAppendix && appendixStart >= 0 ? base.slice(appendixStart) : '';
    const content = base.slice(0, scopeStart) + '\n' + reportStoryMarkdown(story, images, includeAppendix) + authorNotes + appendix;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${table.table_name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60) || 'report'}-findings.md`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadReport() {
    if (!reportRef.current || !ready) return;
    const url = URL.createObjectURL(new Blob([reportDocument(reportRef.current.outerHTML)], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${table.table_name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 60) || 'report'}-report.html`;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Print an isolated document so application navigation cannot enter the PDF. */
  function printReport() {
    if (!reportRef.current || !ready) return;
    setPrintError(null);
    const popup = window.open('', '_blank', 'width=1000,height=800');
    if (!popup) {
      setPrintError('The print window was blocked. Allow pop-ups for this site, then try again.');
      return;
    }
    const doc = popup.document;
    doc.open();
    doc.write(reportDocument(reportRef.current.outerHTML));
    doc.close();
    popup.opener = null;
    popup.focus();
    popup.setTimeout(() => popup.print(), 150);
  }
  if (!profile || !summary) return <div className="rounded-xl border border-gray-800 p-8 text-sm text-gray-400">This table has not been analysed yet.</div>;

  const findings = table.quality?.findings ?? [];
  const measures = profile.columns.filter((column) => column.semantic_role === 'measure');
  const missing = summary.total_missing_including_blanks ?? summary.total_missing;
  const failed = sections.filter((section) => section.error).length;
  const review = profile.columns.filter((column) => column.needs_review);
  const qualityAvailable = summary.quality_score_available !== false && Number.isFinite(summary.quality_score);
  const sampled = summary.patterns_sampled || profile.columns.some((column) => column.pattern_sampled);
  const approximate = summary.distinct_counts_approximate || profile.columns.some((column) => column.distinct_is_approximate);
  const input = 'w-full rounded-lg border border-gray-700 bg-zinc-900 p-2 text-xs text-gray-200';

  return <div className="space-y-5">
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-xl font-bold text-white">Report</h2><p className="text-xs text-gray-400">Insights for {table.table_name}: what the patterns mean and where to investigate next.</p></div>
        <div className="flex gap-2">
          <button type="button" disabled={!ready} onClick={() => setRevision((value) => value + 1)} className="flex items-center gap-2 rounded-lg border border-gray-700 p-2 text-xs text-gray-200 disabled:opacity-50"><RefreshCw className="h-4 w-4" />Refresh analyses</button>
          <button type="button" disabled={!ready} onClick={downloadFindings} className="flex items-center gap-2 rounded-lg border border-gray-700 p-2 text-xs text-gray-200 disabled:opacity-50"><Download className="h-4 w-4" />Download findings</button>
          <button type="button" disabled={!ready} onClick={downloadReport} className="flex items-center gap-2 rounded-lg border border-gray-700 p-2 text-xs text-gray-200 disabled:opacity-50"><Download className="h-4 w-4" />Download report</button>
          <button type="button" disabled={!ready} onClick={printReport} className="flex items-center gap-2 rounded-lg bg-emerald-600 p-2 text-xs text-white disabled:opacity-50"><Printer className="h-4 w-4" />Print / Save as PDF</button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="text-xs text-gray-400">Title<input className={input} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="text-xs text-gray-400">Organisation<input className={input} value={organisation} onChange={(event) => setOrganisation(event.target.value)} /></label>
        <label className="text-xs text-gray-400">Prepared by<input className={input} value={author} onChange={(event) => setAuthor(event.target.value)} /></label>
      </div>
      <label className="block text-xs text-gray-400">Your notes<textarea className={input} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add business context or decisions." /></label>
      {business && business.metrics.length > 0 && <div className="space-y-2 rounded-lg border border-gray-800 p-3">
        <p className="text-xs text-gray-400">Optional performance targets for the source, units and query scope shown below</p>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          <select aria-label="Target measure" className={input} value={targetMetric} onChange={(event) => setTargetMetric(event.target.value)}>
            <option value="">Choose measure</option>{business.metrics.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}
          </select>
          <input aria-label="Target value" className={input} type="number" step="any" value={targetValue} onChange={(event) => setTargetValue(event.target.value)} placeholder="Target value" />
          <select aria-label="Target direction" className={input} value={targetDirection} onChange={(event) => setTargetDirection(event.target.value as 'higher' | 'lower')}>
            <option value="higher">Higher is desired</option><option value="lower">Lower is desired</option>
          </select>
          <button type="button" onClick={addTarget} className="rounded-lg border border-gray-700 p-2 text-xs text-emerald-300">Add / update target</button>
        </div>
        {goals.filter((goal) => business.metrics.some((metric) => metric.id === goal.metricId)).map((goal) => <p key={goal.metricId} className="text-xs text-gray-400">
          {business.metrics.find((metric) => metric.id === goal.metricId)?.label}: {reportNumber(goal.target)} · {goal.direction === 'higher' ? 'higher' : 'lower'} desired{' '}
          <button type="button" className="text-emerald-300" onClick={() => setGoals((current) => current.filter((entry) => entry.metricId !== goal.metricId))}>Remove target</button>
        </p>)}
        {targetError && <p role="alert" className="text-xs text-amber-300">{targetError}</p>}
      </div>}
      <label className="flex items-center gap-2 text-xs text-gray-400"><input aria-label="Include supporting appendix" type="checkbox" checked={includeAppendix} onChange={(event) => setIncludeAppendix(event.target.checked)} />Include detailed methodology, supporting values, query tables and data quality appendix</label>
      {includeAppendix && <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" checked={includeSql} onChange={(event) => setIncludeSql(event.target.checked)} />Include SQL for each analysis</label>}
      <p className="text-xs text-gray-500">Download report saves HTML with graphs; Print saves the complete report as PDF. Download findings saves Markdown with embedded SVG images, whose display depends on your Markdown viewer. Notes and targets are session-only; the supporting appendix is included only when selected.</p>
      {printError && <p role="alert" className="text-xs text-red-300">{printError}</p>}
    </div>

    <div ref={reportRef} className="rounded-xl bg-white p-6 text-gray-900 space-y-7 md:p-10">
      <header><h1 className="text-3xl font-bold">{title || `${table.table_name} report`}</h1>
        <p className="mt-2 text-sm text-gray-600">{[organisation, author].filter(Boolean).join(' · ')}</p>
        <p className="text-xs text-gray-500">Source: {table.source_file}{table.source_sheet ? ` · Sheet: ${table.source_sheet}` : ''} · Table: {table.table_name}</p>
        {generatedAt && <p className="text-xs text-gray-500">Analyses generated: {new Date(generatedAt).toLocaleString()}</p>}
        {table.updated_at && <p className="text-xs text-gray-500">Table metadata last updated: {new Date(table.updated_at).toLocaleString()}</p>}
      </header>
      {!ready ? <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Calculating business findings…</p> : business && story && <>
        <section><h2 className="text-lg font-bold">Key findings across analyses</h2>
          {story.keyFindings.length ? <ul className="mt-3 space-y-4 text-sm">{story.keyFindings.map((finding) => <li key={finding.id}>
            <b>{finding.title}: </b>{reportFindingSummary(finding)}
            <p className="mt-1 text-xs text-gray-500">Evidence: {evidenceTitles(finding.evidenceIds)}</p>
          </li>)}</ul> : <p className="mt-2 text-sm">The available results do not support an interpretation. Add a matching total, paired sales/profit analysis, comparable periods or a target to explain performance.</p>}
        </section>
        {includeAppendix && <section><h2 className="text-lg font-bold">Supporting business measures</h2>
          {business.metrics.length ? <table className="mt-3 w-full border-collapse text-sm"><thead><tr><th className="border border-gray-300 p-2 text-left">Measure</th><th className="border border-gray-300 p-2 text-right">Value</th><th className="border border-gray-300 p-2 text-left">Evidence / scope</th></tr></thead>
            <tbody>{business.metrics.map((metric) => <tr key={metric.id}><td className="border border-gray-300 p-2">{metric.label}</td><td className="border border-gray-300 p-2 text-right">{reportNumber(metric.value)}</td><td className="border border-gray-300 p-2">{sections.find((section) => section.suggestion.id === metric.analysisId)?.suggestion.title ?? metric.analysisId}</td></tr>)}</tbody></table>
            : <p className="mt-2 text-sm">No complete numeric aggregate is available for these analyses.</p>}
        </section>}
        <section><h2 className="text-lg font-bold">Selected graphs and their insights</h2>
          {story.charts.length ? story.charts.map((chart, index) => <figure id={`report-figure-${index + 1}`} key={chart.id} className="mt-6 space-y-3 border-b border-gray-200 pb-5">
            <figcaption className="text-base font-semibold">{index + 1}. {chart.title}</figcaption>
            <ReportChartVisual chart={chart} />
            {chart.insights.map((finding) => <article key={finding.id} className="space-y-1 text-sm">
              <p><b>Key insight: </b>{finding.text}</p>
              {finding.action && <p><b>What to investigate: </b>{finding.action}</p>}
            </article>)}
            <p className="text-xs text-gray-600"><b>Note: </b>{reportChartNote(chart)}</p>
            <p className="text-xs text-gray-500">Evidence: {evidenceTitles(chart.evidenceIds)}</p>
          </figure>) : <p className="mt-2 text-sm">No supported multi-point query result is available for a relevant graph. Single aggregate totals do not establish a trend.</p>}
        </section>
        <section><h2 className="text-lg font-bold">Trends and potential anomalies</h2>
          {story.trendsAndAnomalies.length ? <ul className="mt-3 space-y-2 text-sm">{story.trendsAndAnomalies.map((finding) => {
            const figure = reportFindingFigure(story, finding);
            return <li key={finding.id}>{figure
              ? <a className="text-emerald-800 underline" href={`#report-figure-${figure}`}>{finding.title} — see Figure {figure}</a>
              : reportFindingSummary(finding)}</li>;
          })}</ul> : <p className="mt-2 text-sm">No additional unusual pattern was identified in the available evidence; this does not establish that the dataset is anomaly-free.</p>}
        </section>
        <section><h2 className="text-lg font-bold">Recommendations</h2>
          {story.recommendations.length ? <ol className="mt-3 list-inside list-decimal space-y-3 text-sm">{story.recommendations.map((recommendation) => <li key={recommendation.text}>{recommendation.text}
            <p className="mt-1 text-xs text-gray-500">Evidence: {evidenceTitles(recommendation.evidenceIds)}</p></li>)}</ol>
            : <p className="mt-2 text-sm">The evidence does not establish a specific corrective action. Obtain business context and comparable results before deciding on one.</p>}
        </section>
        <section><h2 className="text-lg font-bold">Conclusion</h2><p className="mt-2 text-sm">{story.conclusion}</p></section>
        <section><h2 className="text-lg font-bold">Methodology and notes</h2>
          <ul className="mt-3 space-y-2 text-xs text-gray-600">{story.methodology.map((note) => <li key={note}>{note}</li>)}</ul>
          {includeAppendix && <div className="mt-4 space-y-3 text-xs text-gray-600"><h3 className="font-semibold">Detailed methodology</h3><p>{story.omissions}</p>
            {story.detailedNotes.map((group) => <div key={group.title}><h4 className="font-semibold">{group.title}</h4><ul className="mt-1 space-y-1">{group.notes.map((note) => <li key={note}>{note}</li>)}</ul></div>)}
          </div>}
        </section>
      </>}
      {notes.trim() && <section><h2 className="text-lg font-bold">Author notes</h2><p className="whitespace-pre-wrap text-sm">{notes}</p></section>}
      {includeAppendix && <>
      <section><h2 className="text-xl font-bold">Supporting appendix</h2><p className="mt-2 text-sm">Values and quality checks supporting the insights above.</p></section>
      <section><h2 className="text-lg font-bold">Dataset overview</h2>
        <p className="mt-2 text-xs text-gray-600">The dataset overview and profile statistics below describe the entire cached source table. They do not inherit individual query filters.</p>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <ReportStat label="Rows" value={count(summary.rows)} /><ReportStat label="Columns" value={count(summary.columns)} />
          <ReportStat label="Indicative quality" value={qualityAvailable ? `${exact(summary.quality_score)} / 100` : 'Not measured'} />
          <ReportStat label={summary.total_missing_including_blanks === undefined ? 'NULL cells' : 'Missing cells, including blanks'} value={`${count(missing)} (${percent(missing / Math.max(summary.total_cells, 1))})`} />
        </div>
        <p className="mt-3 text-sm">{summary.quality_note ?? 'Quality scores summarise measured checks; they do not establish business accuracy.'}</p>
        <table className="mt-3 w-full border-collapse text-sm"><thead><tr>{['Check', 'Score', 'Actual weight'].map((heading) => <th key={heading} className="border border-gray-300 p-2 text-left">{heading}</th>)}</tr></thead>
          <tbody>{QUALITY_KEYS.map((key) => {
            const measured = summary.quality_components_measured?.[key];
            return <tr key={key}><td className="border border-gray-300 p-2 capitalize">{key}</td><td className="border border-gray-300 p-2">{measured === false ? 'Not measured' : `${exact(summary.quality_components[key])} / 100${measured === undefined ? ' (legacy measurement status unavailable)' : ''}`}</td><td className="border border-gray-300 p-2">{percent(summary.quality_weights[key])}</td></tr>;
          })}</tbody></table>
        <p className="mt-2 text-sm">{summary.duplicate_rows_measured ? `${count(summary.duplicate_rows)} duplicate rows detected.` : 'Duplicate rows were not measured; no duplicate-free claim is made.'}</p>
        {sampled && <ReportWarning>Pattern checks were sampled. Some invalid-value counts are estimates.</ReportWarning>}
        {approximate && <ReportWarning>Some distinct counts are approximate and do not verify key uniqueness.</ReportWarning>}
        {review.length > 0 && <ReportWarning>Review the inferred meaning of: {review.map((column) => column.name).join(', ')}.</ReportWarning>}
      </section>
      {measures.length > 0 && <section><h2 className="text-lg font-bold">Profile statistics</h2>
        <p className="mt-2 text-xs text-gray-600">Cached field statistics. Recognised text amounts may have no numeric profile statistics; query analyses below provide their parsed aggregates. Percentage values follow the source scale in this table.</p>
        <div className="overflow-x-auto"><table className="mt-3 w-full border-collapse text-sm"><thead><tr>{['Field', 'Sum', 'Mean', 'Median', 'Minimum', 'Maximum'].map((heading) => <th key={heading} className="border border-gray-300 p-2 text-left">{heading}</th>)}</tr></thead><tbody>{measures.map((column) => <tr key={column.name}>
          <td className="border border-gray-300 p-2"><b>{column.name}</b><p className="text-xs text-gray-600">{measureNote(column)}</p></td>
          {[column.additivity === 'additive' && !column.needs_review ? column.statistics.sum : null, column.statistics.mean, column.statistics.median, column.statistics.min, column.statistics.max].map((value, index) => <td key={index} className="border border-gray-300 p-2">{numeric(value)}</td>)}
        </tr>)}</tbody></table></div>
      </section>}
      <section><h2 className="text-lg font-bold">Query analyses</h2>
        {!ready ? <p role="status" className="mt-3 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" />Calculating analyses…</p> : <>
          {failed > 0 && <ReportWarning>{failed} analyses could not be calculated. Their errors are included below; the report is incomplete.</ReportWarning>}
          {sections.length === 0 && <p className="mt-2 text-sm">No supported suggestions were generated with this table as their source. Review classifications and relationships in the data model.</p>}
          {sections.map((section) => <AnalysisSection key={section.suggestion.id} section={section} includeSql={includeSql} />)}
        </>}
      </section>
      <section><h2 className="text-lg font-bold">Data quality findings</h2>
        {!table.quality ? <p className="mt-2 text-sm">Quality findings are unavailable.</p> : findings.length === 0 ? <p className="mt-2 text-sm">No findings were reported by the implemented checks. This does not establish that the dataset is error-free.</p> : <ul className="mt-3 space-y-3">{findings.map((finding) => <li key={finding.id} className="text-sm"><b>{finding.title}</b> · {finding.severity} priority<p>{finding.detail}</p><p className="text-xs text-gray-600">{finding.why}</p>{finding.actions.filter((action) => action.recommended).map((action, index) => <p key={index} className="text-xs text-gray-600">Suggested action: {action.label}. {action.consequence}{action.destructive ? ' This changes or removes data; review before applying.' : ''}</p>)}</li>)}</ul>}
      </section>
      </>}
      <footer className="border-t border-gray-300 pt-3 text-xs text-gray-500">Produced by CLEANYTICS. See methodology and notes for the scope of these findings.</footer>
    </div>
  </div>;
}
function AnalysisSection({ section, includeSql }: { section: Section; includeSql: boolean }) {
  const { suggestion, result, error } = section;
  return <section className="mt-5 space-y-2"><h3 className="font-bold">{suggestion.title}</h3><p className="text-sm text-gray-600">{suggestion.description}</p>
    <p className="text-xs text-gray-500">Query scope: {suggestion.spec.filters?.length
      ? suggestion.spec.filters.map((filter) => `${filter.column} ${filter.operator} ${JSON.stringify(filter.value)}`).join('; ')
      : 'No query filters'}.</p>
    {error && <ReportWarning>Unavailable: {error}</ReportWarning>}
    {result && <>
      {result.warnings.map((warning, index) => <ReportWarning key={index}>{warning}</ReportWarning>)}
      {result.truncated && <ReportWarning>The query limit was reached. Results are partial.</ReportWarning>}
      {result.rows.length > DISPLAY_ROWS && <ReportWarning>Showing the first {DISPLAY_ROWS} of {result.row_count} returned rows in this report.</ReportWarning>}
      {result.rows.length === 0 ? <p className="text-sm">No matching rows.</p> : <table className="w-full border-collapse text-sm"><thead><tr>{result.fields.map((field) => <th key={field.key} className="border border-gray-300 p-2 text-left">{field.key}</th>)}</tr></thead><tbody>{result.rows.slice(0, DISPLAY_ROWS).map((row, index) => <tr key={index}>{result.fields.map((field) => <td key={field.key} className="border border-gray-300 p-2 break-words">{display(row[field.key])}</td>)}</tr>)}</tbody></table>}
      <p className="text-xs text-gray-500">Calculated from {result.base_table_name}{result.joined_tables.length ? `, joined to ${result.joined_tables.join(', ')}` : ''}.</p>
      {includeSql && <pre className="whitespace-pre-wrap break-words rounded bg-gray-100 p-2 text-xs">{result.sql}</pre>}
    </>}
  </section>;
}
function ReportWarning({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 flex items-start gap-2 text-xs text-amber-800"><TriangleAlert className="h-4 w-4 shrink-0" /><span>{children}</span></p>;
}
function ReportStat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-gray-200 bg-gray-50 p-3"><p className="text-xs text-gray-500">{label}</p><p className="mt-1 text-xl font-bold">{value}</p></div>;
}

// Data-grounded findings and standalone report visuals.

export interface ReportAnalysis {
  suggestion: AnalysisSuggestion;
  result?: QueryResult;
  error?: string;
}
export interface DashboardSnapshot {
  origin?: 'dashboard' | 'report';
  projectId: number;
  sourceId: number;
  sourceName: string;
  sourceRows: number;
  purpose: string;
  selection: string[];
  capturedAt: string;
  resultsAt: string;
  analyses: ReportAnalysis[];
}
export interface ReportGoal {
  metricId: string;
  target: number;
  direction: 'higher' | 'lower';
}
export interface ReportMetric {
  id: string;
  label: string;
  value: number;
  analysisId: string;
  field: QueryField;
}
export interface ReportFinding {
  id: string;
  kind: 'performance' | 'contribution' | 'ranking' | 'loss' | 'trend' | 'target' | 'opportunity' | 'anomaly';
  title: string;
  text: string;
  attention: boolean;
  evidenceIds: string[];
  note?: string;
  action?: string;
  meaning?: string;
  priority?: number;
}
export interface FindingsReport {
  metrics: ReportMetric[];
  findings: ReportFinding[];
  summary: ReportFinding[];
  limitations: string[];
}
const format = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });
export const reportNumber = (value: number) => format.format(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const normalizedName = (field: QueryField) => (field.column ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
const profitName = (field: QueryField) => /\b(profit|earnings)\b/i.test(normalizedName(field));
const salesName = (field: QueryField) => /\b(sales|revenue|turnover)\b/i.test(normalizedName(field));
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function sourceId(spec: QuerySpec) { return spec.base_table_id ?? spec.measures?.[0]?.table_id; }
function scopeKey(spec: QuerySpec) {
  return stable({ source: sourceId(spec), filters: [...(spec.filters ?? [])].map(stable).sort() });
}
function measureKey(field: QueryField) {
  return stable([field.table_id, field.column, field.aggregation]);
}
function measureMatches(a: QueryField, b: QueryField) { return measureKey(a) === measureKey(b); }
function describeGroup(row: QueryResult['rows'][number], dimensions: QueryField[]) {
  return dimensions.map((field) => `${field.column ?? field.key}: ${String(row[field.key] ?? '(Missing or unmatched)')}`).join(' · ');
}
function metricLabel(field: QueryField) {
  const name = field.column?.replace(/[_-]/g, ' ') ?? 'records';
  return `${({ sum: 'Total', avg: 'Average', count: 'Count of', count_distinct: 'Distinct', min: 'Minimum', max: 'Maximum', median: 'Median' } as Record<string, string>)[field.aggregation ?? ''] ?? field.aggregation ?? ''} ${name}`.trim();
}

function dimensionSignature(dimensions: QueryField[]) {
  return stable(dimensions.map((field) => [field.table_id, field.column, field.date_part]));
}

/** Match profit and sales by their exact group keys and query scope, never by row position. */
function groupProfitability(analyses: ReportAnalysis[]): ReportFinding[] {
  const findings: ReportFinding[] = [];
  const seen = new Set<string>();
  const ordered = [...analyses].sort((a, b) => Number(a.result!.truncated) - Number(b.result!.truncated));
  for (const analysis of ordered) {
    const result = analysis.result!;
    const dimensions = result.fields.filter((field) => field.kind === 'dimension');
    const period = dimensions.length === 1 && ['day', 'week', 'month', 'quarter', 'year'].includes(dimensions[0].date_part ?? '');
    if (!dimensions.length || (dimensions.some((field) => field.date_part) && !period)) continue;
    const profit = result.fields.find((field) => field.kind === 'measure' && field.aggregation === 'sum' && profitName(field));
    if (!profit) continue;
    const candidates = [analysis, ...ordered.filter((item) => item !== analysis)];
    const salesAnalysis = candidates.find((item) => scopeKey(item.suggestion.spec) === scopeKey(analysis.suggestion.spec) &&
      dimensionSignature(item.result!.fields.filter((field) => field.kind === 'dimension')) === dimensionSignature(dimensions) &&
      item.result!.fields.some((field) => field.kind === 'measure' && field.aggregation === 'sum' && salesName(field)));
    if (!salesAnalysis) continue;
    const salesResult = salesAnalysis.result!;
    const salesDimensions = salesResult.fields.filter((field) => field.kind === 'dimension');
    const sales = salesResult.fields.find((field) => field.kind === 'measure' && field.aggregation === 'sum' && salesName(field))!;
    const signature = stable([scopeKey(analysis.suggestion.spec), dimensionSignature(dimensions), measureKey(profit), measureKey(sales)]);
    if (seen.has(signature)) continue;
    const rowKey = (row: QueryResult['rows'][number], fields: QueryField[]) => stable(fields.map((field) => row[field.key]));
    const salesMap = new Map(salesResult.rows.map((row) => [rowKey(row, salesDimensions), row]));
    // Duplicate keys could create an ambiguous match, so no paired conclusion is produced.
    if (salesMap.size !== salesResult.rows.length || new Set(result.rows.map((row) => rowKey(row, dimensions))).size !== result.rows.length) continue;
    const paired = result.rows.flatMap((row) => {
      const match = salesMap.get(rowKey(row, dimensions));
      const p = row[profit.key], s = match?.[sales.key];
      if (!finite(p) || !finite(s) || s <= 0 || !finite(p / s)) return [];
      return [{ row, key: rowKey(row, dimensions), profit: p, sales: s, ratio: p / s }];
    });
    if (paired.length < 2) continue;
    seen.add(signature);
    const evidenceIds = [...new Set([analysis.suggestion.id, salesAnalysis.suggestion.id])];
    if (period) {
      const chronological = paired.filter((entry) => /^\d{4}-\d{2}-\d{2}/.test(String(entry.row[dimensions[0].key])))
        .sort((a, b) => String(a.row[dimensions[0].key]).localeCompare(String(b.row[dimensions[0].key])));
      if (chronological.length < 2) continue;
      const before = chronological[chronological.length - 2], after = chronological[chronological.length - 1];
      const salesChange = after.sales - before.sales, profitChange = after.profit - before.profit;
      if (salesChange > 0 && profitChange < 0) findings.push({ id: `growth-profit-gap:${signature}`, kind: 'trend', title: 'Higher sales coincide with lower profit', priority: 85, attention: true,
        text: `Between ${String(before.row[dimensions[0].key])} and ${String(after.row[dimensions[0].key])}, recorded Sales rise by ${reportNumber(salesChange)}, while Profit falls by ${reportNumber(Math.abs(profitChange))}. The profit-to-sales ratio moves from ${(before.ratio * 100).toFixed(1)}% to ${(after.ratio * 100).toFixed(1)}%.`,
        meaning: 'The increased sales amount is not accompanied by higher recorded profit in these two returned periods. If their coverage is comparable, this points to profit conversion as a priority for review.',
        action: 'First check that both periods are complete and equivalent. Then compare recorded costs, returns, discount treatment and product mix to explain the profit change.',
        evidenceIds, note: 'These are the last two matched returned periods with positive sales. They may be partial or non-consecutive. The ratio assumes comparable units and field definitions; the comparison does not establish a cause or a target miss.' });
      continue;
    }
    const revenueLeader = [...paired].sort((a, b) => b.sales - a.sales)[0];
    const profitLeader = [...paired].sort((a, b) => b.profit - a.profit)[0];
    const conversionLeader = [...paired].sort((a, b) => b.ratio - a.ratio)[0];
    const note = 'Comparisons cover matched returned groups with positive sales. The profit-to-sales ratios assume comparable field units and definitions. They are not independently verified accounting margins or evidence of a cause.';
    const group = (entry: typeof paired[number]) => describeGroup(entry.row, dimensions);
    if (revenueLeader.key !== profitLeader.key && profitLeader.profit > revenueLeader.profit) {
      findings.push({ id: `volume-profit:${signature}`, kind: 'performance', title: 'The sales leader is not the profit leader', priority: 85, attention: true,
        text: `${group(revenueLeader)} has the highest Sales among matched returned groups (${reportNumber(revenueLeader.sales)}), while ${group(profitLeader)} generates more Profit (${reportNumber(profitLeader.profit)} versus ${reportNumber(revenueLeader.profit)}). Their recorded profit-to-sales ratios are ${(revenueLeader.ratio * 100).toFixed(1)}% and ${(profitLeader.ratio * 100).toFixed(1)}%, respectively.`,
        meaning: 'Sales volume and profit generation point to different priorities. Growing the current sales leader alone may not strengthen the profit result as much as improving its profit conversion.',
        action: `Compare the product mix, recorded costs, returns and discounts in ${group(revenueLeader)} with ${group(profitLeader)} to identify which differences explain the conversion gap.`,
        evidenceIds, note });
    }
    const pairedSales = paired.reduce((sum, row) => sum + row.sales, 0);
    const pairedProfit = paired.reduce((sum, row) => sum + row.profit, 0);
    const baseline = pairedProfit / pairedSales;
    const gap = baseline - revenueLeader.ratio;
    if (finite(baseline) && baseline > 0 && gap >= 0.01 && revenueLeader.profit >= 0) {
      const benchmarkGap = revenueLeader.sales * baseline - revenueLeader.profit;
      if (finite(benchmarkGap)) findings.push({ id: `conversion-gap:${signature}`, kind: 'opportunity', title: 'The largest sales group has a profit-conversion gap', priority: 90, attention: true,
        text: `${group(revenueLeader)} converts recorded Sales into Profit at ${(revenueLeader.ratio * 100).toFixed(1)}%, versus ${(baseline * 100).toFixed(1)}% across all matched returned groups combined: a ${(gap * 100).toFixed(1)} percentage-point gap. At unchanged Sales, matching that combined ratio would correspond to ${reportNumber(benchmarkGap)} more Profit.`,
        meaning: 'Because this group has the largest recorded sales amount among the matched groups, its lower conversion makes it a useful place to investigate profitability improvement.',
        action: `Review the transactions in ${group(revenueLeader)} and quantify cost, discount, return and product-mix differences before choosing an intervention.`,
        evidenceIds, note: `${note} The combined ratio is sales-weighted. The additional-profit amount is an arithmetic benchmark, not a forecast or a promised improvement. A gap of at least one percentage point triggers this review prompt; it is not a performance target.` });
    }
    const conversionGap = conversionLeader.ratio - revenueLeader.ratio;
    if (conversionLeader.key !== revenueLeader.key && conversionGap >= 0.01) {
      findings.push({ id: `conversion-benchmark:${signature}`, kind: 'opportunity', title: 'A lower-volume group provides a profitability benchmark', priority: 65, attention: false,
        text: `${group(conversionLeader)} has a recorded profit-to-sales ratio of ${(conversionLeader.ratio * 100).toFixed(1)}%, compared with ${(revenueLeader.ratio * 100).toFixed(1)}% in the highest-Sales group, ${group(revenueLeader)}. The difference is ${(conversionGap * 100).toFixed(1)} percentage points.`,
        meaning: 'The returned groups show that higher sales volume does not necessarily come with stronger profit conversion. The higher-ratio group provides a comparison to learn from.',
        action: `Check whether ${group(conversionLeader)} has a comparable product mix, volume and cost allocation before using its ratio as an operational benchmark.`,
        evidenceIds, note });
    }
  }
  return findings;
}

/** Conclusions are descriptive, calculated and traceable; causes are not inferred. */
export function buildFindings(snapshot: DashboardSnapshot, goals: ReportGoal[] = []): FindingsReport {
  const available = snapshot.analyses.filter((item) => item.result && sourceId(item.suggestion.spec) === snapshot.sourceId);
  const limitations = new Set<string>([
    'Results were captured from separate queries, not a single database transaction. Refresh the analyses after editing data.',
    'Inferred field meanings and source units need business review. A contribution or association does not establish a cause.',
    snapshot.origin === 'report'
      ? 'This report covers the selected table’s supported report analyses. Each finding uses its evidence query scope; dashboard controls are not automatically inherited.'
      : 'This report covers unhidden analyses available in the dashboard and Explore for the current source, filters and focus metric.',
  ]);
  const failed = snapshot.analyses.filter((item) => item.error || !item.result);
  if (failed.length) limitations.add(`${failed.length} analyses were unavailable. Their errors are shown in the evidence; findings are incomplete.`);
  if (snapshot.analyses.some((item) => item.result?.truncated)) limitations.add('Some query results are limited. Rankings refer to returned groups; incomplete groups do not receive full-dataset contribution claims.');
  for (const item of available) for (const warning of item.result!.warnings ?? []) limitations.add(`${item.suggestion.title}: ${warning}`);

  const metrics: ReportMetric[] = [];
  const aggregateSeen = new Set<string>();
  for (const analysis of available) {
    const result = analysis.result!;
    if (result.truncated || result.fields.some((field) => field.kind === 'dimension') || result.rows.length !== 1) continue;
    for (const field of result.fields.filter((entry) => entry.kind === 'measure')) {
      const value = result.rows[0][field.key];
      if (!finite(value)) continue;
      const key = `${scopeKey(analysis.suggestion.spec)}:${measureKey(field)}`;
      if (aggregateSeen.has(key)) continue;
      aggregateSeen.add(key);
      metrics.push({ id: `${analysis.suggestion.id}::${field.key}`, label: metricLabel(field), value, analysisId: analysis.suggestion.id, field });
    }
  }
  const findings: ReportFinding[] = [];
  const add = (finding: ReportFinding) => findings.push(finding);
  const byId = new Map(snapshot.analyses.map((analysis) => [analysis.suggestion.id, analysis]));
  const sameScope = (a: string, b: string) => scopeKey(byId.get(a)!.suggestion.spec) === scopeKey(byId.get(b)!.suggestion.spec);
  for (const metric of metrics.filter((entry) => entry.field.aggregation === 'sum' && profitName(entry.field) && entry.value < 0)) {
    add({ id: `total-loss:${metric.id}`, kind: 'loss', title: 'Overall recorded loss', attention: true,
      text: `${metric.label} is ${reportNumber(metric.value)} for the current selection. The recorded net result is negative.`,
      meaning: 'The recorded result is negative overall, so sales growth should be assessed alongside the profitability of the transactions producing it.', priority: 100,
      evidenceIds: [metric.analysisId], action: 'Review the largest loss-making groups and reconcile the Profit field with the accounting definition before choosing corrective actions.' });
  }
  const profit = metrics.find((entry) => profitName(entry.field) && entry.field.aggregation === 'sum');
  const sales = profit && metrics.find((entry) => salesName(entry.field) && entry.field.aggregation === 'sum' && sameScope(entry.analysisId, profit.analysisId));
  if (profit && sales && sales.value > 0) {
    add({ id: 'profit-sales-ratio', kind: 'performance', title: 'Recorded profit relative to sales', attention: profit.value < 0,
      text: `${profit.label} is ${reportNumber(profit.value)}, against ${reportNumber(sales.value)} ${sales.label}. The ratio of recorded profit to sales is ${(profit.value / sales.value * 100).toFixed(1)}%.`,
      meaning: `For every 100 units of recorded Sales, the data records ${reportNumber(Math.abs(profit.value / sales.value * 100))} units of ${profit.value < 0 ? 'loss' : 'Profit'}. This provides a baseline for comparing group-level profit conversion; a desired ratio requires a business benchmark.`, priority: 20,
      evidenceIds: [profit.analysisId, sales.analysisId], note: 'This ratio assumes the two fields use comparable units and scope. It is not an independently verified accounting margin.' });
  }

  const viewSeen = new Set<string>();
  for (const analysis of available) {
    const result = analysis.result!;
    const dimensions = result.fields.filter((field) => field.kind === 'dimension');
    if (!dimensions.length || !result.rows.length) continue;
    for (const field of result.fields.filter((entry) => entry.kind === 'measure')) {
      const signature = stable([scopeKey(analysis.suggestion.spec), dimensions.map((dimension) => [dimension.table_id, dimension.column, dimension.date_part]), measureKey(field)]);
      if (viewSeen.has(signature)) continue;
      viewSeen.add(signature);
      const numericRows = result.rows.filter((row) => finite(row[field.key]));
      if (!numericRows.length) continue;
      const ranked = [...numericRows].sort((a, b) => Number(b[field.key]) - Number(a[field.key]));
      const first = ranked[0], last = ranked[ranked.length - 1];
      const label = metricLabel(field);
      const evidenceIds = [analysis.suggestion.id];
      const period = dimensions.length === 1 && ['day', 'week', 'month', 'quarter', 'year'].includes(dimensions[0].date_part ?? '');
      const complete = !result.truncated && numericRows.length === result.rows.length;
      const negatives = ranked.filter((row) => Number(row[field.key]) < 0);
      if (!period && field.aggregation === 'sum' && profitName(field) && negatives.length) {
        const worst = negatives[negatives.length - 1];
        const loss = -negatives.reduce((total, row) => total + Number(row[field.key]), 0);
        const positive = numericRows.reduce((total, row) => total + Math.max(0, Number(row[field.key])), 0);
        const drag = positive > 0 && finite(loss / positive) ? loss / positive * 100 : null;
        add({ id: `loss:${signature}`, kind: 'loss', title: 'Loss-making groups', attention: true,
          text: `${negatives.length} of ${numericRows.length} returned groups have negative ${label}. The largest recorded loss is ${describeGroup(worst, dimensions)}, at ${reportNumber(Number(worst[field.key]))}. Combined losses among returned negative groups are ${reportNumber(negatives.reduce((total, row) => total + Number(row[field.key]), 0))}.`,
          meaning: drag !== null
            ? `Losses absorb ${drag.toFixed(1)}% of the Profit generated by profitable returned groups. ${describeGroup(worst, dimensions)} accounts for ${(Math.abs(Number(worst[field.key])) / loss * 100).toFixed(1)}% of those returned losses, making it the first loss contributor to investigate.`
            : 'No profitable group offsets these losses among the numeric groups returned by this query. Review the largest loss contributor first.', priority: 95,
          evidenceIds, note: result.truncated ? 'Additional groups may be missing because the query limit was reached.' : undefined,
          action: 'Inspect these groups for recorded costs, returns, discounts or exceptional transactions. The query does not establish which factor caused the loss.' });
      }
      if (!period) {
        const aggregate = metrics.find((metric) => measureMatches(metric.field, field) && sameScope(metric.analysisId, analysis.suggestion.id));
        const groupSum = numericRows.reduce((total, row) => total + Number(row[field.key]), 0);
        const matches = aggregate && Math.abs(groupSum - aggregate.value) <= Math.max(0.000001, Math.abs(aggregate.value) * 0.000001);
        const partition = complete && field.aggregation === 'sum' && aggregate && aggregate.value > 0 && matches;
        if (partition) {
          const share = Number(first[field.key]) / aggregate.value * 100;
          add({ id: `contribution:${signature}`, kind: 'contribution', title: 'Largest contribution', attention: false,
            text: `${describeGroup(first, dimensions)} contributes ${share.toFixed(1)}% of ${label} for the current selection (${reportNumber(Number(first[field.key]))} of ${reportNumber(aggregate.value)}).`,
            evidenceIds: [...evidenceIds, aggregate.analysisId],
            meaning: negatives.length
              ? 'Losses in other groups reduce the net total, so the largest positive contributor can exceed the entire net result. The net total hides this offset.'
              : share > 50 ? 'This one group contributes more than all remaining groups combined. Changes in its result can therefore have a large effect on the recorded total.'
                : 'The result is spread across multiple groups. The leading contribution identifies where the largest share currently comes from; its unit economics need a separate comparison.',
            priority: !negatives.length && share > 50 ? 75 : 35,
            note: negatives.length ? 'This uses the net total, including negative groups. Positive contributions may exceed 100%; this is not a non-negative pie-chart share.' : undefined,
            action: !negatives.length && share > 50 ? 'Review how dependent the result is on this group and compare its contribution across complete, comparable periods.' : undefined });
        } else {
          add({ id: `rank:${signature}`, kind: 'ranking', title: 'Leading and smallest recorded groups', attention: false,
            text: `${describeGroup(first, dimensions)} has the largest returned ${label}: ${reportNumber(Number(first[field.key]))}.${ranked.length > 1 ? ` ${describeGroup(last, dimensions)} has the smallest returned value: ${reportNumber(Number(last[field.key]))}.` : ''}`,
            evidenceIds, note: 'A smaller amount alone does not establish underperformance. Contribution percentages require complete additive groups that reconcile to a matching total.' });
        }
      } else {
        const chronological = [...numericRows].filter((row) => /^\d{4}-\d{2}-\d{2}/.test(String(row[dimensions[0].key]))).sort((a, b) => String(a[dimensions[0].key]).localeCompare(String(b[dimensions[0].key])));
        if (chronological.length >= 2) {
          const previous = chronological[chronological.length - 2], latest = chronological[chronological.length - 1];
          const before = Number(previous[field.key]), after = Number(latest[field.key]), change = after - before;
          const relative = before > 0 ? ` (${(Math.abs(change) / before * 100).toFixed(1)}% ${change >= 0 ? 'higher' : 'lower'})` : '';
          add({ id: `trend:${signature}`, kind: 'trend', title: 'Change between returned periods', attention: false,
            text: `${String(latest[dimensions[0].key])} records ${reportNumber(after)} ${label}, compared with ${reportNumber(before)} in ${String(previous[dimensions[0].key])}. The recorded change is ${reportNumber(change)}${relative}.`,
            evidenceIds, note: `These are the last two returned ${dimensions[0].date_part} groups, which may be non-consecutive or partial. Coverage and period completeness are not established; this does not prove a target miss.`,
            meaning: change < 0 && (profitName(field) || salesName(field))
              ? 'The returned period totals indicate a decrease that needs a coverage check. If both periods are complete and comparable, review which groups changed before deciding on a response.'
              : change === 0 ? 'The recorded amount is unchanged between these returned periods; comparable period coverage is needed to assess whether performance is stable.'
                : 'The returned amounts changed over time. Verify equivalent period coverage and a business benchmark before describing the change as an improvement.', priority: 45,
            action: change < 0 && (profitName(field) || salesName(field)) ? 'Check period completeness and compare equivalent date ranges before investigating the observed decrease.' : undefined });
        }
      }
    }
  }
  for (const finding of groupProfitability(available)) add(finding);
  const validGoals = goals.filter((goal) => finite(goal.target) && metrics.some((metric) => metric.id === goal.metricId));
  for (const goal of validGoals) {
    const metric = metrics.find((entry) => entry.id === goal.metricId);
    if (!metric || !finite(goal.target)) continue;
    const variance = metric.value - goal.target;
    const behind = goal.direction === 'higher' ? variance < 0 : variance > 0;
    const relative = goal.target > 0 ? ` (${(Math.abs(variance) / goal.target * 100).toFixed(1)}% of the target)` : '';
    add({ id: `target:${metric.id}`, kind: 'target', title: behind ? 'Behind the entered target' : 'Entered target met', attention: behind,
      text: `${metric.label} is ${reportNumber(metric.value)} against the entered target of ${reportNumber(goal.target)}. It is ${variance === 0 ? 'equal to the target' : `${reportNumber(Math.abs(variance))} ${variance > 0 ? 'above' : 'below'} the target${relative}`}. ${goal.direction === 'higher' ? 'Higher values are desired.' : 'Lower values are desired.'}`,
      evidenceIds: [metric.analysisId], note: 'The target was entered by the report author for this selection; it was not inferred or independently verified.',
      meaning: behind ? 'The recorded measure falls on the undesired side of the entered target. This gap establishes a review priority once the target scope is verified.'
        : 'The recorded measure meets the entered target in the desired direction. Retain that context when reviewing weaker groups.', priority: behind ? 100 : 40,
      action: behind ? 'Validate that this target covers the same source, units, period and filters, then review the groups driving the gap.' : undefined });
  }
  if (!validGoals.length) limitations.add('No performance target was supplied. Smaller groups and decreases are observations; this report cannot establish that the business is behind plan.');
  if (!findings.length) limitations.add('The returned results do not support a narrative finding. Check the evidence, filters and available field classifications.');
  const prioritized = findings.filter((finding) => finding.meaning).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const kinds = new Set<string>();
  const diverse = prioritized.filter((finding) => {
    if (kinds.has(finding.kind)) return false;
    kinds.add(finding.kind); return true;
  });
  const summary = [...diverse, ...prioritized.filter((finding) => !diverse.includes(finding))].slice(0, 6)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return { metrics, findings, summary, limitations: [...limitations] };
}

function markdownText(value: unknown) {
  return String(value ?? '').replace(/([\\`*_{}\[\]<>|])/g, '\\$1').replace(/[\r\n]+/g, ' ');
}
export function findingsMarkdown(snapshot: DashboardSnapshot, report: FindingsReport, authorNotes = '', includeEvidence = true): string {
  const lines = [`# ${markdownText(snapshot.sourceName)} — ${snapshot.origin === 'report' ? 'business' : 'dashboard'} findings`, '',
    `Captured: ${snapshot.capturedAt}`, `Query results completed: ${snapshot.resultsAt}`,
    `Source records before filters: ${snapshot.sourceRows}`, '', '## Scope', '',
    ...snapshot.selection.map((entry) => `- ${markdownText(entry)}`), '', '## Executive summary', '',
    ...report.summary.map((finding) => `- **${markdownText(finding.title)}:** ${markdownText(finding.meaning ?? finding.text)}`), '', '## Insights', ''];
  for (const finding of report.findings.filter((entry) => entry.meaning)) {
    lines.push(`### ${markdownText(finding.title)}`, '', markdownText(finding.text));
    lines.push('', `What it means: ${markdownText(finding.meaning)}`);
    if (finding.note) lines.push('', `Context: ${markdownText(finding.note)}`);
    if (finding.action) lines.push('', `Suggested follow-up: ${markdownText(finding.action)}`);
    lines.push('', `Evidence: ${finding.evidenceIds.map(markdownText).join(', ')}`, '');
  }
  if (authorNotes.trim()) lines.push('## Author notes', '', authorNotes, '');
  lines.push('## Limitations', '', ...report.limitations.map((note) => `- ${markdownText(note)}`), '');
  if (!includeEvidence) return lines.join('\n');
  lines.push('## Supporting measures', '', '| Measure | Value |', '| --- | ---: |',
    ...report.metrics.map((metric) => `| ${markdownText(metric.label)} | ${reportNumber(metric.value)} |`), '', '## Query evidence', '');
  for (const analysis of snapshot.analyses) {
    lines.push(`### ${markdownText(analysis.suggestion.title)}`, '');
    if (!analysis.result) { lines.push(`Unavailable: ${markdownText(analysis.error ?? 'No result')}`, ''); continue; }
    const result = analysis.result;
    lines.push(`Returned rows: ${result.row_count}${result.truncated ? ' (query limit reached)' : ''}`, '',
      `| ${result.fields.map((field) => markdownText(field.key)).join(' | ')} |`,
      `| ${result.fields.map(() => '---').join(' | ')} |`,
      ...result.rows.slice(0, 20).map((row) => `| ${result.fields.map((field) => markdownText(row[field.key] ?? '—')).join(' | ')} |`));
    if (result.rows.length > 20) lines.push('', `Evidence preview contains 20 of ${result.rows.length} returned rows.`);
    lines.push('');
  }
  return lines.join('\n');
}


export interface ReportPoint {
  label: string;
  x?: number;
  values: (number | null)[];
  gapBefore?: boolean;
}
export interface ReportChart {
  id: string;
  kind: 'line' | 'bar' | 'scatter' | 'indexed-line';
  title: string;
  xLabel: string;
  yLabel: string;
  series: string[];
  points: ReportPoint[];
  evidenceIds: string[];
  insights: ReportFinding[];
  notes: string[];
  score: number;
  topic: string;
  coveredViewIds?: string[];
}
export interface ReportStory {
  charts: ReportChart[];
  keyFindings: ReportFinding[];
  trendsAndAnomalies: ReportFinding[];
  recommendations: { text: string; evidenceIds: string[] }[];
  conclusion: string;
  omissions: string;
  methodology: string[];
  detailedNotes: { title: string; notes: string[] }[];
}
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function serialized(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serialized).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${serialized(entry)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function scope(analysis: ReportAnalysis) {
  return serialized([analysis.suggestion.spec.base_table_id ?? analysis.suggestion.spec.measures?.[0]?.table_id,
    [...(analysis.suggestion.spec.filters ?? [])].map(serialized).sort()]);
}
const name = (field: QueryField) => (field.column ?? 'records').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
const sales = (field: QueryField) => /\b(sales|revenue|turnover)\b/i.test(name(field)) && field.aggregation === 'sum';
const profit = (field: QueryField) => /\b(profit|earnings)\b/i.test(name(field)) && field.aggregation === 'sum';
const volume = (field: QueryField) => /\border(s)?\b/i.test(name(field)) &&
  (field.aggregation === 'count_distinct' || (field.aggregation === 'sum' && !/\bid\b/i.test(name(field))));
function label(field: QueryField) {
  const operation: Record<string, string> = { sum: 'Total', avg: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum', count: 'Count of', count_distinct: 'Distinct' };
  return `${operation[field.aggregation ?? ''] ?? ''} ${name(field)}`.trim();
}
function importance(field: QueryField) {
  return sales(field) ? 40 : profit(field) ? 38 : volume(field) ? 32 : /\b(cost|quantity|volume|count)\b/i.test(name(field)) ? 20 : 10;
}
function timeField(dimensions: QueryField[]) {
  return dimensions.length === 1 && ['day', 'week', 'month', 'quarter', 'year'].includes(dimensions[0].date_part ?? '') ? dimensions[0] : null;
}
function dateValue(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function consecutive(a: number, b: number, grain: string | null | undefined) {
  const expected = new Date(a);
  if (grain === 'day' || grain === 'week') expected.setUTCDate(expected.getUTCDate() + (grain === 'week' ? 7 : 1));
  else if (grain === 'month' || grain === 'quarter') expected.setUTCMonth(expected.getUTCMonth() + (grain === 'quarter' ? 3 : 1));
  else if (grain === 'year') expected.setUTCFullYear(expected.getUTCFullYear() + 1);
  else return false;
  return expected.getTime() === b;
}
function quantile(sorted: number[], probability: number) {
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index), high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
function resultNotes(result: QueryResult) {
  return [...(result.truncated ? ['The query limit was reached. This visual covers returned groups only.'] : []), ...(result.warnings ?? [])];
}

function chartPatterns(analysis: ReportAnalysis, field: QueryField, allPoints: ReportPoint[], temporal: QueryField | null): ReportFinding[] {
  const valid = allPoints.filter((point) => number(point.values[0]));
  if (valid.length < 2) return [];
  const evidenceIds = [analysis.suggestion.id];
  const facts: ReportFinding[] = [];
  const values = valid.map((point) => point.values[0] as number);
  const metric = label(field);
  if (temporal) {
    const previous = valid[valid.length - 2], latest = valid[valid.length - 1];
    const before = previous.values[0]!, after = latest.values[0]!, change = after - before;
    let increases = 0;
    for (let i = valid.length - 2; i > 0 && valid[i].values[0]! > valid[i - 1].values[0]!; i--) increases++;
    const changeText = change === 0 ? 'is unchanged' : `${change > 0 ? 'increases' : 'decreases'} by ${reportNumber(Math.abs(change))}${before > 0 ? ` (${(Math.abs(change) / before * 100).toFixed(1)}%)` : ''}`;
    facts.push({ id: `chart-trend:${analysis.suggestion.id}:${field.key}`, kind: 'trend', title: change < 0 && increases > 0 ? 'An increasing sequence ends with a decline' : 'Pattern across returned periods',
      text: `${change < 0 && increases > 0 ? `After ${increases} successive increases among chronological returned groups, ` : ''}${metric} ${changeText} between ${previous.label} (${reportNumber(before)}) and ${latest.label} (${reportNumber(after)}).`,
      meaning: 'This describes the returned period totals. Complete, equivalent periods are needed before treating the pattern as a change in business performance.',
      attention: change < 0 && (sales(field) || profit(field)), priority: change < 0 ? 55 : 30,
      action: change !== 0 ? 'Verify coverage for these periods, then break down the change by available product, category or location fields.' : undefined,
      evidenceIds, note: 'Period gaps are left unconnected in the graph. Missing numeric values are not filled with zero; partial periods and missing source records cannot be ruled out.' });
  } else {
    const sorted = [...valid].sort((a, b) => b.values[0]! - a.values[0]!);
    const high = sorted[0], low = sorted[sorted.length - 1];
    facts.push({ id: `chart-comparison:${analysis.suggestion.id}:${field.key}`, kind: 'ranking', title: 'Variation between returned groups',
      text: `${high.label} records ${reportNumber(high.values[0]!)} ${metric}, compared with ${reportNumber(low.values[0]!)} in ${low.label}: a difference of ${reportNumber(high.values[0]! - low.values[0]!)}.`,
      meaning: 'The comparison identifies where the recorded amount is concentrated or differs across groups. Group size and a valid benchmark are needed before labelling the difference as underperformance.',
      attention: false, priority: 15, evidenceIds });
  }
  if (values.length >= 8) {
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
    if (number(iqr) && iqr >= 0) {
      const lower = q1 - 1.5 * iqr, upper = q3 + 1.5 * iqr;
      const outliers = valid.filter((point) => point.values[0]! < lower || point.values[0]! > upper);
      if (outliers.length) {
        const extreme = [...outliers].sort((a, b) => Math.abs(b.values[0]! - quantile(sorted, 0.5)) - Math.abs(a.values[0]! - quantile(sorted, 0.5)))[0];
        facts.push({ id: `chart-outlier:${analysis.suggestion.id}:${field.key}`, kind: 'anomaly', title: 'Potential unusual values', priority: 70, attention: true,
          text: `${extreme.label} records ${reportNumber(extreme.values[0]!)} ${metric}. ${outliers.length} of ${valid.length} numeric returned ${temporal ? 'periods' : 'groups'} are review candidates, differing from the middle of this distribution.`,
          meaning: 'These values differ substantially from the middle of this returned distribution. They are review candidates; different group sizes, seasonality or a genuine trend could also explain them.',
          action: 'Inspect the flagged source transactions and compare group size or period coverage before treating the unusual value as an error or business event.', evidenceIds,
          note: `Screening range: ${reportNumber(lower)} to ${reportNumber(upper)}. This is a descriptive 1.5 × interquartile-range screen using at least eight numeric groups. It is not a significance test or proof of an anomaly in the full dataset.${iqr === 0 ? ' The middle half has zero spread, so this screen only identifies values differing from that common level; review them in context.' : ''}` });
      }
    }
  }
  return facts;
}

/** Consolidate alternate descriptions of the same profitability comparison, retaining its scope. */
function consolidatedFindings(findings: ReportFinding[]): ReportFinding[] {
  const groups = new Map<string, ReportFinding[]>();
  for (const finding of findings) {
    const paired = /^(volume-profit|conversion-gap|conversion-benchmark):/.test(finding.id);
    const key = paired ? `profitability:${finding.id.slice(finding.id.indexOf(':') + 1)}` : finding.id;
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return [...groups.values()].map((group) => {
    const preferred = group.find((finding) => finding.id.startsWith('volume-profit:')) ?? group[0];
    return { ...preferred, priority: Math.max(...group.map((finding) => finding.priority ?? 0)),
      evidenceIds: [...new Set(group.flatMap((finding) => finding.evidenceIds))] };
  });
}
function forMeasure(finding: ReportFinding, field: QueryField) {
  if (!/^(loss|contribution):/.test(finding.id)) return false;
  try {
    const signature = JSON.parse(finding.id.slice(finding.id.indexOf(':') + 1));
    return signature[2] === serialized([field.table_id, field.column, field.aggregation]);
  } catch { return false; }
}
export function reportFindingSummary(finding: ReportFinding): string {
  // Sentence boundaries include a space, so a decimal such as 10.3% stays intact.
  if (finding.kind === 'target') return finding.text;
  const end = finding.text.indexOf('. ');
  return end < 0 ? finding.text : finding.text.slice(0, end + 1);
}
export function reportFindingFigure(story: ReportStory, finding: ReportFinding): number | null {
  const index = story.charts.findIndex((chart) => chart.insights.some((entry) => entry.id === finding.id));
  return index < 0 ? null : index + 1;
}
export function reportChartNote(chart: ReportChart): string {
  const coverage = chart.notes.filter((note) => /query limit|Displays the|rows with missing/i.test(note));
  return [...coverage, 'These findings describe the supplied report data; they do not establish why the differences exist.'].join(' ');
}

/** A bounded, diverse set of visuals chosen from actual results, independently of dashboard placement. */
export function buildReportStory(snapshot: DashboardSnapshot, report: FindingsReport, maxCharts = 6): ReportStory {
  const available = snapshot.analyses.filter((analysis) => analysis.result &&
    (analysis.suggestion.spec.base_table_id ?? analysis.suggestion.spec.measures?.[0]?.table_id) === snapshot.sourceId);
  const candidates: ReportChart[] = [];
  const consolidated = consolidatedFindings(report.findings);
  const seen = new Set<string>();
  for (const analysis of [...available].sort((a, b) => Number(a.result!.truncated) - Number(b.result!.truncated))) {
    const result = analysis.result!;
    const dimensions = result.fields.filter((field) => field.kind === 'dimension');
    if (!dimensions.length || dimensions.length > 2 || result.rows.length < 2) continue;
    const temporal = timeField(dimensions);
    const measures = result.fields.filter((field) => field.kind === 'measure');
    for (const measure of measures) {
      const signature = serialized([scope(analysis), dimensions.map((field) => [field.table_id, field.column, field.date_part]), [measure.table_id, measure.column, measure.aggregation]]);
      if (seen.has(signature)) continue;
      const points: ReportPoint[] = result.rows.flatMap((row) => {
        const value = row[measure.key];
        if (!number(value)) return [];
        if (temporal) {
          const x = dateValue(row[temporal.key]);
          return x === null ? [] : [{ label: String(row[temporal.key]).slice(0, 10), x, values: [value] }];
        }
        return [{ label: dimensions.map((field) => `${field.column ?? field.key}: ${String(row[field.key] ?? '(Missing or unmatched)')}`).join(' · '), values: [value] }];
      });
      if (points.length < 2 || new Set(points.map((point) => point.label)).size !== points.length) continue;
      seen.add(signature);
      const notes = resultNotes(result);
      if (points.length !== result.rows.length) notes.push(`${result.rows.length - points.length} rows with missing, invalid-date or non-finite chart values were omitted; they were not treated as zero.`);
      let displayed: ReportPoint[];
      if (temporal) {
        displayed = [...points].sort((a, b) => a.x! - b.x!);
        displayed = displayed.map((point, index) => ({ ...point, gapBefore: index > 0 && !consecutive(displayed[index - 1].x!, point.x!, temporal.date_part) }));
        notes.push(`Source grain: ${temporal.date_part}. Returned periods may be partial; gaps are not filled or connected.`);
      } else {
        const sorted = [...points].sort((a, b) => b.values[0]! - a.values[0]!);
        const selected = new Set([...sorted.slice(0, 8), ...sorted.slice(-2)]);
        displayed = sorted.filter((point) => selected.has(point));
        if (displayed.length < points.length) notes.push(`Displays the eight highest and two lowest values (${displayed.length} of ${points.length} returned groups); no 'Other' total is invented.`);
      }
      const own = chartPatterns(analysis, measure, temporal ? displayed : points, temporal);
      const linked = temporal ? [] : consolidated.filter((finding) => finding.evidenceIds.includes(analysis.suggestion.id) && forMeasure(finding, measure));
      const insights = [...linked.map((finding) => finding.kind === 'loss' ? { ...finding, text: `${finding.text} ${finding.meaning ?? ''}` } : finding), ...own].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)).slice(0, 2);
      const type = temporal ? 'time' : profit(measure) ? 'profit-groups' : sales(measure) ? 'sales-groups' : 'other-groups';
      candidates.push({ id: `visual:${analysis.suggestion.id}:${measure.key}`, kind: temporal ? 'line' : 'bar',
        title: `${label(measure)} ${temporal ? 'over' : 'by'} ${dimensions.map((field) => field.column ?? field.key).join(' / ')}`,
        xLabel: temporal ? `${temporal.column} (${temporal.date_part})` : label(measure),
        yLabel: temporal ? label(measure) : dimensions.map((field) => field.column).join(' / '),
        series: [label(measure)], points: displayed, evidenceIds: [analysis.suggestion.id], insights, notes,
        score: importance(measure) + (temporal ? 20 : 0) + Math.min(20, Math.max(0, ...insights.map((finding) => (finding.priority ?? 0) / 5))),
        topic: type });
    }
    if (!temporal) {
      const p = measures.find(profit), s = measures.find(sales);
      if (p && s) {
        const points = result.rows.flatMap((row) => number(row[p.key]) && number(row[s.key]) ? [{
          label: dimensions.map((field) => `${field.column}: ${String(row[field.key] ?? '(Missing or unmatched)')}`).join(' · '),
          x: Number(row[s.key]), values: [Number(row[p.key])],
        }] : []);
        const signature = serialized(['scatter', scope(analysis), dimensions.map((field) => [field.table_id, field.column]), [p.table_id, p.column], [s.table_id, s.column]]);
        if (points.length >= 3 && !seen.has(signature)) {
          seen.add(signature);
          candidates.push({ id: `visual:${analysis.suggestion.id}:sales-profit`, kind: 'scatter', title: `Sales vs Profit by ${dimensions.map((field) => field.column ?? field.key).join(' and ')}`,
            xLabel: label(s), yLabel: label(p), series: [label(p)], points, evidenceIds: [analysis.suggestion.id],
            insights: consolidated.filter((finding) => /^(volume-profit|conversion-gap|conversion-benchmark):/.test(finding.id) && finding.evidenceIds.includes(analysis.suggestion.id)).slice(0, 1),
            notes: [...resultNotes(result), 'Each point is a returned group. A relationship between Sales and Profit does not establish a cause.'], score: 70, topic: 'sales-profit' });
        }
      }
    }
  }

  // Pair separately calculated Sales and order-volume series only at identical periods and scopes.
  const timeAnalyses = available.filter((analysis) => timeField(analysis.result!.fields.filter((field) => field.kind === 'dimension')));
  for (const revenue of timeAnalyses) {
    const s = revenue.result!.fields.find((field) => field.kind === 'measure' && sales(field));
    if (!s) continue;
    const date = timeField(revenue.result!.fields.filter((field) => field.kind === 'dimension'))!;
    const volumeAnalysis = timeAnalyses.find((analysis) => scope(analysis) === scope(revenue) &&
      analysis.result!.fields.some((field) => field.kind === 'measure' && volume(field)) &&
      (() => {
        const other = timeField(analysis.result!.fields.filter((field) => field.kind === 'dimension'))!;
        return other.table_id === date.table_id && other.column === date.column && other.date_part === date.date_part;
      })());
    if (!volumeAnalysis) continue;
    const v = volumeAnalysis.result!.fields.find((field) => field.kind === 'measure' && volume(field))!;
    const signature = serialized(['sales-volume', scope(revenue), date.table_id, date.column, date.date_part, v.column]);
    if (seen.has(signature)) continue;
    const volumeDate = timeField(volumeAnalysis.result!.fields.filter((field) => field.kind === 'dimension'))!;
    const rows = volumeAnalysis.result!.rows;
    const lookup = new Map(rows.map((row) => [dateValue(row[volumeDate.key]), row[v.key]]));
    if (lookup.size !== rows.length) continue;
    const matched = revenue.result!.rows.flatMap((row) => {
      const x = dateValue(row[date.key]), first = row[s.key], second = lookup.get(x);
      return x !== null && number(first) && number(second) ? [{ label: String(row[date.key]).slice(0, 10), x, values: [first, second] }] : [];
    }).sort((a, b) => a.x - b.x);
    if (matched.length < 3 || new Set(matched.map((point) => point.x)).size !== matched.length || matched[0].values.some((value) => value <= 0)) continue;
    const indexed = matched.map((point, index) => ({ ...point,
      values: point.values.map((value, series) => value / matched[0].values[series] * 100),
      gapBefore: index > 0 && !consecutive(matched[index - 1].x, point.x, date.date_part) }));
    if (indexed.some((point) => point.values.some((value) => !number(value)))) continue;
    seen.add(signature);
    const previous = matched[matched.length - 2], latest = matched[matched.length - 1];
    const dSales = latest.values[0] - previous.values[0], dVolume = latest.values[1] - previous.values[1];
    const bothDown = dSales < 0 && dVolume < 0;
    const finding: ReportFinding = { id: `sales-volume:${signature}`, kind: 'trend', title: bothDown ? 'A sales decline coincides with lower order volume' : 'Sales and order-volume changes compared',
      text: `${label(s)} changes from ${reportNumber(previous.values[0])} to ${reportNumber(latest.values[0])}, while ${label(v)} changes from ${reportNumber(previous.values[1])} to ${reportNumber(latest.values[1])}, between ${previous.label} and ${latest.label}.`,
      meaning: bothDown ? 'Both recorded measures decline in the same matched returned period. This identifies a simultaneous volume change; it does not show that fewer orders caused the sales decline.'
        : 'The matched series show how recorded Sales and the order-volume measure move over the same returned periods. Different trajectories can guide a review of volume and transaction values.',
      action: 'Verify complete, equivalent periods and the meaning of the order-volume field, then compare changes by available product categories or locations.',
      priority: bothDown ? 85 : 50, attention: bothDown, evidenceIds: [...new Set([revenue.suggestion.id, volumeAnalysis.suggestion.id])],
      note: 'The chart indexes each series to 100 at the first matched returned period. Raw amounts remain in the insight. Only matched periods are shown; this association does not establish causation.' };
    candidates.push({ id: `visual:${revenue.suggestion.id}:sales-volume`, kind: 'indexed-line', title: 'Sales and order volume over matched periods',
      xLabel: `${date.column} (${date.date_part})`, yLabel: 'Index: first matched period = 100', series: [label(s), label(v)], points: indexed,
      evidenceIds: finding.evidenceIds, insights: [finding], score: bothDown ? 110 : 85, topic: 'sales-volume',
      coveredViewIds: [`visual:${volumeAnalysis.suggestion.id}:${v.key}`],
      notes: [...new Set([...resultNotes(revenue.result!), ...resultNotes(volumeAnalysis.result!)]), finding.note!, 'Coverage and period completeness are not established.'] });
  }

  const covered = new Set(candidates.filter((chart) => chart.kind === 'indexed-line').flatMap((chart) => chart.coveredViewIds ?? []));
  const ordered = candidates.filter((chart) => chart.insights.length && !covered.has(chart.id)).sort((a, b) => b.score - a.score);
  const topics = new Set<string>();
  const diverse = ordered.filter((chart) => { if (topics.has(chart.topic)) return false; topics.add(chart.topic); return true; });
  const charts = [...diverse, ...ordered.filter((chart) => !diverse.includes(chart))].slice(0, Math.max(0, Math.min(10, maxCharts)));
  const extra = charts.flatMap((chart) => chart.insights).filter((finding) => finding.kind === 'anomaly' || finding.id.startsWith('sales-volume:') || finding.id.startsWith('chart-trend:'));
  const pairedPeriods = new Set(extra.filter((finding) => finding.id.startsWith('sales-volume:')).flatMap((finding) => finding.evidenceIds));
  const ownPeriods = new Set(extra.filter((finding) => finding.id.startsWith('chart-trend:')).flatMap((finding) => finding.evidenceIds));
  const findings = consolidatedFindings([...consolidated.filter((finding) => finding.meaning), ...extra])
    .filter((finding) => !(finding.id.startsWith('trend:') && finding.evidenceIds.some((id) => ownPeriods.has(id) || pairedPeriods.has(id))))
    .filter((finding) => !(finding.id.startsWith('chart-trend:') && finding.evidenceIds.some((id) => pairedPeriods.has(id))))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const kinds = new Set<string>();
  const unique = findings.filter((finding) => { if (kinds.has(finding.kind)) return false; kinds.add(finding.kind); return true; });
  const keyFindings = [...unique, ...findings.filter((finding) => !unique.includes(finding))].slice(0, 5).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const trendsAndAnomalies = findings.filter((finding) => finding.kind === 'trend' || finding.kind === 'anomaly').slice(0, 5);
  const actions = new Map<string, { text: string; evidenceIds: string[] }>();
  for (const finding of findings) {
    if (!finding.action) continue;
    const previous = actions.get(finding.action);
    actions.set(finding.action, { text: finding.action,
      evidenceIds: [...new Set([...(previous?.evidenceIds ?? []), ...finding.evidenceIds])] });
  }
  const recommendations = [...actions.values()].slice(0, 4);
  const conclusion = keyFindings.length
    ? `${snapshot.sourceName}: ${keyFindings.slice(0, 2).map((finding) => finding.title.toLowerCase()).join(' and ')} are the main priorities for review. The supplied results do not establish causes; validate the relevant transactions and comparable periods before choosing an intervention.`
    : 'The available query results do not support a combined finding. Review the field definitions and obtain comparable period or group analyses before drawing a business conclusion.';
  const failures = snapshot.analyses.filter((analysis) => !analysis.result).length;
  const warnings = [...new Set(available.flatMap((analysis) => (analysis.result!.warnings ?? []).map((warning) => `${analysis.suggestion.title}: ${warning}`)))];
  const methodology = [
    ...(failures ? [`${failures} analyses were unavailable; findings are incomplete.`] : []),
    `Scope: ${snapshot.sourceName}, using each analysis’s query filters. Dashboard filters and hidden-chart settings are not automatically inherited.`,
    'Ratios assume comparable Sales and Profit units and definitions. They are descriptive comparisons, not verified accounting margins or explanations of cause.',
    'Rankings cover returned groups; time comparisons require complete, equivalent periods. Missing values stay missing. Unusual-value flags are review prompts, not proven business events.',
    ...(snapshot.analyses.some((analysis) => analysis.result?.truncated) ? ['Some queries reached their limits; returned groups may not represent the full dataset.'] : []),
    ...(!report.findings.some((finding) => finding.kind === 'target') ? ['No performance target was supplied; a smaller amount or a decline alone does not establish that the business is behind plan.'] : []),
    ...[...new Set(report.findings.filter((finding) => finding.kind === 'contribution' && finding.note).map((finding) => finding.note!))],
    ...warnings,
  ];
  const detailedNotes = [
    { title: 'Calculation and interpretation notes', notes: [...new Set([...report.limitations, ...report.findings.flatMap((finding) => finding.note ? [finding.note] : [])])] },
    ...charts.map((chart) => ({ title: chart.title, notes: [...new Set([...chart.notes, ...chart.insights.flatMap((finding) => finding.note ? [finding.note] : [])])] })),
  ];
  return { charts, keyFindings, trendsAndAnomalies, recommendations, conclusion, methodology, detailedNotes,
    omissions: `${charts.length} relevant visuals selected from ${candidates.length} supported candidates. Duplicate views and unsupported chart shapes are excluded.` };
}

/** Standalone SVG renderings accompany the narrative in the Markdown export. */
export function reportStoryMarkdown(story: ReportStory, chartImages: Record<string, string> = {}, includeDetails = false): string {
  const clean = (value: string) => value.replace(/([\\`*_{}\[\]<>|])/g, '\\$1').replace(/[\r\n]+/g, ' ');
  const lines = ['## Key findings across analyses', '', ...story.keyFindings.map((finding) => `- **${clean(finding.title)}:** ${clean(reportFindingSummary(finding))}`), '', '## Selected graphs and insights', ''];
  for (const [index, chart] of story.charts.entries()) {
    lines.push(`### Figure ${index + 1}. ${clean(chart.title)}`, '');
    if (chartImages[chart.id]) lines.push(`![${clean(chart.title)}](${chartImages[chart.id]})`, '');
    lines.push(`Axes: ${clean(chart.xLabel)} / ${clean(chart.yLabel)}`, '');
    for (const finding of chart.insights) {
      lines.push(`Key insight: ${clean(finding.text)}`, '');
      if (finding.action) lines.push(`What to investigate: ${clean(finding.action)}`, '');
    }
    lines.push(`Note: ${clean(reportChartNote(chart))}`, '', `Evidence: ${chart.evidenceIds.map(clean).join(', ')}`, '');
  }
  lines.push('## Trends and potential anomalies', '');
  for (const finding of story.trendsAndAnomalies) {
    const figure = reportFindingFigure(story, finding);
    lines.push(figure ? `- ${clean(finding.title)} — see Figure ${figure}.` : `- ${clean(reportFindingSummary(finding))}`);
  }
  if (!story.trendsAndAnomalies.length) lines.push('No additional unusual pattern was identified in the available evidence; this does not establish that the dataset is anomaly-free.');
  lines.push('', '## Recommendations', '', ...story.recommendations.map((recommendation) => `- ${clean(recommendation.text)} Evidence: ${recommendation.evidenceIds.map(clean).join(', ')}`), '',
    '## Conclusion', '', clean(story.conclusion), '', '## Methodology and notes', '', ...story.methodology.map((note) => `- ${clean(note)}`), '');
  if (includeDetails) {
    lines.push('### Detailed methodology', '', clean(story.omissions), '');
    for (const group of story.detailedNotes) lines.push(`#### ${clean(group.title)}`, '', ...group.notes.map((note) => `- ${clean(note)}`), '');
  }
  return lines.join('\n');
}


const CHART_COLORS = ['#047857', '#2563eb', '#7c3aed'];
const chartNumber = (value: number) => new Intl.NumberFormat('en-IN', { notation: Math.abs(value) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
function domain(values: number[], includeZero = true) {
  const scale = Math.max(1, ...values.map(Math.abs));
  const normalized = values.map((value) => value / scale);
  let min = Math.min(...normalized, ...(includeZero ? [0] : [])), max = Math.max(...normalized, ...(includeZero ? [0] : []));
  if (min === max) { min -= 0.5; max += 0.5; }
  return { min, max, scale, position: (value: number) => (value / scale - min) / (max - min),
    ticks: Array.from({ length: 5 }, (_, index) => (min + (max - min) * index / 4) * scale).filter(Number.isFinite) };
}
const shorten = (value: string, length: number) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

/** Native scalable SVG stays visible in an isolated PDF/HTML print document. */
function ReportChartVisual({ chart }: { chart: ReportChart }) {
  const width = 900;
  const height = chart.kind === 'bar' ? Math.max(320, 100 + chart.points.length * 38) : 350;
  const left = chart.kind === 'bar' ? 280 : 92, right = 60, top = 35, bottom = 78;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const yValues = chart.points.flatMap((point) => point.values.filter((value): value is number => value !== null));
  if (!yValues.length) return null;
  const y = domain(yValues);
  const xs = chart.points.map((point, index) => point.x ?? index);
  const x = domain(xs, chart.kind === 'scatter');
  const plotX = (value: number) => left + x.position(value) * plotWidth;
  const plotY = (value: number) => top + (1 - y.position(value)) * plotHeight;
  const zeroY = plotY(0);
  const tickIndexes = [...new Set(Array.from({ length: Math.min(5, chart.points.length) }, (_, index) => Math.round(index * (chart.points.length - 1) / Math.max(1, Math.min(5, chart.points.length) - 1))))];
  const title = `${chart.title}. ${chart.xLabel} versus ${chart.yLabel}.`;
  const textStyle = { fontFamily: 'Arial, sans-serif', fill: '#334155', fontSize: 12 };

  return <svg xmlns="http://www.w3.org/2000/svg" data-report-chart={chart.id} role="img" aria-label={title}
    viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block', background: '#fff' }}>
    <title>{title}</title>
    <desc>{chart.insights[0]?.text ?? 'Numeric values from the evidence queries.'}</desc>
    <rect width={width} height={height} fill="#ffffff" />
    {chart.kind === 'bar' ? (() => {
      const values = chart.points.map((point) => point.values[0]!);
      const horizontal = domain(values);
      const pos = (value: number) => left + horizontal.position(value) * plotWidth;
      const zero = pos(0);
      const rowHeight = plotHeight / chart.points.length;
      return <>
        {horizontal.ticks.map((tick, index) => <g key={index}>
          <line x1={pos(tick)} x2={pos(tick)} y1={top} y2={height - bottom} stroke="#e2e8f0" />
          <text x={pos(tick)} y={height - bottom + 22} textAnchor="middle" style={textStyle}>{chartNumber(tick)}</text>
        </g>)}
        <line x1={zero} x2={zero} y1={top} y2={height - bottom} stroke="#64748b" />
        {chart.points.map((point, index) => {
          const value = point.values[0]!, end = pos(value), center = top + rowHeight * (index + 0.5);
          return <g key={index}><title>{`${point.label}: ${reportNumber(value)} ${chart.series[0]}`}</title>
            <text x={left - 12} y={center + 4} textAnchor="end" style={textStyle}>{shorten(point.label, 36)}</text>
            <rect x={Math.min(zero, end)} y={center - 10} width={Math.abs(end - zero)} height={20} rx={2} fill={value < 0 ? '#b91c1c' : CHART_COLORS[0]} />
            <text x={value < 0 && Math.abs(end - zero) < 65 ? zero + 6 : end + 6} y={center + 4} textAnchor="start"
              style={{ ...textStyle, fontSize: 11, fill: value < 0 && Math.abs(end - zero) >= 65 ? '#ffffff' : '#334155' }}>{chartNumber(value)}</text>
          </g>;
        })}
        <text x={left + plotWidth / 2} y={height - 18} textAnchor="middle" style={{ ...textStyle, fontWeight: 600 }}>{chart.xLabel}</text>
        <text x={12} y={20} style={{ ...textStyle, fontWeight: 600 }}>{chart.yLabel}</text>
      </>;
    })() : <>
      {y.ticks.map((tick, index) => <g key={index}>
        <line x1={left} x2={width - right} y1={plotY(tick)} y2={plotY(tick)} stroke="#e2e8f0" />
        <text x={left - 10} y={plotY(tick) + 4} textAnchor="end" style={textStyle}>{chartNumber(tick)}</text>
      </g>)}
      <line x1={left} x2={width - right} y1={zeroY} y2={zeroY} stroke="#94a3b8" />
      <line x1={left} x2={left} y1={top} y2={height - bottom} stroke="#64748b" />
      {chart.kind === 'scatter' ? <>
        {x.ticks.map((tick, index) => <text key={index} x={plotX(tick)} y={height - bottom + 24} textAnchor="middle" style={textStyle}>{chartNumber(tick)}</text>)}
        {chart.points.map((point, index) => <circle key={index} cx={plotX(point.x!)} cy={plotY(point.values[0]!)} r={5}
          fill={point.values[0]! < 0 ? '#b91c1c' : CHART_COLORS[0]} fillOpacity={0.8}>
          <title>{`${point.label}: ${chart.xLabel} ${reportNumber(point.x!)}; ${chart.yLabel} ${reportNumber(point.values[0]!)}`}</title>
        </circle>)}
        {[...new Set([
          chart.points.indexOf([...chart.points].sort((a, b) => b.values[0]! - a.values[0]!)[0]),
          chart.points.indexOf([...chart.points].sort((a, b) => a.values[0]! - b.values[0]!)[0]),
          chart.points.indexOf([...chart.points].sort((a, b) => b.x! - a.x!)[0]),
        ])].sort((a, b) => plotY(chart.points[a].values[0]!) - plotY(chart.points[b].values[0]!))
          .reduce<{ index: number; y: number }[]>((labels, index) => {
            const desired = Math.max(top + 12, plotY(chart.points[index].values[0]!) - 8);
            labels.push({ index, y: Math.max(desired, (labels[labels.length - 1]?.y ?? top - 10) + 18) });
            return labels;
          }, []).map(({ index, y: labelY }) => <text key={index} x={Math.min(width - right - 190, Math.max(left + 5, plotX(chart.points[index].x!) + 8))}
            y={labelY} style={{ ...textStyle, fontSize: 11 }}>{shorten(chart.points[index].label, 30)}</text>)}
      </> : <>
        {tickIndexes.map((index) => <text key={index} x={plotX(xs[index])} y={height - bottom + 24} textAnchor="middle" style={textStyle}>{chart.points[index].label}</text>)}
        {chart.series.map((series, seriesIndex) => {
          let active = false;
          const commands = chart.points.flatMap((point, index) => {
            const value = point.values[seriesIndex];
            if (value === null || value === undefined) { active = false; return []; }
            const move = !active || point.gapBefore;
            active = true; return [`${move ? 'M' : 'L'}${plotX(xs[index])},${plotY(value)}`];
          });
          return <g key={seriesIndex}><path d={commands.join(' ')} stroke={CHART_COLORS[seriesIndex % CHART_COLORS.length]} strokeWidth={2.5}
            strokeDasharray={seriesIndex > 0 ? '6 4' : undefined} fill="none" />
            {chart.points.map((point, index) => point.values[seriesIndex] == null ? null : <circle key={index}
              cx={plotX(xs[index])} cy={plotY(point.values[seriesIndex]!)} r={seriesIndex > 0 ? 2 : 3.5} fill={CHART_COLORS[seriesIndex % CHART_COLORS.length]}>
              <title>{`${point.label}: ${series} ${reportNumber(point.values[seriesIndex]!)}`}</title>
            </circle>)}
            <rect x={left + seriesIndex * 330} y={height - 12} width={15} height={4} fill={CHART_COLORS[seriesIndex % CHART_COLORS.length]} />
            <text x={left + 22 + seriesIndex * 330} y={height - 6} style={{ ...textStyle, fontSize: 11 }}>{shorten(series, 42)}</text>
          </g>;
        })}
      </>}
      <text x={left + plotWidth / 2} y={height - 38} textAnchor="middle" style={{ ...textStyle, fontWeight: 600 }}>{chart.xLabel}</text>
      <text x={12} y={18} style={{ ...textStyle, fontWeight: 600 }}>{chart.yLabel}</text>
    </>}
  </svg>;
}
