import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VibeCompassClient } from '../api-client.js';
import { formatResponse } from '../format.js';

export function registerWriteTools(
  server: McpServer,
  client: VibeCompassClient,
): void {
  server.registerTool(
    'log_decision',
    {
      description:
        'Log EVERY significant architectural decision you make during this session. This creates a permanent record that future sessions will read. If you chose between two approaches, log why. If you changed an existing pattern, explain the reasoning. Future sessions depend on this.',
      inputSchema: {
        feature_slug: z
          .string()
          .min(1)
          .describe('The slug of the feature this decision relates to'),
        title: z
          .string()
          .min(1)
          .max(200)
          .describe('A short title for the decision (e.g. "Use Redis for session cache")'),
        description: z
          .string()
          .min(1)
          .max(5000)
          .describe(
            'Full description including rationale, alternatives considered, and why this was chosen',
          ),
      },
    },
    async ({ feature_slug, title, description }) => {
      const response = await client.post('/api/mcp/decisions', {
        feature_slug,
        title,
        description,
      });
      return formatResponse(response);
    },
  );

  server.registerTool(
    'update_feature_status',
    {
      description:
        'Update a feature\'s status when you make progress. Mark "in_progress" when you start working on it, "complete" when done, "blocked" if stuck. This keeps the project brain accurate for the next session.',
      inputSchema: {
        feature_slug: z.string().min(1).describe('The slug of the feature to update'),
        status: z
          .enum(['draft', 'in_progress', 'complete', 'blocked', 'deprecated'])
          .describe('The new status'),
        notes: z
          .string()
          .max(2000)
          .optional()
          .describe('Optional notes about the status change (appended to next steps)'),
      },
    },
    async ({ feature_slug, status, notes }) => {
      const response = await client.patch(
        `/api/mcp/features/${encodeURIComponent(feature_slug)}/status`,
        { status, notes },
      );
      return formatResponse(response);
    },
  );

  server.registerTool(
    'flag_conflict',
    {
      description:
        'Flag a conflict when you notice contradictory patterns, duplicated logic across features, or disagreement with a past decision. Conflicts are surfaced to the developer in the dashboard for resolution. Do not try to auto-resolve conflicts — flag them and move on.',
      inputSchema: {
        feature_slug: z
          .string()
          .min(1)
          .describe('The slug of the feature where the conflict was found'),
        description: z
          .string()
          .min(1)
          .max(5000)
          .describe(
            'Clear description of the conflict: what contradicts what, and why it matters',
          ),
      },
    },
    async ({ feature_slug, description }) => {
      const response = await client.post('/api/mcp/conflicts', {
        feature_slug,
        description,
      });
      return formatResponse(response);
    },
  );

  server.registerTool(
    'add_session_summary',
    {
      description:
        'Call this at the END of every coding session. Summarize what you accomplished, what is left to do, and any blockers. List all features you touched. The next AI session will read this summary to continue where you left off.',
      inputSchema: {
        summary: z
          .string()
          .min(1)
          .max(10000)
          .describe(
            'Summary of the session: what was done, what is remaining, any blockers or open questions',
          ),
        features_touched: z
          .array(z.string().min(1))
          .min(1)
          .describe('Array of feature slugs that were worked on in this session'),
      },
    },
    async ({ summary, features_touched }) => {
      const response = await client.post('/api/mcp/sessions', {
        summary,
        features_touched,
      });
      return formatResponse(response);
    },
  );
}
