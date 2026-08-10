import React, { useRef, useState } from 'react';
import { Upload, FileSpreadsheet, FileText, Database, AlertCircle, RefreshCw, Plus, Layers, CheckCircle2 } from 'lucide-react';
import * as XLSX from 'xlsx';
import { Dataset, processDataset } from '../utils/parser';
import type { DataTableMeta } from '../utils/profiler';

interface UploadModuleProps {
  onDatasetLoaded: (dataset: Dataset, tableName?: string) => void;
  onAddTable?: (file: File, tableName: string) => Promise<void>;
  dataset: Dataset | null;
  tables?: DataTableMeta[];
  projectId?: number | string | null;
}

export default function UploadModule({
  onDatasetLoaded,
  onAddTable,
  dataset,
  tables = [],
  projectId,
}: UploadModuleProps) {
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customTableName, setCustomTableName] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Multi-sheet Excel modal state
  const [excelSheets, setExcelSheets] = useState<{ sheetName: string; rows: any[] }[] | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const processFile = async (file: File) => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension !== 'csv' && extension !== 'xlsx' && extension !== 'xls') {
      setError('Unsupported file format. Please upload a CSV or Excel (.xlsx/.xls) file.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (extension === 'xlsx' || extension === 'xls') {
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
        
        if (workbook.SheetNames.length > 1) {
          // Multi-sheet Excel detected!
          const sheetsData = workbook.SheetNames.map(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(worksheet) as Record<string, any>[];
            return { sheetName, rows };
          }).filter(s => s.rows.length > 0);

          if (sheetsData.length > 1) {
            setExcelSheets(sheetsData);
            setPendingFile(file);
            setLoading(false);
            return;
          }
        }
      }

      // Standard single CSV/Excel processing
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || errorData.detail || 'Upload failed');
      }

      const { data, filename } = await res.json();
      const defaultName = filename.split('.')[0];
      const nameToUse = customTableName.trim() || defaultName;

      const parsed = processDataset(data, filename, file.size);
      
      if (projectId && onAddTable) {
        await onAddTable(file, nameToUse);
      } else {
        onDatasetLoaded(parsed, nameToUse);
      }
      setCustomTableName('');
    } catch (err: any) {
      setError(err?.message || 'Failed to parse file.');
    } finally {
      setLoading(false);
    }
  };

  const handleImportSheet = async (sheetName: string, rows: any[]) => {
    if (!rows || rows.length === 0) return;
    setLoading(true);
    try {
      const fileName = `${pendingFile?.name.split('.')[0]}_${sheetName}`;
      const parsed = processDataset(rows, `${fileName}.csv`, 0);
      onDatasetLoaded(parsed, sheetName);
      setExcelSheets(null);
      setPendingFile(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to import sheet');
    } finally {
      setLoading(false);
    }
  };

  const processFiles = async (files: File[]) => {
    if (!files || files.length === 0) return;
    setLoading(true);
    setError(null);

    try {
      for (const file of files) {
        await processFile(file);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to process files.');
    } finally {
      setLoading(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await processFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(Array.from(e.target.files));
    }
  };

  const triggerInputClick = () => {
    fileInputRef.current?.click();
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white">Data Sources & Upload</h2>
          <p className="text-gray-400 text-xs mt-1">
            Upload single or multiple CSV/Excel spreadsheets to build your relational BI project.
          </p>
        </div>
      </div>

      {/* Table Name Customizer Input */}
      <div className="glass-panel p-4 rounded-xl border border-gray-800 flex items-center gap-3">
        <Layers className="h-4 w-4 text-cyan-400 shrink-0" />
        <div className="flex-1">
          <label className="text-[10px] font-bold text-gray-500 uppercase tracking-wider block">Target Table Name (Optional)</label>
          <input
            type="text"
            value={customTableName}
            onChange={e => setCustomTableName(e.target.value)}
            placeholder="e.g. Sales, Customers, Products (defaults to file name)"
            className="w-full bg-transparent text-xs text-gray-200 outline-none mt-0.5 border-b border-gray-800 focus:border-cyan-500 transition py-1"
          />
        </div>
      </div>

      {/* Uploader Box */}
      <div
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={triggerInputClick}
        className={`glass-panel border-dashed rounded-xl p-10 flex flex-col items-center justify-center cursor-pointer transition-all duration-300 text-center relative overflow-hidden group ${
          dragActive
            ? 'border-emerald-500 bg-emerald-950/20 scale-[0.99] shadow-lg shadow-emerald-500/10'
            : 'border-gray-800 hover:border-cyan-500/50 hover:bg-zinc-900/30'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          accept=".csv,.xlsx,.xls"
          onChange={handleChange}
          disabled={loading}
        />

        {loading ? (
          <div className="flex flex-col items-center py-6">
            <RefreshCw className="h-12 w-12 text-cyan-400 animate-spin" />
            <p className="text-cyan-400 font-semibold mt-4 text-xs">Processing data table...</p>
            <p className="text-[10px] text-gray-500 mt-1">Extracting headers, coercing types, and profiling statistics</p>
          </div>
        ) : (
          <div className="flex flex-col items-center py-4">
            <div className="h-14 w-14 rounded-full bg-zinc-900/80 flex items-center justify-center border border-gray-800 mb-3 group-hover:scale-110 group-hover:border-cyan-500/50 transition-all duration-300">
              <Upload className="h-6 w-6 text-gray-400 group-hover:text-cyan-400 transition-colors" />
            </div>
            <p className="text-sm font-semibold text-gray-200">
              {tables.length > 0 ? 'Upload Additional Table to Project' : 'Drag & drop your dataset file here, or browse'}
            </p>
            <p className="text-xs text-gray-500 mt-1.5">Supports CSV, XLS, and XLSX files</p>
          </div>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-400 text-xs">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {/* Multi-Sheet Excel Selector Modal */}
      {excelSheets && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="glass-panel p-6 rounded-xl max-w-lg w-full space-y-4 border border-gray-800">
            <div>
              <h3 className="text-base font-bold text-white">Multi-Sheet Excel File Detected</h3>
              <p className="text-xs text-gray-400 mt-0.5">Select a sheet to import into your project models.</p>
            </div>

            <div className="space-y-2 max-h-[250px] overflow-y-auto">
              {excelSheets.map(s => (
                <div
                  key={s.sheetName}
                  onClick={() => handleImportSheet(s.sheetName, s.rows)}
                  className="p-3 rounded-lg border border-gray-800 bg-zinc-900/40 hover:border-cyan-500/50 hover:bg-cyan-950/20 transition cursor-pointer flex items-center justify-between"
                >
                  <div>
                    <p className="text-xs font-bold text-white">{s.sheetName}</p>
                    <p className="text-[10px] text-gray-500">{s.rows.length.toLocaleString()} rows</p>
                  </div>
                  <Plus className="h-4 w-4 text-cyan-400" />
                </div>
              ))}
            </div>

            <button
              onClick={() => { setExcelSheets(null); setPendingFile(null); }}
              className="w-full py-2 rounded-lg bg-zinc-900 border border-gray-800 text-xs text-gray-400 hover:text-white transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Loaded Tables Inventory */}
      {tables.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            <Database className="h-4 w-4 text-emerald-400" />
            Project Data Tables ({tables.length})
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {tables.map(t => (
              <div key={t.id} className="glass-panel p-4 rounded-xl border border-gray-800 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-extrabold text-white truncate">{t.tableName}</span>
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                </div>
                <p className="text-[10px] text-gray-400 truncate">{t.fileName}</p>
                <div className="flex items-center gap-3 text-[10px] text-gray-500 pt-1 border-t border-gray-800/40">
                  <span>{t.rowCount.toLocaleString()} rows</span>
                  <span>{t.columnCount || t.headers?.length} cols</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
