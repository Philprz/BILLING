// ---------------------------------------------------------------------------
// Types partagés — PA-SAP-Bridge
// ---------------------------------------------------------------------------

export * from './dtos';

export type Environment = 'development' | 'production' | 'test';

// Réponse API générique
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

// Health check
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  version: string;
  timestamp: string;
}

// Pagination
export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
