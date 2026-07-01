export interface Dataset {
  id: string;
  filename: string;
  columns: string[];
  rowCount: number;
  size: number;
  previewData: Record<string, any>[];
  columnTypes?: Record<string, string>;
  stats?: Record<string, any>;
}

export interface CleanOptions {
  removeDuplicates?: boolean;
  dropMissing?: boolean;
  fillMissing?: boolean;
  fillValue?: string;
  fuzzyDedup?: boolean;
  emailValidation?: boolean;
  phoneStandardization?: boolean;
  fwdFill?: boolean;
  bwdFill?: boolean;
}

export interface TransformOptions {
  operations: {
    type: string;
    params: Record<string, any>;
  }[];
}

export interface Insights {
  correlationHeatmap?: {
    columns: string[];
    matrix: number[][];
  };
  anomalies?: {
    column: string;
    indices: number[];
    values: any[];
  }[];
  summary?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
