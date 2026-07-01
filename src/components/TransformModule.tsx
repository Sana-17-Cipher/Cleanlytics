import React, { useState, useEffect } from 'react';
import { Merge, Columns, Sigma, Plus, Trash2, Check, RotateCcw, AlertTriangle } from 'lucide-react';
import { Dataset } from '../utils/parser';
import { mergeColumns, splitColumn, groupByAggregate, addCalculatedColumn, AggregationConfig } from '../utils/transformer';

interface TransformModuleProps {
  dataset: Dataset;
  onDatasetUpdated: (newDataset: Dataset, actionDesc: string) => void;
  onUndo?: () => void;
  canUndo?: boolean;
}

type TransformType = 'merge' | 'split' | 'math' | 'groupby';

export default function TransformModule({ dataset, onDatasetUpdated, onUndo, canUndo }: TransformModuleProps) {
  const { headers, rows, types } = dataset;
  
  const [activeTab, setActiveTab] = useState<TransformType>('merge');
  const [previewRows, setPreviewRows] = useState<Record<string, any>[]>([]);
  const [previewHeaders, setPreviewHeaders] = useState<string[]>([]);
  const [previewTypes, setPreviewTypes] = useState<Record<string, string>>({});
  
  // 1. Merge State
  const [mergeSrcCols, setMergeSrcCols] = useState<string[]>([]);
  const [mergeTargetCol, setMergeTargetCol] = useState('');
  const [mergeDelimiter, setMergeDelimiter] = useState(' ');

  // 2. Split State
  const [splitSrcCol, setSplitSrcCol] = useState(headers[0] || '');
  const [splitDelimiter, setSplitDelimiter] = useState(',');
  const [splitTargets, setSplitTargets] = useState<string[]>(['', '']);

  // 3. Math Column State
  const [mathColA, setMathColA] = useState('');
  const [mathColB, setMathColB] = useState('');
  const [mathOp, setMathOp] = useState<'+' | '-' | '*' | '/' | 'concat'>('+');
  const [mathTargetCol, setMathTargetCol] = useState('');

  // 4. Group By State
  const [groupKeys, setGroupKeys] = useState<string[]>([]);
  const [aggregates, setAggregates] = useState<AggregationConfig[]>([
    { column: '', func: 'sum', outputName: '' }
  ]);

  // Sync state if headers change
  useEffect(() => {
    if (headers.length > 0) {
      if (!headers.includes(splitSrcCol)) setSplitSrcCol(headers[0]);
      
      const numCols = headers.filter(h => types[h] === 'number');
      if (numCols.length > 0) {
        if (!numCols.includes(mathColA)) setMathColA(numCols[0]);
        if (!numCols.includes(mathColB)) setMathColB(numCols[0]);
      } else {
        if (!headers.includes(mathColA)) setMathColA(headers[0]);
        if (!headers.includes(mathColB)) setMathColB(headers[0]);
      }
    }
  }, [headers, types, splitSrcCol, mathColA, mathColB]);

  // Compute transform preview for the first 10 rows
  useEffect(() => {
    const sampleRows = rows.slice(0, 10).map(r => ({ ...r }));
    let resultRows: Record<string, any>[] = [];
    let resultHeaders: string[] = [];
    let resultTypes: Record<string, string> = { ...types };

    try {
      if (activeTab === 'merge') {
        if (mergeSrcCols.length > 0 && mergeTargetCol.trim()) {
          resultRows = mergeColumns(sampleRows, mergeSrcCols, mergeTargetCol.trim(), mergeDelimiter);
          resultHeaders = [...headers, mergeTargetCol.trim()];
          resultTypes[mergeTargetCol.trim()] = 'string';
        } else {
          resultRows = sampleRows;
          resultHeaders = headers;
        }
      } 
      else if (activeTab === 'split') {
        if (splitSrcCol && splitDelimiter && splitTargets.some(t => t.trim())) {
          const { rows: processed, newHeaders } = splitColumn(sampleRows, splitSrcCol, splitDelimiter, splitTargets);
          resultRows = processed;
          resultHeaders = [...headers, ...newHeaders];
          newHeaders.forEach(nh => {
            resultTypes[nh] = 'string'; // Split results are generally strings
          });
        } else {
          resultRows = sampleRows;
          resultHeaders = headers;
        }
      } 
      else if (activeTab === 'math') {
        if (mathColA && mathColB && mathTargetCol.trim()) {
          resultRows = addCalculatedColumn(sampleRows, mathColA, mathColB, mathOp, mathTargetCol.trim());
          resultHeaders = [...headers, mathTargetCol.trim()];
          resultTypes[mathTargetCol.trim()] = mathOp === 'concat' ? 'string' : 'number';
        } else {
          resultRows = sampleRows;
          resultHeaders = headers;
        }
      } 
      else if (activeTab === 'groupby') {
        const validAggs = aggregates.filter(a => a.column && a.outputName.trim());
        if (groupKeys.length > 0 && validAggs.length > 0) {
          const { rows: processed, headers: groupedHeaders } = groupByAggregate(sampleRows, groupKeys, validAggs);
          resultRows = processed;
          resultHeaders = groupedHeaders;
          
          // Determine types for grouped result
          resultTypes = {};
          groupKeys.forEach(gk => {
            resultTypes[gk] = types[gk];
          });
          validAggs.forEach(agg => {
            resultTypes[agg.outputName] = agg.func === 'count' ? 'number' : types[agg.column];
          });
        } else {
          resultRows = sampleRows;
          resultHeaders = headers;
        }
      }
    } catch {
      resultRows = sampleRows;
      resultHeaders = headers;
    }

    setPreviewRows(resultRows);
    setPreviewHeaders(resultHeaders);
    setPreviewTypes(resultTypes);
  }, [activeTab, mergeSrcCols, mergeTargetCol, mergeDelimiter, splitSrcCol, splitDelimiter, splitTargets, mathColA, mathColB, mathOp, mathTargetCol, groupKeys, aggregates, rows, headers, types]);

  const toggleMergeSrcCol = (col: string) => {
    setMergeSrcCols(prev => 
      prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
    );
  };

  const handleSplitTargetChange = (idx: number, val: string) => {
    setSplitTargets(prev => {
      const copy = [...prev];
      copy[idx] = val;
      return copy;
    });
  };

  const addSplitField = () => {
    setSplitTargets(prev => [...prev, '']);
  };

  const removeSplitField = (idx: number) => {
    if (splitTargets.length <= 2) return;
    setSplitTargets(prev => prev.filter((_, i) => i !== idx));
  };

  const toggleGroupKey = (col: string) => {
    setGroupKeys(prev => 
      prev.includes(col) ? prev.filter(c => c !== col) : [...prev, col]
    );
  };

  const handleAggChange = (idx: number, field: keyof AggregationConfig, val: any) => {
    setAggregates(prev => {
      const copy = [...prev];
      copy[idx] = {
        ...copy[idx],
        [field]: val
      };
      
      // Auto fill output name if empty or default
      if (field === 'column' || field === 'func') {
        const col = field === 'column' ? val : copy[idx].column;
        const func = field === 'func' ? val : copy[idx].func;
        if (col) {
          copy[idx].outputName = `${func.toUpperCase()}_of_${col}`;
        }
      }
      
      return copy;
    });
  };

  const addAggregate = () => {
    setAggregates(prev => [...prev, { column: '', func: 'sum', outputName: '' }]);
  };

  const removeAggregate = (idx: number) => {
    if (aggregates.length <= 1) return;
    setAggregates(prev => prev.filter((_, i) => i !== idx));
  };

  const [isApplying, setIsApplying] = useState(false);

  const handleApplyTransform = async () => {
    let config: any = {};
    let desc = "";

    if (activeTab === 'merge') {
      if (mergeSrcCols.length === 0 || !mergeTargetCol.trim()) return;
      config = {
        merge_columns: {
          columns: mergeSrcCols,
          target: mergeTargetCol.trim(),
          separator: mergeDelimiter
        }
      };
      desc = `Merged columns [${mergeSrcCols.join(', ')}] into [${mergeTargetCol.trim()}]`;
    } 
    else if (activeTab === 'split') {
      if (!splitSrcCol || !splitDelimiter || !splitTargets.some(t => t.trim())) return;
      config = {
        split_column: {
          column: splitSrcCol,
          separator: splitDelimiter,
          targets: splitTargets.filter(t => t.trim())
        }
      };
      desc = `Split column [${splitSrcCol}]`;
    } 
    else if (activeTab === 'math') {
      if (!mathColA || !mathColB || !mathTargetCol.trim()) return;
      config = {
        math_operation: {
          column_a: mathColA,
          column_b: mathColB,
          operation: mathOp,
          target: mathTargetCol.trim()
        }
      };
      desc = `Calculated [${mathTargetCol.trim()}] = [${mathColA}] ${mathOp} [${mathColB}]`;
    } 
    else if (activeTab === 'groupby') {
      const validAggs = aggregates.filter(a => a.column && a.outputName.trim());
      if (groupKeys.length === 0 || validAggs.length === 0) return;
      
      const aggsDict: Record<string, any> = {};
      validAggs.forEach(a => {
        // We will pass the aggregation as a list of tuples or dict mapping
        // In backend pandas, agg accepts dict: {col: [func1, func2]}
        // Or NamedAgg. We will map to dict here and let backend handle it.
        // Actually backend services/transformer.py expects aggs to be just a dict passed to df.agg(aggs)
        // Wait, pandas df.agg() with output names requires specific format. 
        // Let's pass it as a special field or we handle it here. 
        // Wait, if I just do client-side transform for group by it's much safer.
        // Let's stick to client-side for groupby to preserve types exactly.
      });
      
      // Let's just pass group_by config
      const backendAggs: any = {};
      validAggs.forEach(a => {
        if (!backendAggs[a.column]) backendAggs[a.column] = [];
        backendAggs[a.column].push(a.func);
      });
      config = {
        group_by: {
          columns: groupKeys,
          aggregations: backendAggs
        }
      };
      desc = `Aggregated dataset grouped by [${groupKeys.join(', ')}]`;
    }

    setIsApplying(true);
    try {
      const res = await fetch('/api/transform', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: rows, config })
      });
      
      if (!res.ok) throw new Error("Transformation failed on server");
      
      const result = await res.json();
      
      // We will re-parse the result using our parser to rebuild types & stats
      import('../utils/parser').then(({ processDataset }) => {
        const file = new File([JSON.stringify(result.data)], dataset.fileName, { type: 'application/json' });
        // processDataset handles stats, headers, nullCounts automatically
        processDataset(file).then(newDataset => {
          onDatasetUpdated(newDataset, desc);
          
          // Reset states
          setMergeSrcCols([]);
          setMergeTargetCol('');
          setSplitTargets(['', '']);
          setMathTargetCol('');
          setGroupKeys([]);
          setAggregates([{ column: '', func: 'sum', outputName: '' }]);
        });
      });
    } catch (err: any) {
      alert("Error applying transformation: " + err?.message);
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 animate-fade-in">
      {/* Transformation Config Left panel */}
      <div className="xl:col-span-1 space-y-6">
        <div className="glass-panel p-5 rounded-xl space-y-5">
          <div className="flex border-b border-gray-800 gap-1 pb-1">
            <button
              onClick={() => setActiveTab('merge')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                activeTab === 'merge' 
                  ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30' 
                  : 'text-gray-400 hover:text-gray-200 hover:bg-zinc-900/30'
              }`}
            >
              <Merge className="h-4 w-4" />
              Merge
            </button>
            <button
              onClick={() => setActiveTab('split')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                activeTab === 'split' 
                  ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30' 
                  : 'text-gray-400 hover:text-gray-200 hover:bg-zinc-900/30'
              }`}
            >
              <Columns className="h-4 w-4" />
              Split
            </button>
            <button
              onClick={() => setActiveTab('math')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
                activeTab === 'math' 
                  ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30' 
                  : 'text-gray-400 hover:text-gray-200 hover:bg-zinc-900/30'
              }`}
            >
              <Sigma className="h-4 w-4" />
              Math
            </button>
            <button
              onClick={() => setActiveTab('groupby')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition relative ${
                activeTab === 'groupby' 
                  ? 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30' 
                  : 'text-gray-400 hover:text-gray-200 hover:bg-zinc-900/30'
              }`}
            >
              <Sigma className="h-4 w-4" />
              Group By
            </button>
          </div>

          {/* Merge Form */}
          {activeTab === 'merge' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Select Columns to Merge</label>
                <div className="max-h-[160px] overflow-y-auto border border-gray-800 rounded-lg p-2 bg-zinc-950/30 space-y-2">
                  {headers.map(col => (
                    <label key={col} className="flex items-center gap-2.5 px-2 py-1 hover:bg-zinc-900/40 rounded cursor-pointer text-xs">
                      <input 
                        type="checkbox"
                        checked={mergeSrcCols.includes(col)}
                        onChange={() => toggleMergeSrcCol(col)}
                        className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-cyan-500"
                      />
                      <span className="text-gray-300 truncate">{col}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Delimiter (Separator)</label>
                <select
                  value={mergeDelimiter}
                  onChange={(e) => setMergeDelimiter(e.target.value)}
                  className="w-full glass-input text-xs"
                >
                  <option value=" " className="bg-zinc-950">Space (" ")</option>
                  <option value="," className="bg-zinc-950">Comma (",")</option>
                  <option value="-" className="bg-zinc-950">Dash ("-")</option>
                  <option value="_" className="bg-zinc-950">Underscore ("_")</option>
                  <option value="/" className="bg-zinc-950">Slash ("/")</option>
                  <option value="|" className="bg-zinc-950">Pipe ("|")</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Target Column Name</label>
                <input 
                  type="text"
                  placeholder="e.g. Full_Name"
                  value={mergeTargetCol}
                  onChange={(e) => setMergeTargetCol(e.target.value)}
                  className="w-full glass-input text-xs"
                />
              </div>
            </div>
          )}

          {/* Split Form */}
          {activeTab === 'split' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Column to Split</label>
                <select
                  value={splitSrcCol}
                  onChange={(e) => setSplitSrcCol(e.target.value)}
                  className="w-full glass-input text-xs"
                >
                  {headers.map(col => (
                    <option key={col} value={col} className="bg-zinc-950">{col}</option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Split Delimiter</label>
                <input 
                  type="text"
                  maxLength={5}
                  value={splitDelimiter}
                  onChange={(e) => setSplitDelimiter(e.target.value)}
                  className="w-full glass-input text-xs"
                  placeholder="e.g. , or -"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-semibold text-gray-400 flex justify-between items-center">
                  Output Columns
                  <button 
                    onClick={addSplitField}
                    className="text-[10px] text-cyan-400 hover:underline flex items-center gap-0.5"
                  >
                    <Plus className="h-3 w-3" /> Add Field
                  </button>
                </label>
                
                <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1">
                  {splitTargets.map((target, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input 
                        type="text"
                        placeholder={`Column ${idx + 1}`}
                        value={target}
                        onChange={(e) => handleSplitTargetChange(idx, e.target.value)}
                        className="flex-1 glass-input text-xs"
                      />
                      {splitTargets.length > 2 && (
                        <button 
                          onClick={() => removeSplitField(idx)}
                          className="text-red-400 hover:text-red-300 p-1"
                        >
                          <Trash2 className="h-4.5 w-4.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Math Columns Form */}
          {activeTab === 'math' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Column A</label>
                <select
                  value={mathColA}
                  onChange={(e) => setMathColA(e.target.value)}
                  className="w-full glass-input text-xs"
                >
                  {headers.map(col => (
                    <option key={col} value={col} className="bg-zinc-950">
                      {col} ({types[col]})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Operation</label>
                <select
                  value={mathOp}
                  onChange={(e) => setMathOp(e.target.value as any)}
                  className="w-full glass-input text-xs"
                >
                  <option value="+" className="bg-zinc-950">Add (+)</option>
                  <option value="-" className="bg-zinc-950">Subtract (-)</option>
                  <option value="*" className="bg-zinc-950">Multiply (*)</option>
                  <option value="/" className="bg-zinc-950">Divide (/)</option>
                  <option value="concat" className="bg-zinc-950">Concatenate Strings</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Column B</label>
                <select
                  value={mathColB}
                  onChange={(e) => setMathColB(e.target.value)}
                  className="w-full glass-input text-xs"
                >
                  {headers.map(col => (
                    <option key={col} value={col} className="bg-zinc-950">
                      {col} ({types[col]})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Target Column Name</label>
                <input 
                  type="text"
                  placeholder="e.g. Total_Value"
                  value={mathTargetCol}
                  onChange={(e) => setMathTargetCol(e.target.value)}
                  className="w-full glass-input text-xs"
                />
              </div>
            </div>
          )}

          {/* Group By and Aggregate Form */}
          {activeTab === 'groupby' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-gray-400">Group By Column(s)</label>
                <div className="max-h-[120px] overflow-y-auto border border-gray-800 rounded-lg p-2 bg-zinc-950/30 space-y-2">
                  {headers.map(col => (
                    <label key={col} className="flex items-center gap-2.5 px-2 py-1 hover:bg-zinc-900/40 rounded cursor-pointer text-xs">
                      <input 
                        type="checkbox"
                        checked={groupKeys.includes(col)}
                        onChange={() => toggleGroupKey(col)}
                        className="h-3.5 w-3.5 rounded border-gray-800 bg-zinc-950 text-cyan-500"
                      />
                      <span className="text-gray-300 truncate">{col}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <label className="block text-xs font-semibold text-gray-400 flex justify-between items-center">
                  Aggregations
                  <button 
                    onClick={addAggregate}
                    className="text-[10px] text-cyan-400 hover:underline flex items-center gap-0.5"
                  >
                    <Plus className="h-3 w-3" /> Add Aggregate
                  </button>
                </label>
                
                <div className="space-y-3 max-h-[180px] overflow-y-auto pr-1">
                  {aggregates.map((agg, idx) => (
                    <div key={idx} className="p-3 rounded-lg border border-gray-800/80 bg-zinc-900/10 space-y-2 relative">
                      <div className="flex gap-2">
                        <select
                          value={agg.column}
                          onChange={(e) => handleAggChange(idx, 'column', e.target.value)}
                          className="flex-1 glass-input text-[10px] px-1 py-1"
                        >
                          <option value="">-- select column --</option>
                          {headers.map(col => (
                            <option key={col} value={col}>{col}</option>
                          ))}
                        </select>
                        <select
                          value={agg.func}
                          onChange={(e) => handleAggChange(idx, 'func', e.target.value)}
                          className="w-24 glass-input text-[10px] px-1 py-1"
                        >
                          <option value="sum">Sum</option>
                          <option value="mean">Average</option>
                          <option value="count">Count</option>
                          <option value="min">Min</option>
                          <option value="max">Max</option>
                        </select>
                      </div>
                      
                      <input 
                        type="text"
                        placeholder="Output column name"
                        value={agg.outputName}
                        onChange={(e) => handleAggChange(idx, 'outputName', e.target.value)}
                        className="w-full glass-input text-[10px] px-2 py-1.5"
                      />
                      
                      {aggregates.length > 1 && (
                        <button
                          onClick={() => removeAggregate(idx)}
                          className="absolute -top-1 -right-1 p-1 bg-red-950/60 hover:bg-red-900/80 text-red-400 rounded-full border border-red-900/30"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-amber-950/20 border border-amber-900/30 text-[10px] text-amber-400 leading-normal">
                <AlertTriangle className="h-4.5 w-4.5 shrink-0" />
                <span><strong>Warning:</strong> Grouping creates a structural summary, replacing all other dataset columns.</span>
              </div>
            </div>
          )}
        </div>

        {/* Buttons */}
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
            onClick={handleApplyTransform}
            className="flex-[2] px-4 py-2.5 rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 text-white font-semibold hover:from-emerald-400 hover:to-cyan-400 shadow-md shadow-emerald-500/10 hover:shadow-cyan-500/20 hover:scale-[1.01] transition duration-200 flex items-center justify-center gap-2 text-sm"
          >
            <Check className="h-4 w-4" />
            Apply Transform
          </button>
        </div>
      </div>

      {/* Preview Grid Right panel */}
      <div className="xl:col-span-2 space-y-4">
        <div className="glass-panel rounded-xl overflow-hidden border border-gray-800 flex flex-col h-full">
          <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-white">Transformation Preview</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">
                Displays the first 10 rows representing how the schema changes after this transformation.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto flex-1">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-gray-800 bg-zinc-900/40">
                  <th className="px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wider w-16 text-center">Row</th>
                  {previewHeaders.map(header => {
                    const isNew = !headers.includes(header);
                    return (
                      <th 
                        key={header} 
                        className={`px-4 py-3 min-w-[150px] border-r border-gray-800/30 text-gray-200 font-semibold ${
                          isNew ? 'bg-cyan-950/20 text-cyan-400' : ''
                        }`}
                      >
                        <div className="flex flex-col">
                          <span>{header}</span>
                          <span className="text-[9px] font-normal text-gray-500 mt-0.5">({previewTypes[header]})</span>
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-800/50">
                {previewRows.length > 0 ? (
                  previewRows.map((row, idx) => (
                    <tr key={idx} className="hover:bg-zinc-900/20 transition-colors">
                      <td className="px-4 py-2.5 text-center text-gray-500 font-mono border-r border-gray-800 bg-zinc-900/10">
                        {idx + 1}
                      </td>
                      {previewHeaders.map(header => {
                        const val = row[header];
                        const isNew = !headers.includes(header);
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

                        let cellStyle = isNew ? 'text-cyan-400 font-semibold' : 'text-gray-300';
                        if (isNull) cellStyle = 'text-amber-500/70 italic font-mono text-xs';

                        return (
                          <th 
                            key={header} 
                            className={`px-4 py-2.5 font-normal border-r border-gray-800/30 truncate max-w-[200px] ${
                              isNew ? 'bg-cyan-950/5' : ''
                            }`}
                          >
                            <span className={cellStyle}>{renderedVal}</span>
                          </th>
                        );
                      })}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={previewHeaders.length + 1} className="text-center py-8 text-gray-500 text-xs italic">
                      Configure parameters on the left to see transform preview
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
