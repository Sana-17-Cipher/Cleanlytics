'use client';

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, Database, FileSpreadsheet, Grid, Layers, LayoutDashboard,
  Loader2, Plus, ShieldCheck, Sigma, Table2, Trash2,
} from 'lucide-react';

import AutoDashboard from '../components/AutoDashboard';
import CleanModule from '../components/CleanModule';
import DashboardBuilder from '../components/DashboardBuilder';
import DataGrid from '../components/DataGrid';
import Dialog, { type DialogRequest } from '../components/Dialog';
import OverviewModule from '../components/OverviewModule';
import ReportGenerator from '../components/ReportGenerator';
import SemanticModelModule from '../components/SemanticModelModule';
import TransformModule from '../components/TransformModule';
import UploadModule from '../components/UploadModule';
import { ApiError, api } from '../lib/api';
import { count } from '../lib/format';
import type {
  HealthInfo, HistoryEntry, ProjectDetail, ProjectSummary, SemanticModel, TableDetail, UploadResult,
} from '../lib/types';

type Screen = 'sources' | 'overview' | 'data' | 'clean' | 'transform' | 'model' | 'dashboard' | 'report';

const SCREENS: Screen[] = ['sources', 'overview', 'data', 'clean', 'transform', 'model', 'dashboard', 'report'];

/**
 * The open screen lives in the URL fragment, so reloading keeps you where you
 * were instead of dropping you back on the file list.
 */
function screenFromHash(): Screen | null {
  if (typeof window === 'undefined') return null;
  const candidate = window.location.hash.replace('#', '') as Screen;
  return SCREENS.includes(candidate) ? candidate : null;
}

const NAV: { id: Screen; label: string; icon: typeof Database; needsTable: boolean }[] = [
  { id: 'sources', label: 'Data sources', icon: Database, needsTable: false },
  { id: 'overview', label: 'Analysis', icon: LayoutDashboard, needsTable: true },
  { id: 'data', label: 'Rows', icon: Table2, needsTable: true },
  { id: 'clean', label: 'Quality', icon: ShieldCheck, needsTable: true },
  { id: 'transform', label: 'Reshape', icon: Sigma, needsTable: true },
  { id: 'model', label: 'Model', icon: Layers, needsTable: false },
  { id: 'dashboard', label: 'Dashboard', icon: Grid, needsTable: false },
  { id: 'report', label: 'Report', icon: FileSpreadsheet, needsTable: true },
];

export default function Home() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [model, setModel] = useState<SemanticModel | null>(null);
  const [table, setTable] = useState<TableDetail | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Lazy initialiser rather than an effect, so the first paint is already on
  // the right screen and no cascading render is triggered.
  const [screen, setScreenState] = useState<Screen>(() => screenFromHash() ?? 'sources');
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Naming and confirmation both go through an in-app dialog: native
  // `window.prompt`/`confirm` are missing in embedded browsers.
  const [dialog, setDialog] = useState<DialogRequest | null>(null);

  const setScreen = useCallback((next: Screen) => {
    setScreenState(next);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${next}`);
    }
  }, []);

  /* ── Loading ─────────────────────────────────────────────────────────── */

  const loadProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    return list;
  }, []);

  const loadModel = useCallback(async (projectId: number) => {
    try {
      setModel(await api.getModel(projectId));
    } catch {
      setModel(null);
    }
  }, []);

  const loadHistory = useCallback(async (projectId: number, tableId: number) => {
    try {
      setHistory(await api.history(projectId, tableId));
    } catch {
      setHistory([]);
    }
  }, []);

  const openTable = useCallback(
    async (projectId: number, tableId: number) => {
      const detail = await api.getTable(projectId, tableId);
      setTable(detail);
      void loadHistory(projectId, tableId);
    },
    [loadHistory],
  );

  const openProject = useCallback(
    async (projectId: number, preferredTableId?: number) => {
      setError(null);
      const detail = await api.getProject(projectId);
      setProject(detail);
      void loadModel(projectId);

      const target = detail.tables.find((t) => t.id === preferredTableId) ?? detail.tables[0];
      if (target) {
        await openTable(projectId, target.id);
        setScreenState((current) => (current === 'sources' ? 'overview' : current));
      } else {
        setTable(null);
        setHistory([]);
        setScreen('sources');
      }
    },
    [loadModel, openTable],
  );

  // Initial load: pick up the most recent project so a reload lands where the
  // user left off, rather than on an empty screen with their work apparently gone.
  useEffect(() => {
    (async () => {
      try {
        setHealth(await api.health());
        const list = await loadProjects();
        if (list.length > 0) await openProject(list[0].id);
      } catch (cause) {
        setError(
          cause instanceof ApiError
            ? cause.message
            : 'Could not reach the analysis service.',
        );
      } finally {
        setBooting(false);
      }
    })();
  }, [loadProjects, openProject]);

  /* ── Actions ─────────────────────────────────────────────────────────── */

  const createProject = () => {
    setDialog({
      title: 'Name this project',
      defaultValue: `Analysis ${projects.length + 1}`,
      confirmLabel: 'Create',
      onConfirm: async (name) => {
        try {
          const created = await api.createProject(name);
          await loadProjects();
          setTable(null);
          setModel(null);
          await openProject(created.id);
          setScreen('sources');
        } catch (cause) {
          setError(cause instanceof ApiError ? cause.message : 'Could not create the project.');
        }
      },
    });
  };

  const handleUploaded = async (result: UploadResult) => {
    if (!project) return;
    await openProject(project.id, result.tables[0]?.id);
    await loadProjects();
    if (result.tables.length > 0) setScreen('overview');
  };

  const handleDeleteTable = (tableId: number) => {
    if (!project) return;
    setDialog({
      title: 'Remove this table?',
      body: 'The table and everything derived from it will be deleted.',
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteTable(project.id, tableId);
          const remaining = project.tables.filter((t) => t.id !== tableId);
          await openProject(project.id, remaining[0]?.id);
          await loadProjects();
        } catch (cause) {
          setError(cause instanceof ApiError ? cause.message : 'Could not remove the table.');
        }
      },
    });
  };

  const handleDeleteProject = (projectId: number) => {
    setDialog({
      title: 'Delete this project?',
      body: 'The project and all of its data will be deleted.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.deleteProject(projectId);
          const list = await loadProjects();
          setProject(null);
          setTable(null);
          setModel(null);
          if (list.length > 0) await openProject(list[0].id);
          else setScreen('sources');
        } catch (cause) {
          setError(cause instanceof ApiError ? cause.message : 'Could not delete the project.');
        }
      },
    });
  };

  const handleTableChanged = async (updated: TableDetail) => {
    setTable(updated);
    if (project) {
      // Row counts and the model can both shift after an operation.
      setProject(await api.getProject(project.id));
      void loadModel(project.id);
    }
  };

  /* ── Render ──────────────────────────────────────────────────────────── */

  if (booting) {
    return (
      <div className="h-screen w-screen bg-[#030712] flex items-center justify-center text-gray-400">
        <Loader2 className="h-5 w-5 animate-spin mr-3 text-cyan-400" />
        <span className="text-sm">Starting up…</span>
      </div>
    );
  }

  const tables = project?.tables ?? [];
  const canUseTable = table !== null;

  return (
    <div className="flex h-screen w-screen bg-[#030712] overflow-hidden text-gray-200">
      {/* Sidebar */}
      <aside className="w-64 border-r border-gray-900 bg-zinc-950/80 flex flex-col shrink-0 no-print">
        <div className="p-5 border-b border-gray-900 flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center">
            <span className="text-black font-black text-base">C</span>
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-extrabold tracking-wider bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              CLEANYTICS
            </h1>
            <p className="text-[10px] text-gray-500 truncate">{project?.name ?? 'No project'}</p>
          </div>
        </div>

        <nav className="px-3 py-4 space-y-1">
          {NAV.map((item) => {
            const Icon = item.icon;
            const disabled = (item.needsTable && !canUseTable) || !project;
            const active = screen === item.id;
            const badge =
              item.id === 'clean' ? table?.quality?.summary.total ?? 0
                : item.id === 'model' ? model?.pending_count ?? 0
                  : 0;
            return (
              <button
                key={item.id}
                disabled={disabled}
                onClick={() => setScreen(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-semibold transition ${
                  active
                    ? 'bg-cyan-950/40 text-cyan-300 border border-cyan-800/40'
                    : disabled
                      ? 'text-gray-700 cursor-not-allowed'
                      : 'text-gray-400 hover:text-gray-100 hover:bg-zinc-900/40'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon className="h-4 w-4" />
                  {item.label}
                </span>
                {badge > 0 && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-800/30">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Tables in this project */}
        {tables.length > 0 && (
          <div className="px-3 pb-3">
            <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest px-2 mb-1.5">
              Tables ({tables.length})
            </p>
            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {tables.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => project && openTable(project.id, entry.id)}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] transition flex items-center justify-between gap-2 ${
                    entry.id === table?.id
                      ? 'bg-cyan-950/40 text-cyan-300'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-zinc-900/40'
                  }`}
                >
                  <span className="truncate">{entry.table_name}</span>
                  <span className="text-[9px] font-mono text-gray-600 shrink-0">
                    {count(entry.row_count)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Projects */}
        <div className="mt-auto border-t border-gray-900 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">Projects</p>
            <button
              onClick={createProject}
              className="text-cyan-400 hover:text-cyan-300"
              aria-label="New project"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="space-y-0.5 max-h-40 overflow-y-auto">
            {projects.map((entry) => (
              <div
                key={entry.id}
                className={`group flex items-center gap-1 rounded-lg ${
                  entry.id === project?.id ? 'bg-cyan-950/30' : 'hover:bg-zinc-900/40'
                }`}
              >
                <button
                  onClick={() => openProject(entry.id)}
                  className={`flex-1 text-left px-2.5 py-1.5 text-[11px] truncate ${
                    entry.id === project?.id ? 'text-cyan-300' : 'text-gray-400'
                  }`}
                >
                  {entry.name}
                  <span className="block text-[9px] text-gray-600">
                    {entry.table_count} table{entry.table_count === 1 ? '' : 's'} · {count(entry.row_count)} rows
                  </span>
                </button>
                <button
                  onClick={() => handleDeleteProject(entry.id)}
                  className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 px-2"
                  aria-label={`Delete ${entry.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          {health && !health.auth_enabled && (
            <p className="text-[9px] text-gray-600 leading-snug pt-1 border-t border-gray-900">
              Local workspace. Sign-in is off until it is configured.
            </p>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-7 max-w-[1600px] mx-auto">
          {error && (
            <div className="mb-5 flex items-start gap-3 p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-300 text-xs">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p>{error}</p>
                <button onClick={() => setError(null)} className="text-red-400/70 hover:text-red-300 mt-1">
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {!project ? (
            <div className="glass-panel rounded-xl p-12 max-w-md mx-auto text-center space-y-4 mt-16">
              <Database className="h-12 w-12 text-gray-700 mx-auto" />
              <h3 className="text-base font-bold text-white">Start a project</h3>
              <p className="text-xs text-gray-400">
                A project holds your files, how they relate to each other, and everything you build
                from them.
              </p>
              <button
                onClick={createProject}
                className="px-4 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white font-semibold text-xs"
              >
                New project
              </button>
            </div>
          ) : (
            <>
              {screen === 'sources' && (
                <UploadModule
                  projectId={project.id}
                  tables={tables}
                  maxUploadMb={health?.max_upload_mb ?? 200}
                  activeTableId={table?.id ?? null}
                  onUploaded={handleUploaded}
                  onDeleteTable={handleDeleteTable}
                  onSelectTable={(id) => { void openTable(project.id, id); setScreen('overview'); }}
                />
              )}

              {screen === 'overview' && table && (
                <OverviewModule table={table} onNavigate={(next) => setScreen(next as Screen)} />
              )}

              {/* Keyed by table so paging and sorting reset when you switch tables. */}
              {screen === 'data' && table && (
                <DataGrid key={table.id} projectId={project.id} table={table} />
              )}

              {screen === 'clean' && table && (
                <CleanModule
                  projectId={project.id}
                  table={table}
                  history={history}
                  onTableChanged={handleTableChanged}
                  onHistoryChanged={() => void loadHistory(project.id, table.id)}
                />
              )}

              {screen === 'transform' && table && (
                // Keyed by table id so the form resets when you switch tables,
                // rather than carrying another table's column names across.
                <TransformModule
                  key={table.id}
                  projectId={project.id}
                  table={table}
                  onTableChanged={handleTableChanged}
                  onHistoryChanged={() => void loadHistory(project.id, table.id)}
                />
              )}

              {screen === 'model' && model && (
                <SemanticModelModule
                  projectId={project.id}
                  model={model}
                  onModelChanged={() => { void loadModel(project.id); void openProject(project.id, table?.id); }}
                />
              )}

              {screen === 'dashboard' && model && (
                <div className="space-y-4">
                  <AutoDashboard
                    projectId={project.id}
                    model={model}
                    tables={tables}
                    onOpenTable={(id) => { void openTable(project.id, id); setScreen('data'); }}
                  />
                  <DashboardBuilder projectId={project.id} model={model} />
                </div>
              )}

              {screen === 'report' && table && model && (
                <ReportGenerator projectId={project.id} table={table} model={model} />
              )}
            </>
          )}
        </div>
      </main>

      {dialog && <Dialog request={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}
