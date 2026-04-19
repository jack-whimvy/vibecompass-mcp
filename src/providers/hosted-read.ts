import type { ApiResponse, VibeCompassClient } from '../api-client.js';
import type { ReadProvider } from '../read-provider.js';

export class HostedReadProvider implements ReadProvider {
  constructor(private readonly client: VibeCompassClient) {}

  getProjectContext(): Promise<ApiResponse> {
    return this.client.get('/api/mcp/context');
  }

  getFeatureContext(input: {
    featureSlug: string;
    componentSlug?: string;
  }): Promise<ApiResponse> {
    const params: Record<string, string | undefined> = {};
    if (input.componentSlug) {
      params.component = input.componentSlug;
    }

    return this.client.get(
      `/api/mcp/features/${encodeURIComponent(input.featureSlug)}`,
      params,
    );
  }

  getDecisionLog(input: {
    limit: number;
    featureSlug?: string;
  }): Promise<ApiResponse> {
    return this.client.get('/api/mcp/decisions', {
      limit: String(input.limit),
      feature_slug: input.featureSlug,
    });
  }

  getConflicts(): Promise<ApiResponse> {
    return this.client.get('/api/mcp/conflicts');
  }

  getFileContext(input: { filepath: string }): Promise<ApiResponse> {
    return this.client.get('/api/mcp/files', { path: input.filepath });
  }
}
