'use client';

import React, {
  useCallback, useEffect, useRef, useState,
} from 'react';
import {
  AlertTriangle, Database, FileSpreadsheet, Grid, Layers,
  LayoutDashboard, Loader2, LogIn, LogOut, Plus,
  ShieldCheck, Sigma, Table2, Trash2,
} from 'lucide-react';

import { useAuth } from '../components/AuthProvider';
import AutoDashboard from '../components/AutoDashboard';
import CleanModule from '../components/CleanModule';

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
  HealthInfo, HistoryEntry, ProjectDetail, ProjectSummary,
  SemanticModel, TableDetail, UploadResult,
} from '../lib/types';

type Screen =
  | 'sources'
  | 'overview'
  | 'data'
  | 'clean'
  | 'transform'
  | 'model'
  | 'dashboard'
  | 'report';

const SCREENS: Screen[] = [
  'sources', 'overview', 'data', 'clean',
  'transform', 'model', 'dashboard', 'report',
];

function screenFromHash(): Screen | null {
  if (typeof window === 'undefined') return null;
  const candidate = window.location.hash.replace('#', '') as Screen;
  return SCREENS.includes(candidate) ? candidate : null;
}

const NAV: {
  id: Screen;
  label: string;
  icon: typeof Database;
  needsTable: boolean;
}[] = [
  { id: 'sources', label: 'Data sources', icon: Database, needsTable: false },
  { id: 'overview', label: 'Analysis', icon: LayoutDashboard, needsTable: true },
  { id: 'data', label: 'Rows', icon: Table2, needsTable: true },
  { id: 'clean', label: 'Quality', icon: ShieldCheck, needsTable: true },
  { id: 'transform', label: 'Reshape', icon: Sigma, needsTable: true },
  { id: 'model', label: 'Model', icon: Layers, needsTable: false },
  { id: 'dashboard', label: 'Dashboard', icon: Grid, needsTable: false },
  { id: 'report', label: 'Report', icon: FileSpreadsheet, needsTable: true },
];

function errorText(cause: unknown): string {
  return cause instanceof ApiError || cause instanceof Error
    ? cause.message
    : 'The request failed.';
}

export default function Home() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingScreen label="Checking your session…" />;
  }

  return <Workspace key={user?.id ?? 'local-workspace'} />;
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#030712] text-gray-400">
      <Loader2 className="mr-3 h-5 w-5 animate-spin text-emerald-400" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function Workspace() {
  const { user, signOut } = useAuth();

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [model, setModel] = useState<SemanticModel | null>(null);
  const [table, setTable] = useState<TableDetail | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [screen, setScreenState] = useState<Screen>('sources');
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [bootRevision, setBootRevision] = useState(0);

  const activeProject = useRef<number | null>(null);
  const activeTable = useRef<number | null>(null);
  const projectRequest = useRef(0);
  const tableRequest = useRef(0);
  const listRequest = useRef(0);
  const mutationLock = useRef(false);
  const mounted = useRef(true);

  const accountRequired = health?.auth_enabled === true && !user;

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      projectRequest.current += 1;
      tableRequest.current += 1;
      listRequest.current += 1;
    };
  }, []);

  const setScreen = useCallback((next: Screen) => {
    setScreenState(next);
    window.history.replaceState(null, '', `#${next}`);
  }, []);

  useEffect(() => {
    const changed = () => {
      const next = screenFromHash();
      if (next) setScreenState(next);
    };

    window.addEventListener('hashchange', changed);

    return () => {
      window.removeEventListener('hashchange', changed);
    };
  }, []);

  const loadProjects = useCallback(async () => {
    const request = ++listRequest.current;
    const list = await api.listProjects();

    if (mounted.current && request === listRequest.current) {
      setProjects(list);
    }

    return list;
  }, []);

  const loadHistory = useCallback(
    async (projectId: number, tableId: number) => {
      const request = tableRequest.current;

      const current = () =>
        mounted.current &&
        activeProject.current === projectId &&
        activeTable.current === tableId &&
        request === tableRequest.current;

      try {
        const result = await api.history(projectId, tableId);

        if (current()) {
          setHistory(result);
          setHistoryError(null);
        }
      } catch (cause) {
        if (current()) {
          setHistory([]);
          setHistoryError(errorText(cause));
        }
      }
    },
    [],
  );

  const openTable = useCallback(
    async (projectId: number, tableId: number) => {
      if (activeProject.current !== projectId) return;

      const request = ++tableRequest.current;
      activeTable.current = tableId;

      setTable(null);
      setHistory([]);
      setHistoryError(null);
      setBusy(true);
      setError(null);

      const current = () =>
        mounted.current &&
        request === tableRequest.current &&
        activeProject.current === projectId;

      try {
        const detail = await api.getTable(projectId, tableId);
        if (!current()) return;

        setTable(detail);
        await loadHistory(projectId, tableId);
      } catch (cause) {
        if (current()) setError(errorText(cause));
      } finally {
        if (current()) setBusy(false);
      }
    },
    [loadHistory],
  );

  const openProject = useCallback(
    async (projectId: number, preferredTableId?: number) => {
      const request = ++projectRequest.current;
      const switching = activeProject.current !== projectId;

      activeProject.current = projectId;
      tableRequest.current += 1;

      if (switching) {
        activeTable.current = null;
        setProject(null);
        setModel(null);
        setTable(null);
        setHistory([]);
        setDialog(null);
      }

      setBusy(true);
      setError(null);
      setModelError(null);
      setHistoryError(null);

      try {
        const [projectResult, modelResult] = await Promise.allSettled([
          api.getProject(projectId),
          api.getModel(projectId),
        ]);

        if (
          !mounted.current ||
          request !== projectRequest.current
        ) {
          return;
        }

        if (projectResult.status === 'rejected') {
          throw projectResult.reason;
        }

        const detail = projectResult.value;
        setProject(detail);

        if (modelResult.status === 'fulfilled') {
          setModel(modelResult.value);
        } else {
          setModel(null);
          setModelError(errorText(modelResult.reason));
        }

        const target =
          detail.tables.find(
            (entry) =>
              entry.id === (preferredTableId ?? activeTable.current),
          ) ?? detail.tables[0];

        if (target) {
          await openTable(projectId, target.id);
        } else {
          activeTable.current = null;
          setTable(null);
          setHistory([]);
          setScreen('sources');
        }
      } catch (cause) {
        if (
          mounted.current &&
          request === projectRequest.current
        ) {
          setProject(null);
          setModel(null);
          setTable(null);
          setHistory([]);
          setError(errorText(cause));
        }
      } finally {
        if (
          mounted.current &&
          request === projectRequest.current
        ) {
          setBusy(false);
        }
      }
    },
    [openTable, setScreen],
  );

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setBooting(true);
      setError(null);

      try {
        const info = await api.health();
        if (cancelled) return;

        setHealth(info);

        const initialScreen = screenFromHash();
        if (initialScreen) setScreenState(initialScreen);

        if (!info.auth_enabled || user) {
          const list = await loadProjects();

          if (!cancelled && list.length > 0) {
            await openProject(list[0].id);
          }
        }
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      } finally {
        if (!cancelled) setBooting(false);
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [user, loadProjects, openProject, bootRevision]);

  async function mutation(action: () => Promise<void>) {
    if (mutationLock.current) return;

    mutationLock.current = true;

    try {
      await action();
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      mutationLock.current = false;
    }
  }

  function createProject() {
    if (accountRequired) return;

    setDialog({
      title: 'Name this project',
      defaultValue: `Analysis ${projects.length + 1}`,
      confirmLabel: 'Create',
      onConfirm: (name) =>
        mutation(async () => {
          const created = await api.createProject(name);
          if (!mounted.current) return;

          await loadProjects();
          await openProject(created.id);
          setScreen('sources');
        }),
    });
  }

  async function handleUploaded(result: UploadResult) {
    const projectId = project?.id;

    if (
      !projectId ||
      activeProject.current !== projectId
    ) {
      return;
    }

    await openProject(projectId, result.tables[0]?.id);
    await loadProjects();

    if (
      mounted.current &&
      activeProject.current === projectId &&
      result.tables.length > 0
    ) {
      setScreen('dashboard');
    }
  }

  function handleDeleteTable(tableId: number) {
    if (!project) return;

    const projectId = project.id;

    setDialog({
      title: 'Remove this table?',
      body:
        'This deletes the uploaded table and its operation history. Charts using its fields will need to be updated.',
      confirmLabel: 'Remove',
      destructive: true,
      onConfirm: () =>
        mutation(async () => {
          await api.deleteTable(projectId, tableId);
          if (!mounted.current) return;

          if (activeProject.current === projectId) {
            await openProject(projectId);
          }

          await loadProjects();
        }),
    });
  }

  function handleDeleteProject(projectId: number) {
    setDialog({
      title: 'Delete this project?',
      body: 'The project and all of its data will be deleted.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () =>
        mutation(async () => {
          await api.deleteProject(projectId);
          if (!mounted.current) return;

          const list = await loadProjects();
          if (activeProject.current !== projectId) return;

          projectRequest.current += 1;
          tableRequest.current += 1;
          activeProject.current = null;
          activeTable.current = null;

          setProject(null);
          setTable(null);
          setModel(null);
          setHistory([]);

          if (list.length) {
            await openProject(list[0].id);
          } else {
            setScreen('sources');
          }
        }),
    });
  }

  async function handleTableChanged(updated: TableDetail) {
    const projectId = project?.id;

    if (
      !projectId ||
      activeProject.current !== projectId ||
      activeTable.current !== updated.id
    ) {
      return;
    }

    setTable(updated);
    await openProject(projectId, updated.id);

    try {
      await loadProjects();
    } catch (cause) {
      if (mounted.current) {
        setError(
          `Data was updated, but project totals could not refresh: ${errorText(cause)}`,
        );
      }
    }
  }

  async function handleSignOut() {
    if (signingOut) return;

    setSigningOut(true);
    setError(null);

    try {
      await signOut();
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      if (mounted.current) setSigningOut(false);
    }
  }

  if (booting) {
    return <LoadingScreen label="Opening your workspace…" />;
  }

  const tables = project?.tables ?? [];
  const canUseTable = table !== null && !busy;

  return (
    <div className="flex h-screen w-screen bg-[#030712] overflow-hidden text-gray-200">
      <aside className="w-64 border-r border-gray-900 bg-zinc-950/80 flex flex-col shrink-0 no-print">
        <div className="p-5 border-b border-gray-900 flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center">
            <span className="text-black font-black text-base">C</span>
          </div>
          <div className="min-w-0">
            <h1 className="text-sm font-extrabold tracking-wider bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              CLEANYTICS
            </h1>
            <p className="text-[10px] text-gray-500 truncate">
              {project?.name ?? 'No project'}
            </p>
          </div>
        </div>

        <nav className="px-3 py-4 space-y-1">
          {NAV.map((item) => {
            const Icon = item.icon;

            const disabled =
              (item.needsTable && !canUseTable) ||
              !project ||
              busy;

            const active = screen === item.id;

            const badge =
              item.id === 'clean'
                ? table?.quality?.summary.total ?? 0
                : item.id === 'model'
                  ? model?.pending_count ?? 0
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

        {tables.length > 0 && (
          <div className="px-3 pb-3">
            <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest px-2 mb-1.5">
              Tables ({tables.length})
            </p>

            <div className="space-y-0.5 max-h-48 overflow-y-auto">
              {tables.map((entry) => (
                <button
                  key={entry.id}
                  disabled={busy}
                  onClick={() => {
                    if (project) void openTable(project.id, entry.id);
                  }}
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

        <div className="mt-auto border-t border-gray-900 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">
              Projects
            </p>

            <button
              onClick={createProject}
              disabled={accountRequired || busy}
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
                  entry.id === project?.id
                    ? 'bg-cyan-950/30'
                    : 'hover:bg-zinc-900/40'
                }`}
              >
                <button
                  onClick={() => { void openProject(entry.id); }}
                  className={`flex-1 text-left px-2.5 py-1.5 text-[11px] truncate ${
                    entry.id === project?.id
                      ? 'text-cyan-300'
                      : 'text-gray-400'
                  }`}
                >
                  {entry.name}
                  <span className="block text-[9px] text-gray-600">
                    {entry.table_count} table
                    {entry.table_count === 1 ? '' : 's'}
                    {' · '}{count(entry.row_count)} rows
                  </span>
                </button>

                <button
                  onClick={() => handleDeleteProject(entry.id)}
                  className="opacity-70 hover:opacity-100 focus:opacity-100 text-gray-600 hover:text-red-400 px-2"
                  aria-label={`Delete ${entry.name}`}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          {user && (
            <div className="flex items-center gap-2 pt-1 border-t border-gray-900">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-gray-400 truncate">
                  {user.email}
                </p>
              </div>

              <button
                onClick={() => { void handleSignOut(); }}
                disabled={signingOut}
                className="flex items-center gap-1.5 rounded-lg border border-gray-700 px-2 py-1.5 text-xs text-gray-300 hover:text-red-300 disabled:opacity-50"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="h-3.5 w-3.5" />
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          )}

          {!user && (
            <a
              href="/login"
              className="flex items-center justify-center gap-2 rounded-lg border border-emerald-700 p-2 text-xs font-semibold text-emerald-300"
            >
              <LogIn className="h-4 w-4" />
              Sign in / Create account
            </a>
          )}

          {health && !health.auth_enabled && (
            <p className="text-[10px] text-amber-400">
              Local workspace: backend account isolation is disabled.
              {' '}{health.auth_note}
            </p>
          )}
        </div>
      </aside>

      <main aria-busy={busy} className="flex-1 overflow-y-auto">
        <div className="p-7 max-w-[1600px] mx-auto">
          {error && (
            <div className="mb-5 flex items-start gap-3 p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-300 text-xs">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p>{error}</p>
                <button
                  type="button"
                  onClick={() => setBootRevision((value) => value + 1)}
                  className="mr-3 mt-1 text-red-300"
                >
                  Retry workspace
                </button>
                <button
                  onClick={() => setError(null)}
                  className="text-red-400/70 hover:text-red-300 mt-1"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {busy && project && (
            <p role="status" className="mb-4 text-xs text-emerald-300">
              Refreshing project data…
            </p>
          )}

          {modelError && (
            <div className="mb-4 rounded-lg border border-amber-900/50 p-3 text-xs text-amber-300">
              Data model unavailable: {modelError}.{' '}
              <button
                type="button"
                onClick={() => {
                  if (project) void openProject(project.id, table?.id);
                }}
                className="underline"
              >
                Retry model
              </button>
            </div>
          )}

          {historyError && (
            <p className="mb-3 text-xs text-amber-300">
              Operation history unavailable: {historyError}
            </p>
          )}

          {busy && !project ? (
            <p
              role="status"
              className="flex items-center gap-2 p-8 text-sm text-gray-400"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading current project data…
            </p>
          ) : accountRequired ? (
            <div className="mx-auto mt-16 max-w-md space-y-3 rounded-xl border border-gray-800 p-8 text-center">
              <h2 className="font-semibold text-white">
                Sign in to open your projects
              </h2>
              <p className="text-xs text-gray-400">
                Your workspace is linked to your account.
              </p>
              <a
                href="/login"
                className="inline-block rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white"
              >
                Sign in / Create account
              </a>
            </div>
          ) : !project ? (
            <div className="glass-panel rounded-xl p-12 max-w-md mx-auto text-center space-y-4 mt-16">
              <Database className="h-12 w-12 text-gray-700 mx-auto" />
              <h3 className="text-base font-bold text-white">
                Start a project
              </h3>
              <p className="text-xs text-gray-400">
                A project holds your files, how they relate to each other,
                and everything you build from them.
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
                  onSelectTable={(id) => {
                    void openTable(project.id, id);
                    setScreen('overview');
                  }}
                />
              )}

              {screen === 'overview' && table && (
                <OverviewModule
                  table={table}
                  onNavigate={(next) => setScreen(next as Screen)}
                />
              )}

              {screen === 'data' && table && (
                <DataGrid
                  key={table.id}
                  projectId={project.id}
                  table={table}
                />
              )}

              {screen === 'clean' && table && (
                <CleanModule
                  projectId={project.id}
                  table={table}
                  history={history}
                  onTableChanged={handleTableChanged}
                  onHistoryChanged={() =>
                    void loadHistory(project.id, table.id)
                  }
                />
              )}

              {screen === 'transform' && table && (
                <TransformModule
                  key={table.id}
                  projectId={project.id}
                  table={table}
                  onTableChanged={handleTableChanged}
                  onHistoryChanged={() =>
                    void loadHistory(project.id, table.id)
                  }
                />
              )}

              {['model', 'dashboard', 'report'].includes(screen) &&
                !model && (
                  <p className="text-sm text-gray-400">
                    The data model is unavailable. Use Retry model above.
                  </p>
                )}

              {screen === 'model' && model && (
                <SemanticModelModule
                  projectId={project.id}
                  model={model}
                  onModelChanged={() => {
                    void openProject(project.id, table?.id);
                  }}
                />
              )}

              {screen === 'dashboard' && model && (
  <AutoDashboard
    projectId={project.id}
    model={model}
    tables={tables}
    onOpenTable={(id) => {
      void openTable(project.id, id);
      setScreen('data');
    }}
  />
)}

              {screen === 'report' && table && model && (
                <ReportGenerator
                  projectId={project.id}
                  table={table}
                  model={model}
                />
              )}
            </>
          )}
        </div>
      </main>

      {dialog && (
        <Dialog
          request={dialog}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}