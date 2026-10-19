import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BriefResponse } from '../providers/brief-build.js';
import {
  BRIEF_DISABLED_NOTE,
  BRIEF_FAILED_NOTE,
  BRIEF_MAX_BUDGET,
  BRIEF_MIN_BUDGET,
  type BriefProvider,
} from '../providers/local-brief.js';

// Input bounds keep the echoed inputs from crowding the metadata block's
// hard cap. They are adapter limits; the engine itself is unchanged (D-386).
const TASK_MAX_CHARS = 1_000;
const PATH_MAX_CHARS = 300;
const LIST_MAX_ITEMS = 20;
const FEATURE_SLUG_MAX_ITEMS = 10;
const LANE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

// A starting point, never a default first call (D-386; session 26, S1). The
// server instructions do not name this tool.
export const GET_BRIEF_DESCRIPTION =
  'Build a session brief for a task from this project\'s local memory: excerpts of the architecture docs, decisions, and session notes that match the task, packed into a token budget, with a status (complete, partial, incomplete, or no-match) and the follow-up reads that did not fit. The brief is a starting point, not the whole context: its excerpts are cut, and keyword and citation matching can miss the doc a task depends on. Read the full source behind any fact you rely on, and search memory beyond the brief. Returns the brief as markdown, then its metadata as JSON with units as references. Read-only. It never infers a session lane; pass lane_id to include one.';

/**
 * Registered only on a local root that opts in (D-386); server.ts decides.
 */
export function registerBriefTool(server: McpServer, provider: BriefProvider): void {
  server.registerTool(
    'get_brief',
    {
      description: GET_BRIEF_DESCRIPTION,
      inputSchema: {
        task: z
          .string()
          .trim()
          .min(1)
          .max(TASK_MAX_CHARS)
          .describe('The task, in a sentence or two. The brief selects memory that matches these words.'),
        files: z
          .array(z.string().min(1).max(PATH_MAX_CHARS))
          .max(LIST_MAX_ITEMS)
          .optional()
          .describe('Files the task touches, in repo:path form (for example "mcp:src/server.ts").'),
        feature_slugs: z
          .array(z.string().min(1).max(PATH_MAX_CHARS))
          .max(FEATURE_SLUG_MAX_ITEMS)
          .optional()
          .describe('Feature slugs the task concerns, as get_project_context lists them (for example "mcp-server--context-delivery").'),
        claims: z
          .array(z.string().min(1).max(PATH_MAX_CHARS))
          .max(LIST_MAX_ITEMS)
          .optional()
          .describe('Paths the task claims, in repo:path form.'),
        budget: z
          .number()
          .int()
          .min(BRIEF_MIN_BUDGET)
          .max(BRIEF_MAX_BUDGET)
          .optional()
          .describe(`Estimated-token budget for the markdown brief, a whole number from ${BRIEF_MIN_BUDGET} to ${BRIEF_MAX_BUDGET} (default ${BRIEF_MAX_BUDGET}).`),
        lane_id: z
          .string()
          .regex(LANE_ID_PATTERN)
          .optional()
          .describe('An active session lane\'s id, to include its working-on line and handoff. Optional: without it the brief has no lane.'),
      },
    },
    async ({ task, files, feature_slugs, claims, budget, lane_id }) => {
      const response = await provider.getBrief({
        task,
        files,
        featureSlugs: feature_slugs,
        claims,
        budget,
        laneId: lane_id,
      });
      return formatBriefResponse(response);
    },
  );
}

/**
 * Two text blocks for a brief: the rendered markdown, unchanged and bounded
 * by the brief's own budget, then the metadata block, which passes the hard
 * cap (D-385, D-386). The metadata is compact JSON, so the characters sent
 * are the ones the hard cap's estimate counts.
 */
export function formatBriefResponse(response: BriefResponse): CallToolResult {
  switch (response.kind) {
    case 'brief':
      return {
        content: [
          { type: 'text' as const, text: response.markdown },
          { type: 'text' as const, text: JSON.stringify(response.metadata) },
        ],
      };
    case 'disabled':
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { _note: BRIEF_DISABLED_NOTE, brief: null, settings_problems: response.problems },
              null,
              2,
            ),
          },
        ],
      };
    case 'failed':
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Error: get_brief could not build a brief (${response.reason}). ${BRIEF_FAILED_NOTE}`,
          },
        ],
      };
  }
}
