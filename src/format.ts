import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

interface ApiResponse {
  data: unknown;
  _freshness: string;
  _stale?: boolean;
  _error?: string;
}

/**
 * Format an API response as MCP tool result.
 * If _error is present (write failure), returns isError: true.
 * If _stale is present (read fallback), shows a warning but not an error.
 */
export function formatResponse(response: ApiResponse): CallToolResult {
  // Write failures — surface as a real error
  if (response._error) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Error: ${response._error}` }],
    };
  }

  const lines: string[] = [];

  if (response._stale) {
    lines.push(
      `[WARNING: This data may be stale. Last fetched: ${response._freshness}. The VibeCompass API was unreachable.]\n`,
    );
  }

  if (response.data === null) {
    lines.push('No data available.');
  } else {
    lines.push(JSON.stringify(response.data, null, 2));
  }

  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  };
}

/**
 * Format an error as MCP tool result. isError is at the CallToolResult level
 * per the MCP spec, not inside individual content blocks.
 */
export function formatError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
  };
}
