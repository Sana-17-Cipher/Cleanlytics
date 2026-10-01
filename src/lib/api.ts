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

let accessToken: string | null = null;

// Authentication

export function setToken(token: string | null) {
  accessToken = token;
}

export function getToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface UploadOptions {
  /** Requires backend support for the auto_clean form field. */
  autoClean?: boolean;

  /** Cancels the client request; server processing may continue. */
  signal?: AbortSignal;

  /** Timeout in milliseconds. Zero allows long processing. */
  timeoutMs?: number;
}

// Error handling

function errorDetail(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null;
  }

  if (Array.isArray(value)) {
    return (
      value
        .map(errorDetail)
        .filter(Boolean)
        .join('; ') || null
    );
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;

  // FastAPI validation errors contain loc and msg.
  if (typeof record.msg === 'string') {
    const location = Array.isArray(record.loc)
      ? record.loc
          .filter((part) => part !== 'body')
          .join('.')
      : '';

    return location
      ? `${location}: ${record.msg}`
      : record.msg;
  }

  return (
    errorDetail(record.detail) ??
    errorDetail(record.message)
  );
}

function failureMessage(body: unknown, status: number): string {
  const detail = errorDetail(body);

  if (detail) return detail;

  switch (status) {
    case 401:
      return (
        'Your session has expired or you are not signed in. ' +
        'Please sign in again.'
      );

    case 403:
      return 'You do not have permission to perform this action.';

    case 413:
      return 'The upload exceeds a server or proxy size limit.';

    case 504:
      return (
        'The server took too long to respond. ' +
        'Check the project before retrying.'
      );

    default:
      return `Request failed (${status}).`;
  }
}

// Shared JSON request

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);

  headers.set('Accept', 'application/json');

  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  let response: Response;

  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (cause) {
    const cancelled =
      init?.signal?.aborted ||
      (cause instanceof Error && cause.name === 'AbortError');

    if (cancelled) {
      throw new ApiError('Request cancelled.', 0);
    }

    throw new ApiError(
      'Could not reach the analysis service. ' +
      'Check that the backend is running.',
      0,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    if (!response.ok) {
      throw new ApiError(
        failureMessage(null, response.status),
        response.status,
      );
    }

    throw new ApiError(
      'The server returned an invalid JSON response.',
      response.status,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      failureMessage(body, response.status),
      response.status,
    );
  }

  return body as T;
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

// File upload

function uploadTables(
  projectId: number,
  files: File[],
  onProgress?: (fraction: number) => void,
  options: UploadOptions = {},
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (!files.length) {
      reject(
        new ApiError('Select at least one file to upload.', 0),
      );
      return;
    }

    if (options.signal?.aborted) {
      reject(new ApiError('Upload cancelled.', 0));
      return;
    }

    const timeout = options.timeoutMs ?? 0;

    if (
      !Number.isFinite(timeout) ||
      timeout < 0 ||
      timeout > 4_294_967_295
    ) {
      reject(
        new ApiError(
          'Upload timeout must be between 0 and ' +
          '4294967295 milliseconds.',
          0,
        ),
      );
      return;
    }

    const xhr = new XMLHttpRequest();
    const form = new FormData();

    files.forEach((file) => {
      form.append('files', file);
    });

    // Only send this setting when explicitly provided.
    if (options.autoClean !== undefined) {
      form.append('auto_clean', String(options.autoClean));
    }

    let settled = false;

    const abort = () => xhr.abort();

    const finish = (
      error: ApiError | null,
      result?: UploadResult,
    ) => {
      if (settled) return;

      settled = true;

      options.signal?.removeEventListener('abort', abort);

      if (error) {
        reject(error);
      } else {
        resolve(result!);
      }
    };

    const reportProgress = (fraction: number) => {
      if (settled) return;

      // UI callback errors must not leave the request unresolved.
      try {
        onProgress?.(
          Math.max(0, Math.min(1, fraction)),
        );
      } catch {
        // Progress reporting does not control the request.
      }
    };

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && event.total > 0) {
        reportProgress(event.loaded / event.total);
      }
    });

    // File transfer completion is separate from server processing.
    xhr.upload.addEventListener('load', () => {
      reportProgress(1);
    });

    xhr.addEventListener('load', () => {
      let body: unknown;

      const success =
        xhr.status >= 200 && xhr.status < 300;

      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        finish(
          new ApiError(
            success
              ? 'The upload response was invalid. ' +
                'Check the project before retrying.'
              : failureMessage(null, xhr.status),
            xhr.status,
          ),
        );
        return;
      }

      if (!success) {
        finish(
          new ApiError(
            failureMessage(body, xhr.status),
            xhr.status,
          ),
        );
        return;
      }

      const result = body as Partial<UploadResult> | null;

      if (
        !result ||
        !Array.isArray(result.tables) ||
        !Array.isArray(result.failed) ||
        !Array.isArray(result.relationships) ||
        typeof result.message !== 'string'
      ) {
        finish(
          new ApiError(
            'The upload response was incomplete. ' +
            'Check the project before retrying.',
            xhr.status,
          ),
        );
        return;
      }

      finish(null, result as UploadResult);
    });

    xhr.addEventListener('error', () => {
      finish(
        new ApiError(
          'The upload connection failed. ' +
          'Check the project before retrying.',
          0,
        ),
      );
    });

    xhr.addEventListener('abort', () => {
      finish(
        new ApiError(
          'Upload cancelled. Server processing may continue; ' +
          'check the project before retrying.',
          0,
        ),
      );
    });

    xhr.addEventListener('timeout', () => {
      finish(
        new ApiError(
          'The upload timed out. Server processing may continue; ' +
          'check the project before retrying.',
          0,
        ),
      );
    });

    try {
      xhr.open(
        'POST',
        `${BASE}/projects/${projectId}/tables`,
      );

      xhr.timeout = timeout;

      xhr.setRequestHeader('Accept', 'application/json');

      if (accessToken) {
        xhr.setRequestHeader(
          'Authorization',
          `Bearer ${accessToken}`,
        );
      }

      options.signal?.addEventListener(
        'abort',
        abort,
        { once: true },
      );

      reportProgress(0);

      if (options.signal?.aborted) {
        finish(new ApiError('Upload cancelled.', 0));
        return;
      }

      xhr.send(form);
    } catch {
      finish(
        new ApiError(
          'The upload request could not be started.',
          0,
        ),
      );
    }
  });
}

export const api = {
  // Health

  health: () =>
    request<HealthInfo>('/health'),

  // Projects

  listProjects: () =>
    request<ProjectSummary[]>('/projects'),

  createProject: (
    name: string,
    description?: string,
  ) =>
    request<ProjectSummary>(
      '/projects',
      json({ name, description }),
    ),

  getProject: (projectId: number) =>
    request<ProjectDetail>(
      `/projects/${projectId}`,
    ),

  deleteProject: (projectId: number) =>
    request<{ message: string }>(
      `/projects/${projectId}`,
      { method: 'DELETE' },
    ),

  // Tables

  uploadTables,

  listTables: (projectId: number) =>
    request<TableSummary[]>(
      `/projects/${projectId}/tables`,
    ),

  getTable: (
    projectId: number,
    tableId: number,
  ) =>
    request<TableDetail>(
      `/projects/${projectId}/tables/${tableId}`,
    ),

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

    if (options.offset != null) {
      params.set('offset', String(options.offset));
    }

    if (options.limit != null) {
      params.set('limit', String(options.limit));
    }

    if (options.orderBy) {
      params.set('order_by', options.orderBy);
    }

    if (options.direction) {
      params.set('direction', options.direction);
    }

    if (options.search) {
      params.set('search', options.search);
    }

    return request<PageOfRows>(
      `/projects/${projectId}/tables/${tableId}/rows?${params}`,
    );
  },

  deleteTable: (
    projectId: number,
    tableId: number,
  ) =>
    request<{ message: string }>(
      `/projects/${projectId}/tables/${tableId}`,
      { method: 'DELETE' },
    ),

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

  undo: (
    projectId: number,
    tableId: number,
  ) =>
    request<{
      reverted: string | null;
      undo_steps_remaining: number;
      table: TableDetail;
    }>(
      `/projects/${projectId}/tables/${tableId}/undo`,
      { method: 'POST' },
    ),

  history: (
    projectId: number,
    tableId: number,
  ) =>
    request<HistoryEntry[]>(
      `/projects/${projectId}/tables/${tableId}/history`,
    ),

  exportUrl: (
    projectId: number,
    tableId: number,
    format: string,
  ) =>
    `${BASE}/projects/${projectId}/tables/${tableId}/export?` +
    new URLSearchParams({ format }).toString(),

  // Relationships

  detectRelationships: (projectId: number) =>
    request<{
      relationships: Relationship[];
      message: string;
    }>(
      `/projects/${projectId}/relationships/detect`,
      { method: 'POST' },
    ),

  listRelationships: (projectId: number) =>
    request<Relationship[]>(
      `/projects/${projectId}/relationships`,
    ),

  setRelationshipStatus: (
    projectId: number,
    relationshipId: number,
    status: RelationshipStatus,
  ) =>
    request<Relationship>(
      `/projects/${projectId}/relationships/${relationshipId}`,
      {
        ...json({ status }),
        method: 'PATCH',
      },
    ),

  createRelationship: (
    projectId: number,
    link: {
      from_table_id: number;
      from_column: string;
      to_table_id: number;
      to_column: string;
    },
  ) =>
    request<Relationship>(
      `/projects/${projectId}/relationships`,
      json(link),
    ),

  deleteRelationship: (
    projectId: number,
    relationshipId: number,
  ) =>
    request<{ message: string }>(
      `/projects/${projectId}/relationships/${relationshipId}`,
      { method: 'DELETE' },
    ),

  // Semantic model and queries

  getModel: (projectId: number) =>
    request<SemanticModel>(
      `/projects/${projectId}/model`,
    ),

  query: (
    projectId: number,
    spec: QuerySpec,
  ) =>
    request<QueryResult>(
      `/projects/${projectId}/query`,
      json(spec),
    ),

  // Dashboard

  getDashboard: (projectId: number) =>
    request<{
      widgets: unknown[];
      layouts: Record<string, unknown>;
    }>(
      `/projects/${projectId}/dashboard`,
    ),

  saveDashboard: (
    projectId: number,
    widgets: unknown[],
    layouts: Record<string, unknown>,
  ) =>
    request<{ message: string }>(
      `/projects/${projectId}/dashboard`,
      json({ widgets, layouts }),
    ),
};