import React, { useRef, useState } from 'react';
import { Upload, FileSpreadsheet, FileText, Database, AlertCircle, RefreshCw } from 'lucide-react';
import { Dataset, parseFile, processDataset } from '../utils/parser';

interface UploadModuleProps {
  onDatasetLoaded: (dataset: Dataset) => void;
  dataset: Dataset | null;
}

export default function UploadModule({ onDatasetLoaded, dataset }: UploadModuleProps) {
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null as string | null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const processFile = async (file: File) => {
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension !== 'csv' && extension !== 'xlsx' && extension !== 'xls') {
      setError("Unsupported file format. Please upload a CSV or Excel (.xlsx/.xls) file.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || errorData.detail || "Upload failed");
      }
      
      const { data, filename } = await res.json();
      const parsed = processDataset(data, filename, file.size);
      onDatasetLoaded(parsed);
    } catch (err: any) {
      setError(err?.message || "Failed to parse the file. Please ensure it is a valid CSV/Excel file.");
    } finally {
      setLoading(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      await processFile(e.dataTransfer.files[0]);
    }
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      await processFile(e.target.files[0]);
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

  // Count type distribution
  const getTypeCounts = () => {
    if (!dataset) return { number: 0, string: 0, date: 0, boolean: 0 };
    const counts = { number: 0, string: 0, date: 0, boolean: 0 };
    Object.values(dataset.types).forEach(type => {
      counts[type]++;
    });
    return counts;
  };

  const typeCounts = getTypeCounts();

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-white">Upload Dataset</h2>
          <p className="text-gray-400 text-sm mt-1">Import your CSV or Excel spreadsheets to start cleaning and building dashboards.</p>
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
          className="hidden" 
          accept=".csv,.xlsx,.xls"
          onChange={handleChange}
          disabled={loading}
        />

        {loading ? (
          <div className="flex flex-col items-center py-6">
            <RefreshCw className="h-12 w-12 text-cyan-400 animate-spin" />
            <p className="text-cyan-400 font-semibold mt-4">Parsing dataset structure...</p>
            <p className="text-xs text-gray-500 mt-2">Reading cell types and computing statistics</p>
          </div>
        ) : (
          <div className="flex flex-col items-center py-4">
            <div className="h-16 w-16 rounded-full bg-zinc-900/80 flex items-center justify-center border border-gray-800 mb-4 group-hover:scale-110 group-hover:border-cyan-500/50 transition-all duration-300">
              <Upload className="h-7 w-7 text-gray-400 group-hover:text-cyan-400 transition-colors" />
            </div>
            <p className="text-base font-semibold text-gray-200">
              Drag & drop your file here, or <span className="text-cyan-400 group-hover:underline">browse</span>
            </p>
            <p className="text-xs text-gray-500 mt-2">Supports CSV, XLS, and XLSX (max 20MB)</p>
          </div>
        )}
      </div>

      {/* Error display */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-red-950/20 border border-red-900/50 text-red-400 text-sm">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {/* Dataset Metadata Summary */}
      {dataset && !loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="glass-panel p-4 rounded-xl flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg bg-cyan-950/40 border border-cyan-800/30 flex items-center justify-center">
                <FileSpreadsheet className="h-5 w-5 text-cyan-400" />
              </div>
              <div>
                <p className="text-xs text-gray-500">File Details</p>
                <p className="text-sm font-semibold text-white truncate max-w-[150px]">{dataset.fileName}</p>
                <p className="text-xs text-gray-400">{formatBytes(dataset.fileSize)}</p>
              </div>
            </div>

            <div className="glass-panel p-4 rounded-xl flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg bg-emerald-950/40 border border-emerald-800/30 flex items-center justify-center">
                <Database className="h-5 w-5 text-emerald-400" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Data Grid</p>
                <p className="text-sm font-semibold text-white">{dataset.rows.length.toLocaleString()} Rows</p>
                <p className="text-xs text-gray-400">{dataset.headers.length} Columns</p>
              </div>
            </div>

            <div className="glass-panel p-4 rounded-xl flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg bg-violet-950/40 border border-violet-800/30 flex items-center justify-center">
                <FileText className="h-5 w-5 text-violet-400" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Feature Count</p>
                <p className="text-sm font-semibold text-white">{typeCounts.number} Numeric, {typeCounts.string} Text</p>
                <p className="text-xs text-gray-400">{typeCounts.date} Dates, {typeCounts.boolean} Booleans</p>
              </div>
            </div>

            <div className="glass-panel p-4 rounded-xl flex items-center gap-4">
              <div className="h-10 w-10 rounded-lg bg-amber-950/40 border border-amber-800/30 flex items-center justify-center">
                <AlertCircle className="h-5 w-5 text-amber-400" />
              </div>
              <div>
                <p className="text-xs text-gray-500">Data Quality</p>
                <p className="text-sm font-semibold text-white">
                  {Object.values(dataset.nullCounts).reduce((a, b) => a + b, 0).toLocaleString()} Missing
                </p>
                <p className="text-xs text-gray-400">Values across all fields</p>
              </div>
            </div>
          </div>

          {/* Data Preview Table */}
          <div className="glass-panel rounded-xl overflow-hidden border border-gray-800">
            <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">Dataset Preview (First 10 Rows)</h3>
              <span className="text-xs text-gray-500">Scroll horizontally to see all columns</span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="border-b border-gray-800 bg-zinc-900/40">
                    <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16 text-center">#</th>
                    {dataset.headers.map(header => {
                      const type = dataset.types[header];
                      const nullCount = dataset.nullCounts[header];
                      
                      let badgeColor = "bg-gray-800 text-gray-400";
                      if (type === "number") badgeColor = "bg-emerald-950/60 text-emerald-400 border border-emerald-900/30";
                      if (type === "date") badgeColor = "bg-cyan-950/60 text-cyan-400 border border-cyan-900/30";
                      if (type === "boolean") badgeColor = "bg-violet-950/60 text-violet-400 border border-violet-900/30";
                      
                      return (
                        <th key={header} className="px-4 py-3 min-w-[150px] border-r border-gray-800/30">
                          <div className="flex flex-col gap-1">
                            <span className="font-semibold text-gray-200 truncate">{header}</span>
                            <div className="flex items-center gap-1.5 mt-0.5">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${badgeColor}`}>
                                {type}
                              </span>
                              {nullCount > 0 && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-500 border border-amber-900/30">
                                  {nullCount} null
                                </span>
                              )}
                            </div>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {dataset.rows.slice(0, 10).map((row, idx) => (
                    <tr key={idx} className="hover:bg-zinc-900/20 transition-colors">
                      <td className="px-4 py-2.5 text-center text-gray-500 font-mono border-r border-gray-800 bg-zinc-900/10">
                        {idx + 1}
                      </td>
                      {dataset.headers.map(header => {
                        const val = row[header];
                        let renderedVal = "";
                        let isNull = false;
                        
                        if (val === null || val === undefined) {
                          renderedVal = "NULL";
                          isNull = true;
                        } else if (val instanceof Date) {
                          renderedVal = val.toLocaleDateString();
                        } else if (typeof val === 'boolean') {
                          renderedVal = val ? "true" : "false";
                        } else {
                          renderedVal = String(val);
                        }

                        return (
                          <th 
                            key={header} 
                            className={`px-4 py-2.5 font-normal border-r border-gray-800/30 truncate max-w-[200px] ${
                              isNull ? 'text-amber-500/70 italic font-mono text-xs' : 'text-gray-300'
                            }`}
                          >
                            {renderedVal}
                          </th>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
