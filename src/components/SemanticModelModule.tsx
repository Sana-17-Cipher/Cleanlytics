'use client';

import React, { useState } from 'react';
import {
  Layers, Link2, Check, X, RefreshCw, Key, Hash, Tag, Calendar,
  TrendingUp, ArrowRight, ShieldCheck, Database, Plus, Sparkles, Trash2, Info
} from 'lucide-react';
import type { DataTableMeta, RelationshipCandidate, SemanticModel, SemanticField } from '../utils/profiler';

interface SemanticModelModuleProps {
  projectId?: number | string;
  tables: DataTableMeta[];
  relationships: RelationshipCandidate[];
  onDetectRelationships: () => Promise<void>;
  onUpdateRelationshipStatus: (relId: number, status: 'approved' | 'rejected') => Promise<void>;
  onDeleteTable?: (tableId: number) => Promise<void>;
  onSelectActiveTable?: (tableId: number) => void;
  activeTableId?: number | null;
  isLoading?: boolean;
}

const ROLE_BADGES: Record<string, { bg: string; text: string; border: string }> = {
  measure:    { bg: 'bg-emerald-950/40', text: 'text-emerald-400', border: 'border-emerald-800/30' },
  dimension:  { bg: 'bg-cyan-950/40',    text: 'text-cyan-400',    border: 'border-cyan-800/30' },
  time:       { bg: 'bg-amber-950/40',   text: 'text-amber-400',   border: 'border-amber-800/30' },
  id:         { bg: 'bg-zinc-800/60',    text: 'text-gray-300',     border: 'border-gray-700/40' },
  geographic: { bg: 'bg-violet-950/40',  text: 'text-violet-400',  border: 'border-violet-800/30' },
  category:   { bg: 'bg-blue-950/40',    text: 'text-blue-400',    border: 'border-blue-800/30' },
  boolean:    { bg: 'bg-pink-950/40',    text: 'text-pink-400',    border: 'border-pink-800/30' },
  text:       { bg: 'bg-zinc-900/40',    text: 'text-gray-400',    border: 'border-gray-800/30' },
};

export default function SemanticModelModule({
  projectId,
  tables,
  relationships,
  onDetectRelationships,
  onUpdateRelationshipStatus,
  onDeleteTable,
  onSelectActiveTable,
  activeTableId,
  isLoading = false,
}: SemanticModelModuleProps) {
  const [detecting, setDetecting] = useState(false);
  const [activeTab, setActiveTab] = useState<'diagram' | 'catalog' | 'measures'>('diagram');

  const handleDetect = async () => {
    setDetecting(true);
    try {
      await onDetectRelationships();
    } finally {
      setDetecting(false);
    }
  };

  const approvedRels = relationships.filter(r => r.status === 'approved');
  const suggestedRels = relationships.filter(r => r.status === 'suggested');

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold tracking-tight text-white">Semantic Data Model</h2>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-cyan-950/60 text-cyan-400 border border-cyan-800/40">
              Phase 1 Architecture
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Cross-table relationship detection, identifier scoping, and schema governance across {tables.length} tables.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center bg-zinc-900/80 rounded-lg p-1 border border-gray-800 text-xs font-medium">
            <button
              onClick={() => setActiveTab('diagram')}
              className={`px-3 py-1.5 rounded-md transition ${activeTab === 'diagram' ? 'bg-cyan-950/60 text-cyan-400 border border-cyan-800/40 font-semibold' : 'text-gray-400 hover:text-gray-200'}`}
            >
              Model Diagram
            </button>
            <button
              onClick={() => setActiveTab('catalog')}
              className={`px-3 py-1.5 rounded-md transition ${activeTab === 'catalog' ? 'bg-cyan-950/60 text-cyan-400 border border-cyan-800/40 font-semibold' : 'text-gray-400 hover:text-gray-200'}`}
            >
              Unified Catalog
            </button>
            <button
              onClick={() => setActiveTab('measures')}
              className={`px-3 py-1.5 rounded-md transition ${activeTab === 'measures' ? 'bg-cyan-950/60 text-cyan-400 border border-cyan-800/40 font-semibold' : 'text-gray-400 hover:text-gray-200'}`}
            >
              Cross-Table Metrics
            </button>
          </div>

          {tables.length >= 2 && (
            <button
              onClick={handleDetect}
              disabled={detecting || isLoading}
              className="px-3.5 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-emerald-500 text-white font-semibold text-xs hover:from-cyan-400 hover:to-emerald-400 transition shadow-lg shadow-cyan-500/10 flex items-center gap-1.5 disabled:opacity-50"
            >
              {detecting ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Detect Relationships
            </button>
          )}
        </div>
      </div>

      {/* Model Stats Bar */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Source Tables</p>
          <p className="text-xl font-extrabold text-white font-mono">{tables.length}</p>
          <p className="text-[10px] text-gray-500">Conceptual separate entities</p>
        </div>

        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Approved Joins</p>
          <p className="text-xl font-extrabold text-emerald-400 font-mono">{approvedRels.length}</p>
          <p className="text-[10px] text-gray-500">Active relationship channels</p>
        </div>

        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Pending Suggestions</p>
          <p className="text-xl font-extrabold text-amber-400 font-mono">{suggestedRels.length}</p>
          <p className="text-[10px] text-gray-500">Require user review</p>
        </div>

        <div className="glass-panel p-4 rounded-xl space-y-1">
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Total Columns</p>
          <p className="text-xl font-extrabold text-cyan-400 font-mono">
            {tables.reduce((acc, t) => acc + (t.columnCount || t.headers?.length || 0), 0)}
          </p>
          <p className="text-[10px] text-gray-500">Cross-table attributes</p>
        </div>
      </div>

      {/* TAB 1: Diagram View */}
      {activeTab === 'diagram' && (
        <div className="space-y-6">
          {/* Tables Cards Grid */}
          <div>
            <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
              <Database className="h-4 w-4 text-cyan-400" />
              Table Entities
            </h3>

            {tables.length === 0 ? (
              <div className="glass-panel p-8 rounded-xl text-center space-y-3">
                <Layers className="h-10 w-10 text-gray-600 mx-auto" />
                <p className="text-xs text-gray-400">No tables uploaded to this model yet.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {tables.map(table => {
                  const isActive = activeTableId === table.id;
                  const cols = table.profile?.columns || table.headers.map(h => ({
                    name: h,
                    detected_type: table.types[h] || 'string',
                    semantic_role: 'dimension' as const,
                    aggregation_behavior: 'NONE' as const,
                    confidence: 1,
                    is_nullable: false,
                    null_count: 0,
                    unique_ratio: 0,
                    cardinality: 0,
                    examples: [],
                    detected_format: '',
                    source: 'auto' as const,
                  }));

                  return (
                    <div
                      key={table.id}
                      onClick={() => onSelectActiveTable && onSelectActiveTable(table.id)}
                      className={`glass-panel rounded-xl border transition-all duration-300 overflow-hidden cursor-pointer ${
                        isActive
                          ? 'border-cyan-500/50 shadow-lg shadow-cyan-500/10 ring-1 ring-cyan-500/20'
                          : 'border-gray-800 hover:border-gray-700'
                      }`}
                    >
                      {/* Table Header */}
                      <div className="px-4 py-3 bg-zinc-900/60 border-b border-gray-800 flex items-center justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-extrabold text-white truncate">{table.tableName}</span>
                            {isActive && (
                              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-400 border border-cyan-800/40 shrink-0">
                                Active
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-gray-500 truncate mt-0.5">{table.fileName} · {table.rowCount.toLocaleString()} rows</p>
                        </div>
                        {onDeleteTable && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onDeleteTable(table.id); }}
                            className="p-1 rounded hover:bg-red-950/40 text-gray-500 hover:text-red-400 transition shrink-0 ml-2"
                            title="Delete Table"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>

                      {/* Column Attributes List */}
                      <div className="p-3 space-y-1.5 max-h-[220px] overflow-y-auto">
                        {cols.map(col => {
                          const badge = ROLE_BADGES[col.semantic_role] || ROLE_BADGES.text;
                          return (
                            <div
                              key={col.name}
                              className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-zinc-950/40 border border-gray-800/40 text-[11px]"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                {col.is_primary_key_candidate ? (
                                  <span className="text-[9px] px-1 py-0.5 rounded bg-amber-950/60 text-amber-400 border border-amber-800/40 font-bold shrink-0" title="Primary Key Candidate">
                                    🔑 PK
                                  </span>
                                ) : col.is_foreign_key_candidate ? (
                                  <span className="text-[9px] px-1 py-0.5 rounded bg-cyan-950/60 text-cyan-400 border border-cyan-800/40 font-bold shrink-0" title="Foreign Key Candidate">
                                    🔗 FK
                                  </span>
                                ) : (
                                  <span className="h-1.5 w-1.5 rounded-full bg-gray-600 shrink-0" />
                                )}
                                <span className="font-semibold text-gray-200 truncate">{col.name}</span>
                              </div>

                              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase border ${badge.bg} ${badge.text} ${badge.border}`}>
                                  {col.semantic_role}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Relationships List */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Link2 className="h-4 w-4 text-emerald-400" />
                Detected Relationships & Joins
              </h3>
              <span className="text-xs text-gray-500">
                {relationships.length} candidate links found
              </span>
            </div>

            {relationships.length === 0 ? (
              <div className="glass-panel p-6 rounded-xl text-center space-y-2">
                <p className="text-xs text-gray-400">No relationships detected yet.</p>
                {tables.length >= 2 ? (
                  <p className="text-[11px] text-gray-500">Click &quot;Detect Relationships&quot; above to scan matching keys across tables.</p>
                ) : (
                  <p className="text-[11px] text-gray-500">Upload at least 2 tables to establish relationships.</p>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                {relationships.map(rel => {
                  const isApproved = rel.status === 'approved';
                  const isRejected = rel.status === 'rejected';

                  return (
                    <div
                      key={rel.id}
                      className={`glass-panel p-3.5 rounded-xl border flex flex-col md:flex-row md:items-center justify-between gap-3 transition-all ${
                        isApproved
                          ? 'border-emerald-800/40 bg-emerald-950/10'
                          : isRejected
                          ? 'border-red-900/30 opacity-50'
                          : 'border-amber-800/40 bg-amber-950/10'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 border ${
                          isApproved
                            ? 'bg-emerald-950/60 border-emerald-800/40 text-emerald-400'
                            : 'bg-amber-950/60 border-amber-800/40 text-amber-400'
                        }`}>
                          <Link2 className="h-4 w-4" />
                        </div>

                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-bold text-white font-mono">{rel.fromTableName || `Table ${rel.fromTableId}`}.{rel.fromColumn}</span>
                            <ArrowRight className="h-3.5 w-3.5 text-gray-500 shrink-0" />
                            <span className="text-xs font-bold text-cyan-400 font-mono">{rel.toTableName || `Table ${rel.toTableId}`}.{rel.toColumn}</span>
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-zinc-800 text-gray-300 border border-gray-700/40">
                              {rel.cardinality}
                            </span>
                          </div>

                          <div className="flex items-center gap-3 text-[10px] text-gray-400 mt-1">
                            <span>Confidence: <strong className="text-gray-200">{Math.round(rel.confidence * 100)}%</strong></span>
                            <span>Status: <strong className={isApproved ? 'text-emerald-400' : isRejected ? 'text-red-400' : 'text-amber-400'}>{rel.status.toUpperCase()}</strong></span>
                          </div>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div className="flex items-center gap-2 shrink-0">
                        {isApproved ? (
                          <button
                            onClick={() => onUpdateRelationshipStatus(rel.id, 'rejected')}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-900 border border-gray-800 text-gray-400 hover:text-red-400 hover:border-red-800/40 transition"
                          >
                            Unlink
                          </button>
                        ) : (
                          <>
                            <button
                              onClick={() => onUpdateRelationshipStatus(rel.id, 'approved')}
                              className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-950/60 border border-emerald-800/40 text-emerald-400 hover:bg-emerald-900/60 transition flex items-center gap-1"
                            >
                              <Check className="h-3.5 w-3.5" /> Approve Join
                            </button>
                            <button
                              onClick={() => onUpdateRelationshipStatus(rel.id, 'rejected')}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-zinc-900 border border-gray-800 text-gray-500 hover:text-red-400 transition"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Unified Catalog */}
      {activeTab === 'catalog' && (
        <div className="glass-panel p-5 rounded-xl border border-gray-800 space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">Unified Cross-Table Column Catalog</h3>
            <p className="text-xs text-gray-400 mt-0.5">All attributes across source tables categorized by semantic role.</p>
          </div>

          <div className="space-y-4">
            {['measure', 'dimension', 'time', 'id', 'category'].map(role => {
              const allCols: { table: string; field: SemanticField }[] = [];
              tables.forEach(t => {
                const fields = t.profile?.columns || [];
                fields.filter(f => f.semantic_role === role).forEach(f => {
                  allCols.push({ table: t.tableName, field: f });
                });
              });

              if (allCols.length === 0) return null;
              const badge = ROLE_BADGES[role] || ROLE_BADGES.text;

              return (
                <div key={role} className="space-y-2">
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${badge.bg} ${badge.text} ${badge.border}`}>
                    {role}s ({allCols.length})
                  </span>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                    {allCols.map((c, i) => (
                      <div key={i} className="p-2.5 rounded-lg bg-zinc-950/40 border border-gray-800/40 text-xs flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-white">{c.field.name}</p>
                          <p className="text-[10px] text-gray-500 font-mono">{c.table} · {c.field.detected_type}</p>
                        </div>
                        <span className="text-[9px] font-mono text-gray-400 bg-zinc-900 px-1.5 py-0.5 rounded">
                          {c.field.aggregation_behavior}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TAB 3: Cross-Table Metrics */}
      {activeTab === 'measures' && (
        <div className="glass-panel p-5 rounded-xl border border-gray-800 space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white">Recommended Cross-Table Metrics</h3>
            <p className="text-xs text-gray-400 mt-0.5">Derived formulas leveraging approved table relationships.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="p-4 rounded-xl bg-zinc-950/40 border border-gray-800/60 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white">Revenue per Customer</span>
                <span className="text-[9px] font-mono text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded">DERIVED</span>
              </div>
              <p className="text-xs text-cyan-400 font-mono">SUM(Sales.Revenue) / DISTINCT_COUNT(Customers.Customer_ID)</p>
              <p className="text-[10px] text-gray-400 leading-relaxed">
                Calculates average spend per unique customer entity using the approved Customer_ID join.
              </p>
            </div>

            <div className="p-4 rounded-xl bg-zinc-950/40 border border-gray-800/60 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-white">Sales per Product Category</span>
                <span className="text-[9px] font-mono text-emerald-400 bg-emerald-950/40 px-1.5 py-0.5 rounded">AGGREGATE</span>
              </div>
              <p className="text-xs text-cyan-400 font-mono">SUM(Sales.Revenue) GROUP BY Products.Category</p>
              <p className="text-[10px] text-gray-400 leading-relaxed">
                Aggregates sales revenue by product dimension categories using Product_ID key link.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
