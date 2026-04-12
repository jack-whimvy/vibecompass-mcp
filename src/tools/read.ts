import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VibeCompassClient } from '../api-client.js';
import { formatResponse } from '../format.js';

export function registerReadTools(
  server: McpServer,
  client: VibeCompassClient,
): void {
  server.registerTool(
    'get_project_context',
    {
      description:
        'Call this FIRST at the START of every coding session. Returns a summary of the entire project: domains, features, their statuses, recent decisions, and open conflicts. Use this to orient yourself before writing any code. If you need detail on a specific feature, follow up with get_feature_context.',
    },
    async () => {
      const response = await client.get('/api/mcp/context');
      return formatResponse(response);
    },
  );

  server.registerTool(
    'get_feature_context',
    {
      description:
        'Get FULL details for a specific feature before working on it. Returns description, components, involved files, repo ownership, recent decisions, and open conflicts for that feature. Always call this before modifying code that belongs to a feature.',
      inputSchema: {
        feature_slug: z
          .string()
          .describe(
            'The slug of the feature to get context for. In repo-local multi-repo projects this may be repo-prefixed (for example "web--authentication"). Discover exact slugs via get_project_context() or get_file_context().',
          ),
        component_slug: z
          .string()
          .optional()
          .describe('Optional component slug to filter to a specific component'),
      },
    },
    async ({ feature_slug, component_slug }) => {
      const params: Record<string, string | undefined> = {};
      if (component_slug) params.component = component_slug;
      const response = await client.get(
        `/api/mcp/features/${encodeURIComponent(feature_slug)}`,
        params,
      );
      return formatResponse(response);
    },
  );

  server.registerTool(
    'get_decision_log',
    {
      description:
        'Check past architectural decisions before proposing changes. Prevents re-debating settled decisions. Call this when you are unsure why something was built a certain way, or before making a significant architectural choice.',
      inputSchema: {
        limit: z
          .number()
          .optional()
          .default(20)
          .describe('Maximum number of decisions to return (default 20, max 100)'),
        feature_slug: z
          .string()
          .optional()
          .describe(
            'Optional feature slug to filter decisions. In repo-local multi-repo projects this may be repo-prefixed (for example "web--authentication").',
          ),
      },
    },
    async ({ limit, feature_slug }) => {
      const params: Record<string, string | undefined> = {
        limit: String(limit),
        feature_slug,
      };
      const response = await client.get('/api/mcp/decisions', params);
      return formatResponse(response);
    },
  );

  server.registerTool(
    'get_conflicts',
    {
      description:
        'Check for open conflicts before starting work. Conflicts indicate areas where code changes contradicted prior decisions or where patterns collided. You MUST check conflicts before modifying affected features.',
    },
    async () => {
      const response = await client.get('/api/mcp/conflicts');
      return formatResponse(response);
    },
  );

  server.registerTool(
    'get_file_context',
    {
      description:
        'Before modifying any file, call this to understand which feature and component owns it. This prevents accidental cross-feature changes and helps you stay within the right domain. For multi-repo projects, pass file paths in repo:path form (for example "web:src/app/page.tsx").',
      inputSchema: {
        filepath: z
          .string()
          .describe(
            'The file path to inspect. Use repo:path for multi-repo projects (for example web:src/lib/auth.ts); single-repo projects can use repo-root-relative paths.',
          ),
      },
    },
    async ({ filepath }) => {
      // Send filepath as query param to avoid URL encoding issues with slashes
      const response = await client.get('/api/mcp/files', { path: filepath });
      return formatResponse(response);
    },
  );
}
