import type { ApiResponse } from './api-client.js';

export interface ReadProvider {
  getProjectContext(): Promise<ApiResponse>;
  getFeatureContext(input: {
    featureSlug: string;
    componentSlug?: string;
  }): Promise<ApiResponse>;
  getDecisionLog(input: {
    limit: number;
    featureSlug?: string;
  }): Promise<ApiResponse>;
  getConflicts(): Promise<ApiResponse>;
  getFileContext(input: {
    filepath: string;
  }): Promise<ApiResponse>;
}
