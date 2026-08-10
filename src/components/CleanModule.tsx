import React, { useState, useEffect } from 'react';
import { ShieldCheck, AlertCircle, RefreshCw, Check, Trash2, Edit2, RotateCcw, AlertTriangle, Zap, ChevronDown, ChevronUp } from 'lucide-react';
import { Dataset } from '../utils/parser';
import { removeDuplicates, handleNulls, formatDates, standardizeText, correctCasing } from '../utils/cleaner';
import type { QualitySuggestion } from '../utils/profiler';

interface CleanModuleProps {
  dataset: Dataset;
  onDatasetUpdated: (newDataset: Dataset, actionDesc: string) => void;
  onUndo?: () => void;
  canUndo?: boolean;
  qualitySuggestions?: QualitySuggestion[];
  onApplySuggestion?: (suggestion: QualitySuggestion) => void;
}

interface ColumnCleaningConfig {
  nullStrategy: 'none' | 'drop' | 'mean' | 'median' | 'mode' | 'custom' | 'fwd' | 'bwd';
  customNullVal: string;
  dateFormat: 'none' | 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'DD-MM-YYYY' | 'YYYY-MM-DD HH:mm:ss';
  casing: 'none' | 'lower' | 'upper' | 'title';
  trim: boolean;
  removeExtraSpaces: boolean;
  removeSpecialChars: boolean;
  validateEmail: boolean;
  validatePhone: boolean;
}

export default function CleanModule({ dataset, onDatasetUpdated, onUndo, canUndo, qualitySuggestions = [], onApplySuggestion }: CleanModuleProps) {
  const { headers, rows, types, stats } = dataset;
  const [showIssuesPanel, setShowIssuesPanel] = useState(true);
  
  // Clean configuration states
  const [dedupeAll, setDedupeAll] = useState(false);
  const [fuzzyDedup, setFuzzyDedup] = useState(false);
  const [dedupeCols, setDedupeCols] = useState<string[]>([]);
  
  // Column specific options
  const [columnConfigs, setColumnConfigs] = useState<Record<string, ColumnCleaningConfig>>(() => {
    const init: Record<string, any> = {};
    headers.forEach(h => {
      init[h] = {
        nullStrategy: 'none',
        customNullVal: '',
        dateFormat: 'none',
        casing: 'none',
        trim: false,
        removeExtraSpaces: false,
        removeSpecialChars: false,
        validateEmail: false,
        validatePhone: false
      };
    });
    return init;
  });

  const [activeTabCol, setActiveTabCol] = useState(headers[0] || '');
  const [previewRows, setPreviewRows] = useState<Record<string, any>[]>([]);
  const [rowStatus, setRowStatus] = useState<Record<number, 'kept' | 'deleted'>>({});
  const [cellChanges, setCellChanges] = useState<Record<string, boolean>>({}); // "rowIdx-header" -> changed
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    if (headers.length > 0 && !headers.includes(activeTabCol)) {
      setActiveTabCol(headers[0]);
    }
  }, [headers, activeTabCol]);

  const buildBackendConfig = () => {
    const config: Record<string, any> = {};
    if (dedupeAll) config.remove_duplicates = true;
    if (fuzzyDedup) config.fuzzy_dedup = true;
    
    const missing_values: any[] = [];
    const trim_whitespace: string[] = [];
    const standardize_case: any[] = [];
    const remove_special_characters: string[] = [];
    const fix_dates: string[] = [];
    const validate_email: string[] = [];
    const validate_phone: string[] = [];
    
    headers.forEach(col => {
      const c = columnConfigs[col];
      if (!c) return;
      
      if (c.nullStrategy !== 'none') {
        missing_values.push({
          strategy: c.nullStrategy === 'mean' ? 'fill_mean' : c.nullStrategy === 'median' ? 'fill_median' : c.nullStrategy === 'mode' ? 'fill_mode' : c.nullStrategy === 'custom' ? 'fill_custom' : c.nullStrategy === 'fwd' ? 'forward_fill' : c.nullStrategy === 'bwd' ? 'backward_fill' : 'drop',
          columns: [col],
          fill_value: c.customNullVal
        });
      }
      
      if (c.trim || c.removeExtraSpaces) trim_whitespace.push(col);
      if (c.removeSpecialChars) remove_special_characters.push(col);
      
      if (c.casing !== 'none') {
        standardize_case.push({ format: c.casing, columns: [col] });
      }
      
      if (c.dateFormat !== 'none') fix_dates.push(col);
      if (c.validateEmail) validate_email.push(col);
      if (c.validatePhone) validate_phone.push(col);
    });
    
    if (missing_values.length > 0) config.missing_values = missing_values;
    if (trim_whitespace.length > 0) config.trim_whitespace = trim_whitespace;
    if (standardize_case.length > 0) config.standardize_case = standardize_case;
    if (remove_special_characters.length > 0) config.remove_special_characters = remove_special_characters;
    if (fix_dates.length > 0) config.fix_dates = fix_dates;
    if (validate_email.length > 0) config.validate_email = validate_email;
    if (validate_phone.length > 0) config.validate_phone = validate_phone;
    
    return config;
  };

  useEffect(() => {
    const fetchPreview = async () => {
      const sampleRows = rows.slice(0, 15);
      const config = buildBackendConfig();
      
      if (Object.keys(config).length === 0) {
        setPreviewRows(sampleRows);
        setRowStatus({});
        setCellChanges({});
        return;
      }
      
      try {
        const res = await fetch('/api/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: sampleRows, config })
        });
        
        if (res.ok) {
          const { data } = await res.json();
          // compute diffs
          const tempCellChanges: Record<string, boolean> = {};
          const tempRowStatus: Record<number, 'kept' | 'deleted'> = {};
          
          sampleRows.forEach((r, idx) => {
             // In reality dedupe might drop rows, so data might be shorter or missing indices.
             // We'll just map roughly.
             if (idx >= data.length && dedupeAll) {
                 tempRowStatus[idx] = 'deleted';
             } else {
                 const newRow = data[idx] || data[data.length - 1]; // fallback
                 headers.forEach(h => {
                    if (String(r[h]) !== String(newRow[h])) {
                       tempCellChanges[`${idx}-${h}`] = true;
                    }
                 });
             }
          });
          setPreviewRows(data);
          setCellChanges(tempCellChanges);
          setRowStatus(tempRowStatus);
        }
      } catch (err) {
        console.error(err);
      }
    };
    
    fetchPreview();
  }, [columnConfigs, dedupeAll, fuzzyDedup, dedupeCols, rows, headers]);

  const handleConfigChange = (col: string, key: string, value: any) => {
    setColumnConfigs(prev => ({
      ...prev,
      [col]: {
        ...prev[col],
        [key]: value
      }
    }));
  };

  const handleApply = async () => {
    const config = buildBackendConfig();
    if (Object.keys(config).length === 0) return;
    
    setIsApplying(true);
    try {
      const res = await fetch('/api/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: rows, config })
      });
      
      if (res.ok) {
        const { data } = await res.json();
        
        // Recompute stats and nulls using processDataset from parser if possible, or manually.
        // For simplicity, we just pass the new rows to the parent. The parent can re-run processDataset if needed, but we'll approximate here.
        const newNullCounts: Record<string, number> = {};
        headers.forEach(h => {
           newNullCounts[h] = data.filter((r: any) => r[h] === null || r[h] === undefined).length;
        });
        
        onDatasetUpdated({
          ...dataset,
          rows: data,
          nullCounts: newNullCounts,
          // keeping existing stats for simplicity since recalculation is complex without parser
        }, "Applied data cleaning via backend");
        
        // reset configs
        setDedupeAll(false);
        setFuzzyDedup(false);
        const resetConfigs: Record<string, any> = {};
        headers.forEach(h => {
          resetConfigs[h] = {
            nullStrategy: 'none',
            customNullVal: '',
            dateFormat: 'none',
            casing: 'none',
            trim: false,
            removeExtraSpaces: false,
            removeSpecialChars: false,
            validateEmail: false,
            validatePhone: false
          };
        });
        setColumnConfigs(resetConfigs);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsApplying(false);
    }
  };

  const toggleDedupeCol = (col: string) => {
    setDedupeCols(prev => 
      prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
    );
  };

  const activeConfig = columnConfigs[activeTabCol];

  const SEVERITY_STYLES: Record<string, string> = {
    high:   'border-red-900/40 bg-red-950/20',
    medium: 'border-amber-900/40 bg-amber-950/20',
    low:    'border-gray-800/40 bg-zinc-900/20',
  };

  const SEVERITY_TEXT: Record<string, string> = {
    high:   'text-red-400',
    medium: 'text-amber-400',
    low:    'text-gray-400',
  };

  const TIER_INFO: Record<string, { label: string; color: string }> = {
    A: { label: 'Safe to auto-apply', color: 'text-emerald-400' },
    B: { label: 'Recommended', color: 'text-cyan-400' },
    C: { label: 'Needs review', color: 'text-amber-400' },
  };

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ═══════ Detected Issues Panel ═══════ */}
      {qualitySuggestions.length > 0 && (
        <div className="glass-panel rounded-xl border border-gray-800/40 overflow-hidden">
          <button
            onClick={() => setShowIssuesPanel(!showIssuesPanel)}
            className="w-full px-5 py-4 flex items-center justify-between hover:bg-zinc-900/20 transition"
          >
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-amber-950/40 border border-amber-800/30 flex items-center justify-center">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
              </div>
              <div className="text-left">
                <h3 className="text-sm font-bold text-white">Detected Issues</h3>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  {qualitySuggestions.length} quality issue{qualitySuggestions.length !== 1 ? 's' : ''} found — review or apply recommended fixes
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-amber-400 bg-amber-950/30 px-2 py-0.5 rounded border border-amber-900/30">
                {qualitySuggestions.length}
              </span>
              {showIssuesPanel ? <ChevronUp className="h-4 w-4 text-gray-500" /> : <ChevronDown className="h-4 w-4 text-gray-500" />}
            </div>
          </button>

          {showIssuesPanel && (
            <div className="px-5 pb-4 space-y-2 border-t border-gray-800/40 pt-3">
              {qualitySuggestions.map(issue => {
                const tier = TIER_INFO[issue.risk_tier] || TIER_INFO.B;
                return (
                  <div
                    key={issue.id}
                    className={`p-3.5 rounded-lg border ${SEVERITY_STYLES[issue.severity]} flex items-start justify-between gap-4 group transition hover:border-gray-700/60`}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className={`text-[9px] font-bold uppercase tracking-wider ${SEVERITY_TEXT[issue.severity]}`}>
                          {issue.severity}
                        </span>
                        {issue.column && (
                          <span className="text-[9px] font-mono text-gray-500 bg-zinc-900/60 px-1.5 py-0.5 rounded">
                            {issue.column}
                          </span>
                        )}
                        <span className={`text-[8px] font-bold ${tier.color}`}>
                          Tier {issue.risk_tier}
                        </span>
                      </div>
                      <p className="text-[11px] font-medium text-gray-200 leading-snug">{issue.description}</p>
                      <p className="text-[10px] text-gray-500">{issue.why}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {onApplySuggestion && (
                        <button
                          onClick={() => onApplySuggestion(issue)}
                          className="px-3 py-1.5 rounded-lg text-[10px] font-semibold bg-emerald-950/40 text-emerald-400 border border-emerald-800/30 hover:bg-emerald-900/40 hover:text-emerald-300 transition opacity-70 group-hover:opacity-100"
                        >
                          Apply Fix
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═══════ Manual Cleaning Controls ═══════ */}
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      {/* Cleaning Config Sidebar */}
      <div className="xl:col-span-1 space-y-6">
        <div className="glass-panel p-5 rounded-xl space-y-5">
          <div className="flex items-center justify-between border-b border-gray-800 pb-3">
            <h3 className="text-base font-semibold text-white flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
              Deduplication
            </h3>
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-400 flex items-center gap-1.5 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={fuzzyDedup}
                  onChange={(e) => setFuzzyDedup(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-emerald-500"
                />
                Fuzzy
              </label>
              <input 
                type="checkbox" 
                id="dedupe-all"
                checked={dedupeAll}
                onChange={(e) => setDedupeAll(e.target.checked)}
                className="h-4.5 w-4.5 rounded border-gray-800 bg-zinc-950 text-cyan-500 focus:ring-cyan-500/20"
              />
            </div>
          </div>

          {dedupeAll && (
            <div className="space-y-3 animate-fade-in">
              <p className="text-xs text-gray-400">Select columns to determine duplicate uniqueness. Leave all unchecked to evaluate full rows.</p>
              <div className="max-h-[150px] overflow-y-auto border border-gray-800 rounded-lg p-2 bg-zinc-950/30 space-y-2">
                {headers.map(col => (
                  <label key={col} className="flex items-center gap-2.5 px-2 py-1 hover:bg-zinc-900/40 rounded cursor-pointer text-xs">
                    <input 
                      type="checkbox"
                      checked={dedupeCols.includes(col)}
                      onChange={() => toggleDedupeCol(col)}
                      className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-cyan-500"
                    />
                    <span className="text-gray-300 truncate">{col}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Column Specific Options */}
        <div className="glass-panel p-5 rounded-xl space-y-5">
          <div className="border-b border-gray-800 pb-3 flex items-center justify-between">
            <h3 className="text-base font-semibold text-white flex items-center gap-2">
              <Edit2 className="h-5 w-5 text-cyan-400" />
              Column Cleaning
            </h3>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-gray-400 mb-1.5">Select Target Column</label>
              <select
                value={activeTabCol}
                onChange={(e) => setActiveTabCol(e.target.value)}
                className="w-full glass-input text-xs"
              >
                {headers.map(col => (
                  <option key={col} value={col} className="bg-zinc-950 text-white">
                    {col} ({types[col]})
                  </option>
                ))}
              </select>
            </div>

            {activeConfig && (
              <div className="space-y-4 pt-2 border-t border-gray-800/50">
                {/* Null Values Handling */}
                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-gray-400">Null Value Treatment</label>
                  <select
                    value={activeConfig.nullStrategy}
                    onChange={(e) => handleConfigChange(activeTabCol, 'nullStrategy', e.target.value)}
                    className="w-full glass-input text-xs"
                  >
                    <option value="none" className="bg-zinc-950">Ignore Null Values</option>
                    <option value="drop" className="bg-zinc-950">Drop rows containing nulls</option>
                    {types[activeTabCol] === 'number' && <option value="mean" className="bg-zinc-950">Impute with Mean (Average)</option>}
                    {types[activeTabCol] === 'number' && <option value="median" className="bg-zinc-950">Impute with Median</option>}
                    <option value="mode" className="bg-zinc-950">Impute with Mode (Most common)</option>
                    <option value="fwd" className="bg-zinc-950">Forward Fill</option>
                    <option value="bwd" className="bg-zinc-950">Backward Fill</option>
                    <option value="custom" className="bg-zinc-950">Impute with Custom Value</option>
                  </select>
                  
                  {activeConfig.nullStrategy === 'custom' && (
                    <input 
                      type="text"
                      placeholder="Enter custom replacement"
                      value={activeConfig.customNullVal}
                      onChange={(e) => handleConfigChange(activeTabCol, 'customNullVal', e.target.value)}
                      className="w-full glass-input text-xs mt-1.5"
                    />
                  )}
                </div>

                {/* Date Formats (only if date or string) */}
                {(types[activeTabCol] === 'date' || types[activeTabCol] === 'string') && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-gray-400">Date Standardization</label>
                    <select
                      value={activeConfig.dateFormat}
                      onChange={(e) => handleConfigChange(activeTabCol, 'dateFormat', e.target.value)}
                      className="w-full glass-input text-xs"
                    >
                      <option value="none" className="bg-zinc-950">Keep Original Format</option>
                      <option value="YYYY-MM-DD" className="bg-zinc-950">YYYY-MM-DD (e.g. 2026-06-15)</option>
                      <option value="MM/DD/YYYY" className="bg-zinc-950">MM/DD/YYYY (e.g. 06/15/2026)</option>
                      <option value="DD-MM-YYYY" className="bg-zinc-950">DD-MM-YYYY (e.g. 15-06-2026)</option>
                      <option value="YYYY-MM-DD HH:mm:ss" className="bg-zinc-950">YYYY-MM-DD HH:mm:ss</option>
                    </select>
                  </div>
                )}

                {/* Text standardization */}
                {types[activeTabCol] === 'string' && (
                  <div className="space-y-2">
                    <label className="block text-xs font-semibold text-gray-400">Text Sanitization & Validation</label>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeConfig.trim}
                          onChange={(e) => handleConfigChange(activeTabCol, 'trim', e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-cyan-500"
                        />
                        Trim leading/trailing whitespace
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeConfig.removeExtraSpaces}
                          onChange={(e) => handleConfigChange(activeTabCol, 'removeExtraSpaces', e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-cyan-500"
                        />
                        Merge multiple inner spaces
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeConfig.removeSpecialChars}
                          onChange={(e) => handleConfigChange(activeTabCol, 'removeSpecialChars', e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-cyan-500"
                        />
                        Remove special characters
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeConfig.validateEmail}
                          onChange={(e) => handleConfigChange(activeTabCol, 'validateEmail', e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-cyan-500"
                        />
                        Validate Email Addresses
                      </label>
                      <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={activeConfig.validatePhone}
                          onChange={(e) => handleConfigChange(activeTabCol, 'validatePhone', e.target.checked)}
                          className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-cyan-500"
                        />
                        Standardize Phone Numbers
                      </label>
                    </div>
                  </div>
                )}

                {/* Casing correction */}
                {types[activeTabCol] === 'string' && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-semibold text-gray-400">Capitalization Correction</label>
                    <select
                      value={activeConfig.casing}
                      onChange={(e) => handleConfigChange(activeTabCol, 'casing', e.target.value)}
                      className="w-full glass-input text-xs"
                    >
                      <option value="none" className="bg-zinc-950">Original Casing</option>
                      <option value="lower" className="bg-zinc-950">lowercase (e.g. cleanlytics)</option>
                      <option value="upper" className="bg-zinc-950">UPPERCASE (e.g. CLEANLYTICS)</option>
                      <option value="title" className="bg-zinc-950">Title Case (e.g. Cleanlytics)</option>
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3">
          {canUndo && onUndo && (
            <button
              onClick={onUndo}
              className="flex-1 px-4 py-2.5 rounded-lg border border-gray-800 bg-zinc-950/40 text-gray-300 hover:text-white hover:bg-zinc-900/60 hover:border-gray-700 transition flex items-center justify-center gap-2 text-sm"
            >
              <RotateCcw className="h-4 w-4" />
              Undo Last
            </button>
          )}
          <button
            onClick={handleApply}
            className="flex-[2] px-4 py-2.5 rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 text-white font-semibold hover:from-emerald-400 hover:to-cyan-400 shadow-md shadow-emerald-500/10 hover:shadow-cyan-500/20 hover:scale-[1.01] transition duration-200 flex items-center justify-center gap-2 text-sm"
          >
            <Check className="h-4 w-4" />
            Apply Cleaning
          </button>
        </div>
      </div>

      {/* Before / After Preview Grid */}
      <div className="xl:col-span-2 space-y-4">
        <div className="glass-panel rounded-xl overflow-hidden border border-gray-800 flex flex-col h-full">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-white">Before / After Diff Preview</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">
                Shows the first 15 records. Cells highlighted in <span className="text-emerald-400 font-semibold">green</span> will change. Rows marked <span className="text-red-500 font-semibold line-through">red</span> will be removed.
              </p>
            </div>
            <span className="text-[11px] text-gray-500 flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin text-cyan-400" /> Auto-updating
            </span>
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-800 bg-zinc-900/40">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16 text-center">Row</th>
                  {headers.map(header => (
                    <th key={header} className="px-4 py-3 min-w-[150px] border-r border-gray-800/30 text-gray-200 font-semibold">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {previewRows.map((row, idx) => {
                  const status = rowStatus[idx];
                  const isDeleted = status === 'deleted';
                  
                  return (
                    <tr 
                      key={idx} 
                      className={`transition-colors ${
                        isDeleted 
                          ? 'bg-red-950/20 hover:bg-red-950/30' 
                          : 'hover:bg-zinc-900/20'
                      }`}
                    >
                      <td className={`px-4 py-2.5 text-center font-mono border-r border-gray-800 bg-zinc-900/10 ${
                        isDeleted ? 'text-red-400 line-through' : 'text-gray-500'
                      }`}>
                        {idx + 1}
                      </td>
                      {headers.map(header => {
                        const originalVal = rows[idx][header];
                        const val = row[header];
                        const isChanged = cellChanges[`${idx}-${header}`];
                        
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

                        // Determine cell style
                        let cellStyle = "text-gray-300";
                        if (isDeleted) {
                          cellStyle = "text-red-500/70 line-through";
                        } else if (isChanged) {
                          cellStyle = "text-emerald-400 bg-emerald-950/30 font-medium px-2 py-0.5 rounded border border-emerald-900/40";
                        } else if (isNull) {
                          cellStyle = "text-amber-500/70 italic font-mono text-xs";
                        }

                        let titleTooltip = "";
                        if (isChanged) {
                          const origRendered = originalVal === null || originalVal === undefined ? "NULL" : String(originalVal);
                          titleTooltip = `Before: ${origRendered}\nAfter: ${renderedVal}`;
                        }

                        return (
                          <th 
                            key={header} 
                            title={titleTooltip}
                            className="px-4 py-2.5 font-normal border-r border-gray-800/30 truncate max-w-[200px]"
                          >
                            <span className={cellStyle}>{renderedVal}</span>
                          </th>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
}
