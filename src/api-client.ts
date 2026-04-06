import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TIMEOUT_MS = 5_000;
const LOG_DIR = join(homedir(), '.vibecompass');
const LOG_FILE = join(LOG_DIR, 'mcp-errors.log');

interface CacheEntry {
  data: unknown;
  timestamp: string;
}

export interface ApiResponse<T = unknown> {
  data: T;
  _freshness: string;
  _stale?: boolean;
  _error?: string;
}

export class VibeCompassClient {
  private baseUrl: string;
  private apiKey: string;
  private cache = new Map<string, CacheEntry>();

  constructor(config: { apiKey: string; baseUrl?: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://vibecompass.dev').replace(
      /\/$/,
      '',
    );
  }

  /**
   * GET request — resilient. On failure, returns cached data or empty fallback.
   * Read tools should never crash the session (D-007).
   */
  async get<T = unknown>(
    path: string,
    params?: Record<string, string | undefined>,
  ): Promise<ApiResponse<T>> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, value);
      }
    }
    return this.requestWithResilience<T>(url.toString());
  }

  /**
   * POST request — NOT resilient. Write failures must surface as errors.
   * A silent "success" on a failed write is worse than an error.
   */
  async post<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.requestStrict<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * PATCH request — NOT resilient. Same as POST.
   */
  async patch<T = unknown>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.requestStrict<T>(`${this.baseUrl}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /**
   * Resilient request for reads: cache + fallback on failure.
   */
  private async requestWithResilience<T>(url: string): Promise<ApiResponse<T>> {
    const cacheKey = `GET:${url}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown error');
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }

      const json = (await response.json()) as ApiResponse<T>;

      // Cache successful response
      this.cache.set(cacheKey, {
        data: json.data,
        timestamp: json._freshness,
      });

      return json;
    } catch (error) {
      clearTimeout(timer);
      this.logError(url, error);

      // Return cached data if available
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return {
          data: cached.data as T,
          _freshness: cached.timestamp,
          _stale: true,
        };
      }

      // No cache — return empty with stale marker
      return {
        data: null as T,
        _freshness: new Date().toISOString(),
        _stale: true,
      };
    }
  }

  /**
   * Strict request for writes: errors are surfaced, not swallowed.
   */
  private async requestStrict<T>(
    url: string,
    init: RequestInit,
  ): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => 'unknown error');
        // Parse error JSON if possible
        let errorMessage: string;
        try {
          const parsed = JSON.parse(errorBody);
          errorMessage = parsed.error ?? errorBody;
        } catch {
          errorMessage = errorBody;
        }
        return {
          data: null as T,
          _freshness: new Date().toISOString(),
          _error: `HTTP ${response.status}: ${errorMessage}`,
        };
      }

      const json = (await response.json()) as ApiResponse<T>;

      // Successful writes change the source of truth, so stale read fallbacks
      // should not survive into subsequent tool calls.
      this.cache.clear();

      return json;
    } catch (error) {
      clearTimeout(timer);
      this.logError(url, error);
      const message = error instanceof Error ? error.message : String(error);
      return {
        data: null as T,
        _freshness: new Date().toISOString(),
        _error: `Request failed: ${message}`,
      };
    }
  }

  private logError(url: string, error: unknown): void {
    try {
      if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
      }
      const message =
        error instanceof Error ? error.message : String(error);
      const line = `[${new Date().toISOString()}] ${url} — ${message}\n`;
      appendFileSync(LOG_FILE, line);
    } catch {
      // Logging should never break the MCP server
    }
  }
}
