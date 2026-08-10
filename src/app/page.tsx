'use client';

import React, { useState, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { 
  Database, ShieldCheck, Sigma, Grid, Download, 
  RotateCcw, History, FileSpreadsheet, ArrowUpRight, CheckCircle2,
  LogIn, User as UserIcon, RefreshCw, FileText, LayoutDashboard,
  Layers, ChevronRight, Zap
} from 'lucide-react';

import UploadModule from '../components/UploadModule';
import CleanModule from '../components/CleanModule';
import TransformModule from '../components/TransformModule';
import DashboardBuilder from '../components/DashboardBuilder';
import ReportGenerator from '../components/ReportGenerator';
import OverviewModule from '../components/OverviewModule';
import AuthModal, { AuthUser } from '../components/AuthModal';
import SemanticModelModule from '../components/SemanticModelModule';
import { Dataset } from '../utils/parser';
import type {
  SemanticProfile, QualitySuggestion, TransformationSuggestion,
  MeasureRecommendation, TransformationEntry, DataTableMeta, RelationshipCandidate
} from '../utils/profiler';

type ModuleType = 'upload' | 'overview' | 'cleaning' | 'transform' | 'model' | 'dashboard' | 'report' | 'export';

export default function Home() {
  const [activeModule, setActiveModule] = useState<ModuleType>('upload');
  
  // Data State & History
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [history, setHistory] = useState<Dataset[]>([]);
  const [actionHistory, setActionHistory] = useState<string[]>([]);

  // Intelligence State
  const [profile, setProfile] = useState<SemanticProfile | null>(null);
  const [qualitySuggestions, setQualitySuggestions] = useState<QualitySuggestion[]>([]);
  const [transformSuggestions, setTransformSuggestions] = useState<TransformationSuggestion[]>([]);
  const [measureRecommendations, setMeasureRecommendations] = useState<MeasureRecommendation[]>([]);
  const [transformHistory, setTransformHistory] = useState<TransformationEntry[]>([]);
  const [isProfileLoading, setIsProfileLoading] = useState(false);

  // Auth State
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  // Projects & Multi-Table State
  const [projects, setProjects] = useState<any[]>([]);
  const [savingProject, setSavingProject] = useState(false);
  const [projectTables, setProjectTables] = useState<DataTableMeta[]>([]);
  const [projectRelationships, setProjectRelationships] = useState<RelationshipCandidate[]>([]);
  const [activeTableId, setActiveTableId] = useState<number | null>(null);

  // ─── Intelligence: Run profiling after dataset changes ────────────
  const runProfiling = useCallback(async (data: Record<string, any>[]) => {
    if (!data || data.length === 0) return;
    setIsProfileLoading(true);
    try {
      const [profileRes, qualityRes, transformRes, measureRes] = await Promise.all([
        fetch('/api/profile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        }),
        fetch('/api/quality-suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        }),
        fetch('/api/transformation-suggestions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        }),
        fetch('/api/measure-recommendations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        }),
      ]);

      if (profileRes.ok) {
        const profileData = await profileRes.json();
        setProfile(profileData);
      }
      if (qualityRes.ok) {
        const qualityData = await qualityRes.json();
        setQualitySuggestions(qualityData.suggestions || []);
      }
      if (transformRes.ok) {
        const transformData = await transformRes.json();
        setTransformSuggestions(transformData.suggestions || []);
      }
      if (measureRes.ok) {
        const measureData = await measureRes.json();
        setMeasureRecommendations(measureData.recommendations || []);
      }
    } catch (err) {
      console.error('Profiling failed:', err);
    } finally {
      setIsProfileLoading(false);
    }
  }, []);

  // ─── Apply suggestion (quality or transformation) ─────────────────
  const handleApplySuggestion = useCallback(async (suggestion: any) => {
    if (!dataset) return;
    try {
      const res = await fetch('/api/apply-suggestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dataset.rows,
          suggestion_id: suggestion.id,
          suggestion_type: suggestion.type,
          column: suggestion.column || suggestion.target_column,
          parameters: suggestion.parameters || {},
        }),
      });

      if (!res.ok) throw new Error('Failed to apply suggestion');
      const result = await res.json();

      // Save current state for undo
      setHistory(prev => [...prev, dataset]);
      setActionHistory(prev => [...prev, result.description || 'Applied suggestion']);

      // Rebuild full Dataset with proper types, stats, nullCounts
      const { processRawRows } = await import('../utils/parser');
      const newDataset = processRawRows(
        result.data,
        dataset.fileName,
        dataset.fileSize,
        dataset.projectId
      );
      setDataset(newDataset);

      // Add to transformation history
      setTransformHistory(prev => [...prev, {
        id: `th-${Date.now()}`,
        timestamp: new Date().toISOString(),
        operation: suggestion.type,
        description: result.description || suggestion.name || suggestion.recommendation,
        source: 'suggestion',
        suggestion_id: suggestion.id,
      }]);

      // Remove the applied suggestion from the list
      setQualitySuggestions(prev => prev.filter(s => s.id !== suggestion.id));
      setTransformSuggestions(prev => prev.filter(s => s.id !== suggestion.id));

      // Re-run profiling with new data
      runProfiling(result.data);
    } catch (err) {
      console.error('Apply suggestion failed:', err);
      alert('Failed to apply suggestion. Please try again.');
    }
  }, [dataset, runProfiling]);

  // ─── Projects ─────────────────────────────────────────────────────
  const fetchProjects = async () => {
    try {
      const res = await fetch('/api/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
      }
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    }
  };

  useEffect(() => {
    setUser({ id: 1, name: 'Guest User', email: 'guest@cleanlytics.local' } as AuthUser);
    setAuthLoading(false);
    fetchProjects();
  }, []);

  const saveProject = async () => {
    if (!dataset) return;
    if ((dataset as any).projectId) {
      alert("Project is already saved to your cloud workspace. You can update your widgets layout inside the BI Dashboard!");
      return;
    }

    const name = prompt("Enter a name for this project:", dataset.fileName.split('.')[0]);
    if (!name) return;

    setSavingProject(true);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          file_name: dataset.fileName,
          rows_data: dataset.rows,
          headers: dataset.headers,
          types: dataset.types
        }),
      });

      if (!res.ok) throw new Error("Save project failed");
      const data = await res.json();
      setDataset(prev => prev ? { ...prev, projectId: data.id } as any : null);
      alert(`Project "${name}" successfully saved!`);
      fetchProjects();
    } catch (err) {
      console.error(err);
      alert("Failed to save project. Please try again.");
    } finally {
      setSavingProject(false);
    }
  };

  const loadProject = async (projectId: number) => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      if (!res.ok) throw new Error("Load project failed");
      const data = await res.json();

      const tablesList: DataTableMeta[] = (data.tables || []).map((t: any) => ({
        id: t.id,
        tableName: t.table_name,
        fileName: t.file_name,
        rowCount: t.row_count,
        columnCount: (t.headers || []).length,
        headers: t.headers || [],
        types: t.types || {},
        profile: t.profile || null,
      }));

      setProjectTables(tablesList);
      setProjectRelationships(data.relationships || []);

      if (tablesList.length > 0) {
        const firstTable = tablesList[0];
        setActiveTableId(firstTable.id);

        // Fetch full rows for first table
        const tableRes = await fetch(`/api/projects/${projectId}/tables/${firstTable.id}`);
        if (tableRes.ok) {
          const tableData = await tableRes.json();
          const { processRawRows } = await import('../utils/parser');
          const loadedDataset = processRawRows(
            tableData.rows_data,
            tableData.file_name,
            0,
            projectId
          );
          setDataset(loadedDataset);
          if (tableData.profile) setProfile(tableData.profile);
          else runProfiling(tableData.rows_data);
        }
      } else if (data.rows_data) {
        // Legacy single table fallback
        const { processRawRows } = await import('../utils/parser');
        const loadedDataset = processRawRows(
          data.rows_data,
          data.file_name,
          0,
          data.id
        );
        setDataset(loadedDataset);
        runProfiling(data.rows_data);
      }

      setHistory([]);
      setActionHistory([]);
      setTransformHistory([]);
      setActiveModule('overview');
    } catch (err) {
      console.error(err);
      alert("Failed to load project dataset.");
    }
  };

  const handleDetectRelationships = async () => {
    if (!dataset?.projectId) return;
    try {
      const res = await fetch(`/api/projects/${dataset.projectId}/detect-relationships`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        setProjectRelationships(data.relationships || []);
      }
    } catch (err) {
      console.error("Detect relationships failed:", err);
    }
  };

  const handleUpdateRelationshipStatus = async (relId: number, status: 'approved' | 'rejected') => {
    if (!dataset?.projectId) return;
    try {
      const res = await fetch(`/api/projects/${dataset.projectId}/relationships/${relId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) {
        const updated = await res.json();
        setProjectRelationships(prev => prev.map(r => r.id === relId ? { ...r, status: updated.status } : r));
      }
    } catch (err) {
      console.error("Update relationship failed:", err);
    }
  };

  const handleDeleteTable = async (tableId: number) => {
    if (!dataset?.projectId) return;
    if (!confirm("Are you sure you want to delete this table?")) return;
    try {
      const res = await fetch(`/api/projects/${dataset.projectId}/tables/${tableId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setProjectTables(prev => prev.filter(t => t.id !== tableId));
        setProjectRelationships(prev => prev.filter(r => r.fromTableId !== tableId && r.toTableId !== tableId));
        if (activeTableId === tableId) {
          const remaining = projectTables.filter(t => t.id !== tableId);
          if (remaining.length > 0) handleSelectActiveTable(remaining[0].id);
          else setDataset(null);
        }
      }
    } catch (err) {
      console.error("Delete table failed:", err);
    }
  };

  const handleSelectActiveTable = async (tableId: number) => {
    if (!dataset?.projectId) return;
    setActiveTableId(tableId);
    try {
      const res = await fetch(`/api/projects/${dataset.projectId}/tables/${tableId}`);
      if (res.ok) {
        const tableData = await res.json();
        const { processRawRows } = await import('../utils/parser');
        const loadedDataset = processRawRows(
          tableData.rows_data,
          tableData.file_name,
          0,
          dataset.projectId
        );
        setDataset(loadedDataset);
        if (tableData.profile) setProfile(tableData.profile);
        else runProfiling(tableData.rows_data);
      }
    } catch (err) {
      console.error("Failed to select active table:", err);
    }
  };

  const handleAddTable = async (file: File, tableName: string) => {
    if (!dataset?.projectId) return;
    try {
      const { parseFile } = await import('../utils/parser');
      const parsed = await parseFile(file);

      const res = await fetch(`/api/projects/${dataset.projectId}/tables`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          table_name: tableName,
          file_name: file.name,
          rows_data: parsed.rows,
          headers: parsed.headers,
          types: parsed.types,
        }),
      });

      if (res.ok) {
        const newTable = await res.json();
        const meta: DataTableMeta = {
          id: newTable.id,
          tableName: newTable.table_name,
          fileName: newTable.file_name,
          rowCount: newTable.row_count,
          columnCount: (newTable.headers || []).length,
          headers: newTable.headers,
          types: newTable.types,
          profile: newTable.profile,
        };
        setProjectTables(prev => [...prev, meta]);
        // Run relationship detection automatically
        handleDetectRelationships();
      }
    } catch (err) {
      console.error("Failed to add table:", err);
    }
  };

  // ─── Dataset lifecycle ────────────────────────────────────────────
  const handleDatasetLoaded = async (newDataset: Dataset, tableName?: string) => {
    setDataset(newDataset);
    setHistory([]);
    setActionHistory([]);
    setTransformHistory([]);
    setActiveModule('overview');

    // Auto-create backend project if not created
    if (!newDataset.projectId) {
      const projName = tableName || newDataset.fileName.split('.')[0];
      try {
        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: projName,
            file_name: newDataset.fileName,
            rows_data: newDataset.rows,
            headers: newDataset.headers,
            types: newDataset.types,
          }),
        });
        if (res.ok) {
          const projData = await res.json();
          setDataset(prev => prev ? { ...prev, projectId: projData.id } as Dataset : null);
          // Fetch tables list
          const tablesRes = await fetch(`/api/projects/${projData.id}/tables`);
          if (tablesRes.ok) {
            const tData = await tablesRes.json();
            setProjectTables(tData.map((t: any) => ({
              id: t.id,
              tableName: t.table_name,
              fileName: t.file_name,
              rowCount: t.row_count,
              columnCount: (t.headers || []).length,
              headers: t.headers || [],
              types: t.types || {},
              profile: t.profile || null,
            })));
          }
          fetchProjects();
        }
      } catch (err) {
        console.error("Auto save project error:", err);
      }
    }
    
    // Trigger profiling
    runProfiling(newDataset.rows);
  };

  const handleDatasetUpdated = (newDataset: Dataset, actionDesc: string) => {
    if (dataset) {
      setHistory(prev => [...prev, dataset]);
      setActionHistory(prev => [...prev, actionDesc]);
    }
    setDataset(newDataset);

    // Add to transformation history
    setTransformHistory(prev => [...prev, {
      id: `th-${Date.now()}`,
      timestamp: new Date().toISOString(),
      operation: 'manual',
      description: actionDesc,
      source: 'manual',
    }]);

    // Re-profile after changes
    runProfiling(newDataset.rows);
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const prevDataset = history[history.length - 1];
    setDataset(prevDataset);
    setHistory(prev => prev.slice(0, -1));
    setActionHistory(prev => prev.slice(0, -1));
    setTransformHistory(prev => prev.slice(0, -1));

    // Re-profile after undo
    runProfiling(prevDataset.rows);
  };

  const handleUploadClick = () => {
    setActiveModule('upload');
  };

  // ─── Export ───────────────────────────────────────────────────────
  const exportData = async (format: 'csv' | 'xlsx') => {
    if (!dataset) return;
    try {
      const res = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: dataset.rows, format })
      });
      
      if (!res.ok) throw new Error("Export failed on server");
      
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `${dataset.fileName.split('.')[0]}_cleaned.${format}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      console.error(err);
      alert("Failed to export data.");
    }
  };

  const exportCSV = () => exportData('csv');
  const exportExcel = () => exportData('xlsx');

  // ─── Navigation items ─────────────────────────────────────────────
  const workspaceNav = [
    { id: 'overview' as const, label: 'Overview', icon: LayoutDashboard, requiresData: true },
    { id: 'upload' as const, label: 'Data', icon: FileText },
    { id: 'cleaning' as const, label: 'Cleaning', icon: ShieldCheck, requiresData: true },
    { id: 'transform' as const, label: 'Transform', icon: Sigma, requiresData: true },
    { id: 'model' as const, label: 'Model', icon: Layers, requiresData: true },
    { id: 'dashboard' as const, label: 'Dashboard', icon: Grid, requiresData: true },
  ];

  const toolsNav = [
    { id: 'report' as const, label: 'Reports', icon: FileSpreadsheet, requiresData: true },
    { id: 'export' as const, label: 'Export', icon: Download, requiresData: true },
  ];

  // Badge counts for nav items
  const getNavBadge = (id: string): number | null => {
    if (id === 'cleaning' && qualitySuggestions.length > 0) return qualitySuggestions.length;
    if (id === 'transform' && transformSuggestions.length > 0) return transformSuggestions.length;
    return null;
  };

  const renderNavItem = (item: { id: ModuleType; label: string; icon: any; requiresData?: boolean }) => {
    const Icon = item.icon;
    const isDisabled = item.requiresData && !dataset;
    const isActive = activeModule === item.id;
    const badge = getNavBadge(item.id);

    return (
      <button
        key={item.id}
        disabled={isDisabled}
        onClick={() => setActiveModule(item.id)}
        className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-lg text-xs font-semibold transition-all duration-150 ${
          isActive 
            ? 'bg-gradient-to-r from-cyan-950/40 to-emerald-950/20 text-cyan-400 border border-cyan-800/40' 
            : isDisabled 
              ? 'text-gray-600 cursor-not-allowed opacity-50' 
              : 'text-gray-400 hover:text-gray-200 hover:bg-zinc-900/30'
        }`}
      >
        <div className="flex items-center gap-3">
          <Icon className={`h-4 w-4 ${isActive ? 'text-cyan-400' : 'text-gray-500'}`} />
          <span>{item.label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {badge !== null && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-800/30">
              {badge}
            </span>
          )}
          {isActive && (
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow shadow-cyan-400/50"></span>
          )}
        </div>
      </button>
    );
  };

  return (
    <div className="flex h-screen w-screen bg-[#030712] overflow-hidden text-gray-200">
      
      {/* ═══════ Sidebar ═══════ */}
      <aside className="w-64 border-r border-gray-900 bg-zinc-950/80 flex flex-col shrink-0 no-print">
        
        {/* Brand */}
        <div className="p-6 border-b border-gray-900 flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <span className="text-black font-black text-base tracking-tight">C</span>
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-wider bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              CLEANYTICS
            </h1>
            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mt-0.5">Data Workspace</p>
          </div>
        </div>

        {/* Workspace Navigation */}
        <nav className="flex-1 px-4 py-5 space-y-4 overflow-y-auto">
          <div className="space-y-1.5">
            <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest px-3.5 mb-1">Workspace</p>
            {workspaceNav.map(renderNavItem)}
          </div>

          {/* Data Sources Widget */}
          {projectTables.length > 0 && (
            <div className="p-3 border border-gray-800/60 bg-zinc-950/40 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">DATA SOURCES</p>
                <span className="text-[9px] font-mono text-cyan-400 font-bold bg-cyan-950/60 px-1.5 py-0.5 rounded border border-cyan-800/40">
                  {projectTables.length} tables
                </span>
              </div>
              <div className="h-px bg-gray-800/60 w-full" />
              <div className="space-y-1 max-h-[140px] overflow-y-auto pr-0.5">
                {projectTables.map(t => {
                  const isActive = activeTableId === t.id;
                  return (
                    <div
                      key={t.id}
                      onClick={() => handleSelectActiveTable(t.id)}
                      className={`flex items-center justify-between text-xs py-1.5 px-2.5 rounded-lg cursor-pointer transition ${
                        isActive
                          ? 'bg-cyan-950/50 text-cyan-400 font-semibold border border-cyan-800/40'
                          : 'text-gray-300 hover:bg-zinc-900/60 hover:text-white'
                      }`}
                    >
                      <span className="truncate font-medium">{t.tableName}</span>
                      <span className="text-[10px] font-mono text-gray-500 shrink-0 ml-2">{t.rowCount.toLocaleString()} rows</span>
                    </div>
                  );
                })}
              </div>
              <button
                onClick={() => setActiveModule('upload')}
                className="w-full text-center text-[11px] font-semibold text-cyan-400 hover:text-cyan-300 pt-1 flex items-center justify-center gap-1 border-t border-gray-800/40"
              >
                + Add data source
              </button>
            </div>
          )}

          <div className="space-y-1.5 pt-2 border-t border-gray-900/60">
            <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest px-3.5 mb-1">Tools</p>
            {toolsNav.map(renderNavItem)}
          </div>
        </nav>

        {/* Saved Reports */}
        {user && projects.length > 0 && (
          <div className="px-4 py-3 border-t border-gray-900 flex-1 flex flex-col min-h-0 bg-zinc-950/20 max-h-[200px]">
            <p className="text-[9px] font-bold text-gray-600 uppercase tracking-widest mb-2 shrink-0 px-0.5">Saved Projects</p>
            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {projects.map((proj) => {
                const isActive = (dataset as any)?.projectId === proj.id;
                return (
                  <button
                    key={proj.id}
                    onClick={() => loadProject(proj.id)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-[11px] font-medium transition truncate flex items-center justify-between gap-2 border ${
                      isActive
                        ? 'bg-cyan-950/20 text-cyan-400 border-cyan-800/30'
                        : 'text-gray-400 hover:text-gray-200 bg-zinc-900/10 border-transparent hover:bg-zinc-900/30'
                    }`}
                  >
                    <span className="truncate flex-1">{proj.name}</span>
                    <span className="text-[8px] text-gray-600 font-mono">
                      {new Date(proj.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* User & Dataset Info */}
        <div className="p-4 border-t border-gray-900 bg-zinc-950/40 space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center">
              <UserIcon className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-gray-200 truncate">Guest User</p>
              <p className="text-[10px] text-emerald-400 truncate">Local Workspace</p>
            </div>
          </div>

          {dataset && (
            <div className="pt-2 border-t border-gray-800/40">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Active Dataset</p>
                  <p className="text-xs text-gray-300 font-semibold truncate max-w-[170px] mt-0.5" title={dataset.fileName}>
                    {dataset.fileName}
                  </p>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {dataset.rows.length.toLocaleString()} rows · {dataset.headers.length} cols
                    {profile && ` · ${profile.summary.quality_score}% quality`}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Operations Log */}
          {actionHistory.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-gray-800/40">
              <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                <History className="h-3.5 w-3.5" />
                Operations ({actionHistory.length})
              </p>
              <div className="max-h-[80px] overflow-y-auto space-y-1.5 pr-1 font-mono text-[9px] text-gray-400">
                {actionHistory.slice(-4).reverse().map((act, idx) => (
                  <div key={idx} className="flex gap-1.5 items-start">
                    <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0 mt-0.5" />
                    <span className="leading-snug">{act}</span>
                  </div>
                ))}
              </div>
              {history.length > 0 && (
                <button
                  onClick={handleUndo}
                  className="w-full text-[10px] text-gray-500 hover:text-amber-400 font-semibold flex items-center justify-center gap-1 transition pt-1"
                >
                  <RotateCcw className="h-3 w-3" /> Undo Last
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* ═══════ Main Content ═══════ */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto bg-gradient-to-b from-[#030712] via-[#090b16] to-[#04060d]">
        
        {/* Top Header */}
        <header className="h-14 border-b border-gray-900 px-8 flex items-center justify-between shrink-0 no-print bg-zinc-950/20">
          <div className="flex items-center gap-3">
            {/* Breadcrumb */}
            <span className="text-[10px] font-bold text-gray-600 uppercase tracking-wider">
              Workspace
            </span>
            <ChevronRight className="h-3 w-3 text-gray-700" />
            <span className="text-xs font-semibold text-gray-300">
              {workspaceNav.find(n => n.id === activeModule)?.label || 
               toolsNav.find(n => n.id === activeModule)?.label || 
               'Data'}
            </span>
            {isProfileLoading && (
              <span className="flex items-center gap-1.5 text-[10px] text-cyan-400 ml-3">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Analyzing...
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {dataset && (
              <button
                onClick={saveProject}
                disabled={savingProject}
                className="px-3.5 py-1.5 rounded-lg border border-cyan-800 bg-cyan-950/40 text-cyan-400 hover:text-white hover:bg-cyan-900/60 hover:border-cyan-700 transition flex items-center gap-1.5 text-xs font-semibold"
                title="Save current dataset and state to database"
              >
                {savingProject ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Database className="h-3.5 w-3.5" />
                )}
                {(dataset as any).projectId ? "Saved" : "Save Project"}
              </button>
            )}
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 p-8">
          
          {/* No dataset and not on upload */}
          {!dataset && activeModule !== 'upload' ? (
            <div className="glass-panel p-8 rounded-xl max-w-md mx-auto text-center space-y-4 py-16 animate-fade-in mt-12">
              <Database className="h-12 w-12 text-gray-600 mx-auto" />
              <h3 className="text-base font-bold text-white">No Dataset Active</h3>
              <p className="text-xs text-gray-400">
                Import a CSV or Excel file to start working with your data.
              </p>
              <button
                onClick={handleUploadClick}
                className="px-4 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white font-semibold text-xs hover:from-cyan-400 hover:to-emerald-400 transition"
              >
                Go to Data Upload
              </button>
            </div>
          ) : (
            <>
              {activeModule === 'upload' && user && (
                <UploadModule 
                  onDatasetLoaded={handleDatasetLoaded} 
                  onAddTable={handleAddTable}
                  dataset={dataset} 
                  tables={projectTables}
                  projectId={dataset?.projectId}
                />
              )}

              {dataset && activeModule === 'overview' && (
                <OverviewModule
                  dataset={dataset}
                  profile={profile}
                  qualitySuggestions={qualitySuggestions}
                  transformSuggestions={transformSuggestions}
                  measureRecommendations={measureRecommendations}
                  transformHistory={transformHistory}
                  onNavigate={(mod) => setActiveModule(mod as ModuleType)}
                  onApplySuggestion={handleApplySuggestion}
                  isProfileLoading={isProfileLoading}
                />
              )}

              {dataset && activeModule === 'cleaning' && (
                <CleanModule 
                  dataset={dataset} 
                  onDatasetUpdated={handleDatasetUpdated}
                  onUndo={handleUndo}
                  canUndo={history.length > 0}
                  qualitySuggestions={qualitySuggestions}
                  onApplySuggestion={handleApplySuggestion}
                />
              )}

              {dataset && activeModule === 'transform' && (
                <TransformModule 
                  dataset={dataset} 
                  onDatasetUpdated={handleDatasetUpdated}
                  onUndo={handleUndo}
                  canUndo={history.length > 0}
                  profile={profile}
                  transformSuggestions={transformSuggestions}
                  measureRecommendations={measureRecommendations}
                  onApplySuggestion={handleApplySuggestion}
                />
              )}

              {dataset && activeModule === 'model' && (
                <SemanticModelModule
                  projectId={dataset.projectId}
                  tables={projectTables}
                  relationships={projectRelationships}
                  onDetectRelationships={handleDetectRelationships}
                  onUpdateRelationshipStatus={handleUpdateRelationshipStatus}
                  onDeleteTable={handleDeleteTable}
                  onSelectActiveTable={handleSelectActiveTable}
                  activeTableId={activeTableId}
                />
              )}

              {dataset && activeModule === 'dashboard' && (
                <DashboardBuilder
                  dataset={dataset}
                  profile={profile}
                  tables={projectTables}
                  relationships={projectRelationships}
                />
              )}

              {dataset && activeModule === 'report' && (
                <ReportGenerator dataset={dataset} />
              )}

              {dataset && activeModule === 'export' && (
                <div className="space-y-6 max-w-xl mx-auto animate-fade-in">
                  <div>
                    <h2 className="text-2xl font-bold tracking-tight text-white">Export Center</h2>
                    <p className="text-gray-400 text-sm mt-1">Download your cleaned dataset structure or export analytics reports.</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="glass-panel p-5 rounded-xl border border-gray-800 space-y-4 hover:border-cyan-500/30 transition duration-300">
                      <div className="h-10 w-10 rounded-lg bg-cyan-950/40 border border-cyan-800/30 flex items-center justify-center">
                        <FileSpreadsheet className="h-5 w-5 text-cyan-400" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-white">Cleaned CSV Export</h3>
                        <p className="text-xs text-gray-400 mt-1">Export raw table format using standard comma separators. Great for data science pipelines.</p>
                      </div>
                      <button
                        onClick={exportCSV}
                        className="w-full py-2.5 rounded-lg bg-cyan-950/40 border border-cyan-800/40 hover:bg-cyan-900/40 text-cyan-400 font-semibold text-xs flex items-center justify-center gap-1.5 transition"
                      >
                        Download CSV
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="glass-panel p-5 rounded-xl border border-gray-800 space-y-4 hover:border-emerald-500/30 transition duration-300">
                      <div className="h-10 w-10 rounded-lg bg-emerald-950/40 border border-emerald-800/30 flex items-center justify-center">
                        <FileSpreadsheet className="h-5 w-5 text-emerald-400" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-white">Excel Workbook Export</h3>
                        <p className="text-xs text-gray-400 mt-1">Download standard XLSX format file with sheets support. Best for Microsoft Excel/Power BI import.</p>
                      </div>
                      <button
                        onClick={exportExcel}
                        className="w-full py-2.5 rounded-lg bg-emerald-950/40 border border-emerald-800/40 hover:bg-emerald-900/40 text-emerald-400 font-semibold text-xs flex items-center justify-center gap-1.5 transition"
                      >
                        Download Excel (.xlsx)
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

        </div>
      </main>
    </div>
  );
}
