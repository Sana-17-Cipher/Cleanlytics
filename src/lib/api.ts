/**
 * Client for the analysis API.
 *
 * Every call goes through `request`, so error handling is identical everywhere
 * and the API's own error text reaches the user instead of a generic
 * "something went wrong". The server writes those messages in plain language
 * specifically so they can be shown as-is.
 */

import type {
  HealthInfo,
  HistoryEntry,
  OperationResponse,
  PageOfRows,
  ProjectDetail,
  ProjectSummary,
  QueryResult,
  QuerySpec,
  Relationship,
  RelationshipStatus,
  SemanticModel,
  TableDetail,
  TableSummary,
  UploadResult,
} from './types';

const BASE = '/api';

// ── Auth token management ───────────────────────────────────────────────────
// The AuthProvider calls setToken whenever the Supabase session changes.
let _accessToken: string | null = null;

export function setToken(token: string | null) {
  _accessToken = token;
}

export function getToken(): string | null {
  return _accessToken;
}

/** Thrown for any non-2xx response, carrying the server's own explanation. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    if (_accessToken) {
      headers.set('Authorization', `Bearer ${_accessToken}`);
    }
    response = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(
      'Could not reach the analysis service. Check that the backend is running.',
      0,
    );
  }

  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'detail' in body) {
        const raw = (body as { detail: unknown }).detail;
        detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
      }
    } catch {
      // Response had no JSON body; the status-based message stands.
    }
    throw new ApiError(detail, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  health: () => request<HealthInfo>('/health'),

  // ── Projects ──────────────────────────────────────────────────────────────
  listProjects: () => request<ProjectSummary[]>('/projects'),

  createProject: (name: string, description?: string) =>
    request<ProjectSummary>('/projects', json({ name, description })),

  getProject: (projectId: number) => request<ProjectDetail>(`/projects/${projectId}`),

  deleteProject: (projectId: number) =>
    request<{ message: string }>(`/projects/${projectId}`, { method: 'DELETE' }),

  // ── Tables ────────────────────────────────────────────────────────────────

  /**
   * Upload one or more files into a project.
   *
   * Takes XMLHttpRequest rather than fetch purely because fetch still cannot
   * report upload progress, and a 150 MB file with no progress bar looks like
   * a hung application.
   */
  uploadTables: (
    projectId: number,
    files: File[],
    onProgress?: (fraction: number) => void,
  ): Promise<UploadResult> =>
    new Promise((resolve, reject) => {
      const form = new FormData();
      files.forEach((file) => form.append('files', file));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/projects/${projectId}/tables`);
      if (_accessToken) {
        xhr.setRequestHeader('Authorization', `Bearer ${_accessToken}`);
      }

      xhr.upload.addEventListener('progress', (event) => {
        if (onProgress && event.lengthComputable) {
          onProgress(event.loaded / event.total);
        }
      });

      xhr.addEventListener('load', () => {
        try {
          const body = JSON.parse(xhr.responseText) as UploadResult & { detail?: string };
          if (xhr.status >= 200 && xhr.status < 300) resolve(body);
          else reject(new ApiError(body.detail ?? `Upload failed (${xhr.status})`, xhr.status));
        } catch {
          reject(new ApiError(`Upload failed (${xhr.status})`, xhr.status));
        }
      });

      xhr.addEventListener('error', () =>
        reject(new ApiError('The upload could not reach the server.', 0)),
      );
      xhr.addEventListener('abort', () => reject(new ApiError('Upload cancelled.', 0)));

      xhr.send(form);
    }),

  listTables: (projectId: number) => request<TableSummary[]>(`/projects/${projectId}/tables`),

  getTable: (projectId: number, tableId: number) =>
    request<TableDetail>(`/projects/${projectId}/tables/${tableId}`),

  getRows: (
    projectId: number,
    tableId: number,
    options: {
      offset?: number;
      limit?: number;
      orderBy?: string;
      direction?: 'asc' | 'desc';
      search?: string;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.offset != null) params.set('offset', String(options.offset));
    if (options.limit != null) params.set('limit', String(options.limit));
    if (options.orderBy) params.set('order_by', options.orderBy);
    if (options.direction) params.set('direction', options.direction);
    if (options.search) params.set('search', options.search);
    return request<PageOfRows>(
      `/projects/${projectId}/tables/${tableId}/rows?${params.toString()}`,
    );
  },

  deleteTable: (projectId: number, tableId: number) =>
    request<{ message: string }>(`/projects/${projectId}/tables/${tableId}`, {
      method: 'DELETE',
    }),

  applyOperation: (
    projectId: number,
    tableId: number,
    operation: string,
    params: Record<string, unknown>,
  ) =>
    request<OperationResponse>(
      `/projects/${projectId}/tables/${tableId}/operations`,
      json({ operation, params }),
    ),

  undo: (projectId: number, tableId: number) =>
    request<{ reverted: string | null; undo_steps_remaining: number; table: TableDetail }>(
      `/projects/${projectId}/tables/${tableId}/undo`,
      { method: 'POST' },
    ),

  history: (projectId: number, tableId: number) =>
    request<HistoryEntry[]>(`/projects/${projectId}/tables/${tableId}/history`),

  exportUrl: (projectId: number, tableId: number, format: string) =>
    `${BASE}/projects/${projectId}/tables/${tableId}/export?format=${format}`,

  // ── Relationships ─────────────────────────────────────────────────────────
  detectRelationships: (projectId: number) =>
    request<{ relationships: Relationship[]; message: string }>(
      `/projects/${projectId}/relationships/detect`,
      { method: 'POST' },
    ),

  listRelationships: (projectId: number) =>
    request<Relationship[]>(`/projects/${projectId}/relationships`),

  setRelationshipStatus: (projectId: number, relationshipId: number, status: RelationshipStatus) =>
    request<Relationship>(`/projects/${projectId}/relationships/${relationshipId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),

  createRelationship: (
    projectId: number,
    link: { from_table_id: number; from_column: string; to_table_id: number; to_column: string },
  ) => request<Relationship>(`/projects/${projectId}/relationships`, json(link)),

  deleteRelationship: (projectId: number, relationshipId: number) =>
    request<{ message: string }>(`/projects/${projectId}/relationships/${relationshipId}`, {
      method: 'DELETE',
    }),

  // ── Model and querying ────────────────────────────────────────────────────
  getModel: (projectId: number) => request<SemanticModel>(`/projects/${projectId}/model`),

  query: (projectId: number, spec: QuerySpec) =>
    request<QueryResult>(`/projects/${projectId}/query`, json(spec)),

  // ── Dashboard ─────────────────────────────────────────────────────────────
  getDashboard: (projectId: number) =>
    request<{ widgets: unknown[]; layouts: Record<string, unknown> }>(
      `/projects/${projectId}/dashboard`,
    ),

  saveDashboard: (projectId: number, widgets: unknown[], layouts: Record<string, unknown>) =>
    request<{ message: string }>(`/projects/${projectId}/dashboard`, json({ widgets, layouts })),
};
