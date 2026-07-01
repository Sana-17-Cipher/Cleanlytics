'use client';

import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { 
  Database, ShieldCheck, Sigma, Grid, Sparkles, Download, 
  RotateCcw, History, FileSpreadsheet, ArrowUpRight, CheckCircle2,
  LogIn, LogOut, User as UserIcon, RefreshCw,
} from 'lucide-react';

import UploadModule from '../components/UploadModule';
import CleanModule from '../components/CleanModule';
import TransformModule from '../components/TransformModule';
import DashboardBuilder from '../components/DashboardBuilder';
import AIInsights from '../components/AIInsights';
import AuthModal, { AuthUser } from '../components/AuthModal';
import { Dataset } from '../utils/parser';

type ModuleType = 'upload' | 'clean' | 'transform' | 'dashboard' | 'insights' | 'export';

export default function Home() {
  const [activeModule, setActiveModule] = useState<ModuleType>('upload');
  
  // Data State & History
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [history, setHistory] = useState<Dataset[]>([]);
  const [actionHistory, setActionHistory] = useState<string[]>([]);

  // Auth State
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);

  // Projects State
  const [projects, setProjects] = useState<any[]>([]);
  const [savingProject, setSavingProject] = useState(false);

  // Load saved projects list
  const fetchProjects = async () => {
    const token = localStorage.getItem('cleanytics_token');
    if (!token) {
      setProjects([]);
      return;
    }
    try {
      const res = await fetch('/api/projects', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
      }
    } catch (err) {
      console.error("Failed to fetch projects:", err);
    }
  };

  // Restore auth and load projects on mount
  useEffect(() => {
    const token = localStorage.getItem('cleanytics_token');
    const savedUser = localStorage.getItem('cleanytics_user');
    if (token && savedUser) {
      try {
        const u = JSON.parse(savedUser);
        setUser(u);
        setAuthToken(token);
      } catch {
        localStorage.removeItem('cleanytics_token');
        localStorage.removeItem('cleanytics_user');
      }
    }
    setAuthLoading(false);
  }, []);

  useEffect(() => {
    if (user) {
      fetchProjects();
    } else {
      setProjects([]);
    }
  }, [user]);

  const saveProject = async () => {
    if (!dataset) return;
    if (!user) {
      setShowAuthModal(true);
      return;
    }
    if (dataset.projectId) {
      alert("Project is already saved to your cloud workspace. You can update your widgets layout inside the BI Dashboard!");
      return;
    }

    const name = prompt("Enter a name for this project:", dataset.fileName.split('.')[0]);
    if (!name) return;

    setSavingProject(true);
    try {
      const token = localStorage.getItem('cleanytics_token') || authToken;
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
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

      setDataset(prev => prev ? { ...prev, projectId: data.id } : null);
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
      const token = localStorage.getItem('cleanytics_token') || authToken;
      const res = await fetch(`/api/projects/${projectId}`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });

      if (!res.ok) throw new Error("Load project failed");
      const data = await res.json();

      const loadedDataset: Dataset = {
        fileName: data.file_name,
        rows: data.rows_data,
        headers: data.headers,
        types: data.types,
        projectId: data.id
      };

      setDataset(loadedDataset);
      setHistory([]);
      setActionHistory([]);
      setActiveModule('dashboard');
    } catch (err) {
      console.error(err);
      alert("Failed to load project dataset.");
    }
  };

  const handleAuthSuccess = (authUser: AuthUser, token: string) => {
    setUser(authUser);
    setAuthToken(token);
    setShowAuthModal(false);
  };

  const handleLogout = () => {
    setUser(null);
    setAuthToken(null);
    localStorage.removeItem('cleanytics_token');
    localStorage.removeItem('cleanytics_user');
  };

  const handleDatasetLoaded = (newDataset: Dataset) => {
    setDataset(newDataset);
    setHistory([]);
    setActionHistory([]);
    setActiveModule('clean');
  };

  const handleDatasetUpdated = (newDataset: Dataset, actionDesc: string) => {
    if (dataset) {
      setHistory(prev => [...prev, dataset]);
      setActionHistory(prev => [...prev, actionDesc]);
    }
    setDataset(newDataset);
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const prevDataset = history[history.length - 1];
    setDataset(prevDataset);
    setHistory(prev => prev.slice(0, -1));
    setActionHistory(prev => prev.slice(0, -1));
  };

  // Gate upload behind auth
  const handleUploadClick = () => {
    if (!user) {
      setShowAuthModal(true);
      return;
    }
    setActiveModule('upload');
  };

  // Export functions
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

  // Nav items
  const navigationItems = [
    { id: 'upload' as const, label: 'Data Upload', icon: Database, requiresData: false, requiresAuth: true },
    { id: 'clean' as const, label: 'Data Cleaning', icon: ShieldCheck, requiresData: true, requiresAuth: true },
    { id: 'transform' as const, label: 'Transformation', icon: Sigma, requiresData: true, requiresAuth: true },
    { id: 'dashboard' as const, label: 'BI Dashboard', icon: Grid, requiresData: true, requiresAuth: false },
    { id: 'insights' as const, label: 'AI Insights', icon: Sparkles, requiresData: true, requiresAuth: true },
    { id: 'export' as const, label: 'Export Center', icon: Download, requiresData: true, requiresAuth: true },
  ];

  return (
    <div className="flex h-screen w-screen bg-[#030712] overflow-hidden text-gray-200">
      
      {/* Sidebar Navigation */}
      <aside className="w-64 border-r border-gray-900 bg-zinc-950/80 flex flex-col shrink-0 no-print">
        {/* Brand Header */}
        <div className="p-6 border-b border-gray-900 flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <span className="text-black font-black text-base tracking-tight">C</span>
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-wider bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              CLEANYTICS
            </h1>
            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest mt-0.5">BI &amp; Data Engine</p>
          </div>
        </div>

        {/* Navigation Menu */}
        <nav className="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">
          {navigationItems.map(item => {
            const Icon = item.icon;
            const isDisabled = (item.requiresData && !dataset) || (item.requiresAuth && !user);
            const isActive = activeModule === item.id;

            return (
              <button
                key={item.id}
                disabled={isDisabled}
                onClick={() => {
                  if (item.requiresAuth && !user) {
                    setShowAuthModal(true);
                    return;
                  }
                  setActiveModule(item.id);
                }}
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
                {isActive && (
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow shadow-cyan-400/50"></span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Saved Projects/Reports (View Previous Reports) */}
        {user && projects.length > 0 && (
          <div className="px-4 py-3 border-t border-gray-900 flex-1 flex flex-col min-h-0 bg-zinc-950/20">
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-2 shrink-0">Saved Reports</p>
            <div className="flex-1 overflow-y-auto space-y-1 pr-1">
              {projects.map((proj) => {
                const isActive = dataset?.projectId === proj.id;
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

        {/* User Profile / Auth Section */}
        <div className="p-4 border-t border-gray-900 bg-zinc-950/40 space-y-3">
          {user ? (
            <>
              <div className="flex items-center gap-2.5">
                {user.picture ? (
                  <img src={user.picture} alt={user.name} className="h-8 w-8 rounded-full border border-gray-700" />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center">
                    <UserIcon className="h-4 w-4 text-white" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-gray-200 truncate">{user.name}</p>
                  <p className="text-[10px] text-gray-500 truncate">{user.email}</p>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-gray-800 bg-zinc-900/40 text-gray-400 hover:text-red-400 hover:border-red-800/40 text-xs font-semibold transition"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign Out
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setShowAuthModal(true)}
                className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white text-xs font-bold hover:from-cyan-400 hover:to-emerald-400 transition shadow-lg shadow-cyan-500/10"
              >
                <LogIn className="h-3.5 w-3.5" />
                Sign In with Google
              </button>
              <p className="text-[9px] text-gray-600 text-center">Sign in to upload data &amp; save projects</p>
            </>
          )}

          {/* Connected file indicator */}
          {dataset && (
            <div className="pt-2 border-t border-gray-800/40">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wide">Connected File</p>
                  <p className="text-xs text-gray-300 font-semibold truncate max-w-[170px] mt-0.5" title={dataset.fileName}>
                    {dataset.fileName}
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
                Operations Log
              </p>
              <div className="max-h-[100px] overflow-y-auto space-y-1.5 pr-1 font-mono text-[9px] text-gray-400">
                {actionHistory.map((act, idx) => (
                  <div key={idx} className="flex gap-1.5 items-start">
                    <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0 mt-0.5" />
                    <span className="leading-snug">{act}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Pane */}
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto bg-gradient-to-b from-[#030712] via-[#090b16] to-[#04060d]">
        
        {/* Top Header */}
        <header className="h-16 border-b border-gray-900 px-8 flex items-center justify-between shrink-0 no-print bg-zinc-950/20">
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold px-2 py-1 rounded bg-zinc-900 text-gray-400 border border-gray-800">
              Environment: Browser
            </span>
            {user && (
              <span className="text-xs font-semibold px-2 py-1 rounded bg-emerald-950/30 text-emerald-400 border border-emerald-800/30 flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                Authenticated
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            {dataset && (
              <button
                onClick={saveProject}
                disabled={savingProject}
                className="px-3.5 py-1.5 rounded-lg border border-cyan-800 bg-cyan-950/40 text-cyan-400 hover:text-white hover:bg-cyan-900/60 hover:border-cyan-700 transition flex items-center gap-1.5 text-xs font-semibold"
                title="Save current dataset and state to cloud database"
              >
                {savingProject ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Database className="h-3.5 w-3.5" />
                )}
                {dataset.projectId ? "Saved to Cloud" : "Save Project"}
              </button>
            )}
            {!user && (
              <button
                onClick={() => setShowAuthModal(true)}
                className="px-3.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500/20 to-emerald-500/20 border border-cyan-800/30 text-cyan-400 hover:from-cyan-500/30 hover:to-emerald-500/30 transition flex items-center gap-1.5 text-xs font-semibold"
              >
                <LogIn className="h-3.5 w-3.5" />
                Sign Up / Log In
              </button>
            )}
          </div>
        </header>

        {/* Content Wrapper */}
        <div className="flex-1 p-8">
          
          {/* Upload module requires auth */}
          {activeModule === 'upload' && !user ? (
            <div className="glass-panel p-8 rounded-xl max-w-md mx-auto text-center space-y-5 py-16 animate-fade-in mt-12">
              <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-cyan-500/20 to-emerald-500/20 border border-cyan-800/30 flex items-center justify-center mx-auto">
                <LogIn className="h-8 w-8 text-cyan-400" />
              </div>
              <h3 className="text-lg font-bold text-white">Authentication Required</h3>
              <p className="text-xs text-gray-400 leading-relaxed max-w-[300px] mx-auto">
                Sign in with your Google account to upload datasets, save projects, and access all analytics features.
              </p>
              <button
                onClick={() => setShowAuthModal(true)}
                className="px-6 py-3 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 text-white font-bold text-sm hover:from-cyan-400 hover:to-emerald-400 transition shadow-xl shadow-cyan-500/15"
              >
                Sign In with Google
              </button>
            </div>
          ) : !dataset && activeModule !== 'upload' ? (
            <div className="glass-panel p-8 rounded-xl max-w-md mx-auto text-center space-y-4 py-16 animate-fade-in mt-12">
              <Database className="h-12 w-12 text-gray-600 mx-auto" />
              <h3 className="text-base font-bold text-white">No Dataset Active</h3>
              <p className="text-xs text-gray-400">
                You must import a CSV or Excel worksheet before you can perform analytics, clean operations, or design BI dashboards.
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
                  dataset={dataset} 
                />
              )}

              {dataset && activeModule === 'clean' && (
                <CleanModule 
                  dataset={dataset} 
                  onDatasetUpdated={handleDatasetUpdated}
                  onUndo={handleUndo}
                  canUndo={history.length > 0}
                />
              )}

              {dataset && activeModule === 'transform' && (
                <TransformModule 
                  dataset={dataset} 
                  onDatasetUpdated={handleDatasetUpdated}
                  onUndo={handleUndo}
                  canUndo={history.length > 0}
                />
              )}

              {dataset && activeModule === 'dashboard' && (
                <DashboardBuilder dataset={dataset} />
              )}

              {dataset && activeModule === 'insights' && (
                <AIInsights dataset={dataset} />
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

      {/* Auth Modal */}
      <AuthModal
        isOpen={showAuthModal}
        onClose={() => setShowAuthModal(false)}
        onAuthSuccess={handleAuthSuccess}
      />
    </div>
  );
}
