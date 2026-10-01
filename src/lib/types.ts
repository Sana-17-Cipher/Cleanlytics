/**
 * Shape of everything the analysis API returns.
 *
 * New metadata is optional so older saved profiles remain compatible.
 * TypeScript checks callers; it does not validate JSON at runtime.
 */

export type LogicalType =
  | 'integer'
  | 'decimal'
  | 'currency'
  | 'percentage'
  | 'date'
  | 'datetime'
  | 'time'
  | 'boolean'
  | 'text';

export type SemanticRole =
  | 'measure'
  | 'dimension'
  | 'category'
  | 'time'
  | 'identifier'
  | 'geographic'
  | 'boolean'
  | 'text';

export type Aggregation =
  | 'sum'
  | 'avg'
  | 'min'
  | 'max'
  | 'count'
  | 'count_distinct'
  | 'median';

export type Additivity = 'additive' | 'semi_additive' | 'non_additive';

export type Severity = 'high' | 'medium' | 'low';

export type Cardinality =
  | 'one_to_one'
  | 'one_to_many'
  | 'many_to_one'
  | 'many_to_many';

export type RelationshipStatus = 'suggested' | 'approved' | 'rejected';

/** A cell value as it arrives from DuckDB via JSON. */
export type CellValue = string | number | boolean | null;

export type Row = Record<string, CellValue>;

export interface TopValue {
  value: string;
  count: number;
  share: number;
}

export interface NumericStatistics {
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
  std_dev: number | null;
  p05: number | null;
  q1: number | null;
  median: number | null;
  q3: number | null;
  p95: number | null;
  zero_count: number;
  negative_count: number;
  iqr?: number;
  outlier_low?: number;
  outlier_high?: number;
  non_finite_count?: number;
  quantiles_approximate?: boolean;
}

export interface TextStatistics {
  min_length: number;
  max_length: number;
  avg_length: number | null;
  whitespace_count: number;
  blank_count: number;
  case_variant_count: number;
  case_variant_measured?: boolean;
}

export interface TemporalStatistics {
  min: string | null;
  max: string | null;
}

/** Numeric and temporal bounds have different JSON types. */
export type ColumnStatistics = Partial<
  Omit<NumericStatistics, 'min' | 'max'> & TextStatistics
> & {
  min?: number | string | null;
  max?: number | string | null;
};

export interface ColumnProfile {
  name: string;
  position: number;
  physical_type: string;
  logical_type: LogicalType;
  subtype: string | null;
  semantic_role: SemanticRole;
  confidence: number;
  role_scores?: Partial<Record<SemanticRole, number>>;
  needs_review?: boolean;
  source?: string;

  /** Plain-language explanation of why this role was chosen. */
  reasons: string[];

  additivity: Additivity;
  default_aggregation: Aggregation;
  row_count: number;
  non_null_count: number;
  null_count: number;
  null_ratio: number;
  distinct_count: number;
  distinct_is_approximate: boolean;
  unique_ratio: number;
  is_unique: boolean;

  /** False when distinct counts were estimated rather than verified. */
  uniqueness_verified?: boolean;

  is_constant: boolean;
  is_empty: boolean;

  /** Blank strings are separate from SQL NULL values. */
  blank_count?: number;
  missing_count?: number;

  invalid_count: number;
  invalid_count_is_estimate?: boolean;
  invalid_count_measured?: boolean;
  pattern_sampled?: boolean;
  pattern_values_checked?: number;
  top_values: TopValue[];
  statistics: ColumnStatistics;
  patterns?: Record<string, number>;
}

export interface QualityComponents {
  completeness: number;
  uniqueness: number;
  consistency: number;
  validity: number;
}

export type QualityComponentName = keyof QualityComponents;

export type QualityMeasurementFlags = Record<QualityComponentName, boolean>;

export interface DatasetSummary {
  rows: number;
  columns: number;
  total_cells: number;

  /** SQL NULL cells only; blanks are reported separately. */
  total_missing: number;
  total_blank?: number;
  total_missing_including_blanks?: number;

  duplicate_rows: number | null;
  duplicate_rows_measured: boolean;

  /** Indicative score from measured checks, not business accuracy. */
  quality_score: number;
  quality_score_available?: boolean;
  quality_components: QualityComponents;

  /** An unmeasured component has a placeholder zero, not a failing score. */
  quality_components_measured?: QualityMeasurementFlags;

  quality_note?: string;
  patterns_sampled?: boolean;
  distinct_counts_approximate?: boolean;
  quality_weights: QualityComponents;
  role_counts: Partial<Record<SemanticRole, number>>;
  measure_count: number;
  dimension_count: number;
  time_count: number;
  identifier_count: number;
  primary_key_candidates: string[];
}

export interface TableProfile {
  columns: ColumnProfile[];
  summary: DatasetSummary;
}

/** One repair the user can choose, carrying the operation that will run. */
export interface QualityAction {
  operation: string;
  params: Record<string, unknown>;
  label: string;

  /** What happens to the data, including how much is removed. */
  consequence: string;

  destructive: boolean;
  recommended: boolean;
}

export interface QualityFinding {
  id: string;
  type: string;
  severity: Severity;
  column: string | null;
  affected_rows: number;
  title: string;
  detail: string;
  why: string;
  confidence: number;
  actions: QualityAction[];
}

export interface QualitySummary {
  total: number;
  high: number;
  medium: number;
  low: number;
  safe_fixes: number;
}

export interface QualityReport {
  findings: QualityFinding[];
  summary: QualitySummary;
}

export interface ColumnSummary {
  name: string;
  logical_type: LogicalType;
  semantic_role: SemanticRole;
  subtype: string | null;
  default_aggregation: Aggregation;
  additivity: Additivity;
  null_ratio: number;
  distinct_count: number;
  is_unique: boolean;
}

export interface TableSummary {
  id: number;
  table_name: string;
  source_file: string;
  source_sheet: string | null;
  row_count: number;
  column_count: number;
  columns: ColumnSummary[];
  summary: DatasetSummary | null;
  quality: QualityReport | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface TableDetail extends TableSummary {
  profile: TableProfile | null;
}

export interface Relationship {
  id: number;
  from_table_id: number;
  from_table_name: string;
  from_column: string;
  to_table_id: number;
  to_table_name: string;
  to_column: string;
  cardinality: Cardinality;
  cardinality_label: string;
  confidence: number;
  coverage: number | null;
  status: RelationshipStatus;
  origin: 'detected' | 'manual';
  evidence: string | null;
  notes: string[];
}

export interface ProjectSummary {
  id: number;
  name: string;
  description: string | null;
  table_count: number;
  row_count: number;
  created_at: string;
  updated_at: string | null;
}

export interface ProjectDetail {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  tables: TableSummary[];
  relationships: Relationship[];
}

export interface UploadResult {
  warnings?: string[];
  tables: TableSummary[];
  failed: { file: string; error: string }[];
  relationships: Relationship[];
  message: string;
}

export interface PageOfRows {
  rows: Row[];
  total: number;
  offset: number;
  limit: number;
}

export interface OperationOutcome {
  operation: string;
  description: string;
  rows_before: number;
  rows_after: number;
  rows_removed: number;
  cells_changed: number;
  columns_added: string[];
  columns_removed: string[];
  warnings: string[];
  destructive: boolean;
  undo_steps_remaining: number;
}

export interface OperationResponse {
  result: OperationOutcome;
  table: TableDetail;
}

export interface HistoryEntry {
  id: number;
  operation: string;
  description: string;
  rows_before: number | null;
  rows_after: number | null;
  destructive: boolean;
  created_at: string | null;
}

export type TableKind = 'fact' | 'dimension' | 'bridge' | 'standalone';

export interface ModelTable {
  id: number;
  table_name: string;
  row_count: number | null;
  kind: TableKind;
  reason: string;
  measure_count: number;
  outgoing: number;
  incoming: number;
}

export interface QueryDimension {
  table_id: number;
  column: string;
  date_part?: string | null;
  label?: string;
}

export interface QueryMeasure {
  table_id: number;
  column?: string | null;
  aggregation: Aggregation;
  label?: string;
}

export interface QueryFilter {
  table_id: number;
  column: string;
  operator: string;
  value?: unknown;
}

export interface QuerySpec {
  base_table_id?: number;
  dimensions?: QueryDimension[];
  measures?: QueryMeasure[];
  filters?: QueryFilter[];
  order_by?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
}

export interface QueryField {
  key: string;
  kind: 'dimension' | 'measure';
  table_id: number;
  table_name: string;
  column: string | null;
  aggregation?: Aggregation;
  date_part?: string | null;
}

export interface QueryResult {
  rows: Row[];
  row_count: number;
  truncated: boolean;
  fields: QueryField[];

  /** The SQL that produced these numbers, so figures can be traced. */
  sql: string;

  warnings: string[];
  base_table_name: string;
  joined_tables: string[];
}

export interface AnalysisSuggestion {
  id: string;
  title: string;
  description: string;
  chart: string;
  spec: QuerySpec;
}

export interface ModelFieldGroup {
  table_id: number;
  table_name: string;
  columns: {
    name: string;
    logical_type: LogicalType;
    semantic_role: SemanticRole;
    default_aggregation: Aggregation;
    additivity: Additivity;
    distinct_count: number;
  }[];
}

/** Runnable backend suggestions; user-saved layouts are separate. */
export interface DashboardPlan {
  version: 1;
  widgets: AnalysisSuggestion[];
  notes: string[];
}

export interface SemanticModel {
  /** Optional for models generated before dashboard planning was added. */
  dashboard_plan?: DashboardPlan | null;

  tables: ModelTable[];
  relationships: Relationship[];
  relationship_count: number;
  pending_count: number;
  islands: string[][];
  is_connected: boolean;
  suggestions: AnalysisSuggestion[];
  fields: ModelFieldGroup[];
}

export interface HealthInfo {
  status: string;
  auth_enabled: boolean;
  auth_note: string;
  max_upload_mb: number;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
  is_guest: boolean;
}