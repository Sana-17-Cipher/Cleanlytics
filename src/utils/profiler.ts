/**
 * CLEANYTICS — Semantic Profile & Intelligence Types
 * Shared TypeScript interfaces consumed by all frontend components.
 */

// ─── Semantic Column Profile ────────────────────────────────────────────────

export type SemanticRole =
  | 'measure'
  | 'dimension'
  | 'time'
  | 'id'
  | 'geographic'
  | 'category'
  | 'boolean'
  | 'text';

export type AggregationBehavior =
  | 'SUM'
  | 'AVG'
  | 'COUNT'
  | 'DISTINCT_COUNT'
  | 'MIN'
  | 'MAX'
  | 'NONE';

export interface SemanticField {
  name: string;
  detected_type: string;       // integer | decimal | currency | percentage | date | datetime | boolean | text
  semantic_role: SemanticRole;
  aggregation_behavior: AggregationBehavior;
  confidence: number;          // 0..1
  is_nullable: boolean;
  null_count: number;
  unique_ratio: number;        // 0..1
  cardinality: number;
  is_primary_key_candidate?: boolean;
  is_foreign_key_candidate?: boolean;
  examples: string[];
  detected_format: string;
  source: 'auto' | 'user';    // 'auto' = system-detected, 'user' = overridden by user

  // Numeric stats (only for numeric columns)
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  std_dev?: number;
}

export interface DatasetSummary {
  rows: number;
  columns: number;
  total_missing: number;
  quality_score: number;       // 0..100
  duplicate_rows: number;
  measure_count: number;
  dimension_count: number;
  time_count: number;
  id_count: number;
}

export interface SemanticProfile {
  columns: SemanticField[];
  summary: DatasetSummary;
}


// ─── Multi-Table Model Types ────────────────────────────────────────────────

export interface DataTableMeta {
  id: number;
  tableName: string;
  fileName: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
  types: Record<string, string>;
  profile: SemanticProfile | null;
  rowsData?: Record<string, any>[];
}

export interface RelationshipCandidate {
  id: number;
  fromTableId: number;
  fromTableName?: string;
  fromColumn: string;
  toTableId: number;
  toTableName?: string;
  toColumn: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  confidence: number;
  status: 'suggested' | 'approved' | 'rejected';
}

export interface CrossTableMeasure {
  id: string;
  name: string;
  formula: string;
  description: string;
  sourceTable: string;
  joinPath: string[];
  aggregation: string;
  reason: string;
  confidence: number;
}

export interface SemanticModel {
  projectId: number;
  tables: DataTableMeta[];
  relationships: RelationshipCandidate[];
  crossTableMeasures?: CrossTableMeasure[];
}


// ─── Quality Suggestions ────────────────────────────────────────────────────

export type RiskTier = 'A' | 'B' | 'C';
export type IssueSeverity = 'low' | 'medium' | 'high';

export type QualityIssueType =
  | 'duplicate_rows'
  | 'missing_values'
  | 'inconsistent_case'
  | 'whitespace'
  | 'outliers'
  | 'constant_column';

export interface QualitySuggestion {
  id: string;
  type: QualityIssueType;
  severity: IssueSeverity;
  affected_rows: number;
  column: string | null;
  description: string;
  recommendation: string;
  why: string;
  confidence: number;
  risk_tier: RiskTier;
}


// ─── Transformation Suggestions ─────────────────────────────────────────────

export type TransformSuggestionType =
  | 'date_decomposition'
  | 'derived_calculation';

export interface TransformationSuggestion {
  id: string;
  type: TransformSuggestionType;
  target_column: string | null;
  new_column: string;
  parameters: Record<string, any>;
  name: string;
  description: string;
  reason: string;
  confidence: number;
  risk_tier: RiskTier;
}


// ─── Measure Recommendations ────────────────────────────────────────────────

export interface MeasureRecommendation {
  id: string;
  name: string;
  formula: string;
  description: string;
  source_columns: string[];
  aggregation: string;
  reason: string;
  confidence: number;
}


// ─── Dashboard Intelligence ─────────────────────────────────────────────────

export interface VisualizationRecommendation {
  chart_type: 'bar' | 'line' | 'area' | 'pie' | 'scatter' | 'table' | 'kpi';
  aggregation: string;
  reason: string;
  confidence: number;
}


// ─── Transformation History ─────────────────────────────────────────────────

export interface TransformationEntry {
  id: string;
  timestamp: string;
  operation: string;
  description: string;
  source: 'auto' | 'manual' | 'suggestion';
  suggestion_id?: string;
}
