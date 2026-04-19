import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatResponse } from '../format.js';
import type { ReadProvider } from '../read-provider.js';

export function registerReadTools(
  server: McpServer,
  provider: ReadProvider,
): void {
  server.registerTool(
    'get_project_context',
    {
      description:
        'Call this FIRST at the START of every coding session. Returns a summary of the entire project: domains, features, their statuses, recent decisions, and open conflicts. Use this to orient yourself before writing any code. If you need detail on a specific feature, follow up with get_feature_context.',
    },
    async () => {
      const response = await provider.getProjectContext();
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
            'The slug of the feature to get context for. This may be an adapter-defined composite slug (for example "web--authentication" or "mcp-server--context-delivery"). Discover exact slugs via get_project_context() or get_file_context().',
          ),
        component_slug: z
          .string()
          .optional()
          .describe('Optional component slug to filter to a specific component'),
      },
    },
    async ({ feature_slug, component_slug }) => {
      const response = await provider.getFeatureContext({
        featureSlug: feature_slug,
        componentSlug: component_slug,
      });
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
            'Optional feature slug to filter decisions. This may be an adapter-defined composite slug (for example "web--authentication" or "mcp-server--context-delivery").',
          ),
      },
    },
    async ({ limit, feature_slug }) => {
      const response = await provider.getDecisionLog({
        limit,
        featureSlug: feature_slug,
      });
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
      const response = await provider.getConflicts();
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
      const response = await provider.getFileContext({ filepath });
      return formatResponse(response);
    },
  );
}
