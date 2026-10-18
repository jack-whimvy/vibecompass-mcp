import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VibeCompassClient } from './api-client.js';
import { HostedReadProvider } from './providers/hosted-read.js';
import { LocalReadProvider } from './providers/local-read.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

export type ServerMode = 'hosted' | 'local' | 'hybrid';

export interface ServerConfig {
  apiKey?: string;
  apiUrl?: string;
  rootDir?: string;
}

// dist/server.js and src/server.ts both sit one level below package.json.
export const PACKAGE_VERSION = readPackageVersion();

const TOOLS_INSTRUCTIONS =
  'VibeCompass serves this project\'s memory: architecture docs organized as domains, features, and components; decisions; and session notes. Call get_project_context for an overview, get_feature_context before changing a feature, get_file_context to see which feature owns a file, and get_decision_log before revisiting a past decision. Responses are bounded summaries.';
const LOCAL_SOURCE_INSTRUCTIONS =
  'They are read from the local project-memory files at VIBECOMPASS_ROOT, which are the source of truth: when a response is shortened or you need the full text, read those files.';
const HYBRID_HOSTED_INSTRUCTIONS =
  'Conflicts, pending proposals, and write tools use the hosted project; writes never change the local files.';
const HOSTED_SOURCE_INSTRUCTIONS =
  'They are read from the hosted VibeCompass project. When the project keeps local project-memory files, those files are the source of truth and the hosted project is a copy pushed from them.';

export function resolveServerMode(config: ServerConfig): ServerMode | null {
  if (config.rootDir) {
    return config.apiKey ? 'hybrid' : 'local';
  }

  return config.apiKey ? 'hosted' : null;
}

export function serverInstructions(mode: ServerMode): string {
  switch (mode) {
    case 'local':
      return `${TOOLS_INSTRUCTIONS} ${LOCAL_SOURCE_INSTRUCTIONS}`;
    case 'hybrid':
      return `${TOOLS_INSTRUCTIONS} ${LOCAL_SOURCE_INSTRUCTIONS} ${HYBRID_HOSTED_INSTRUCTIONS}`;
    case 'hosted':
      return `${TOOLS_INSTRUCTIONS} ${HOSTED_SOURCE_INSTRUCTIONS}`;
  }
}

/**
 * Build the MCP server for the mode the config selects (D-177): read tools in
 * every mode, write tools only with an API key (D-178).
 */
export function createServer(config: ServerConfig): {
  server: McpServer;
  mode: ServerMode;
} {
  const mode = resolveServerMode(config);
  if (!mode) {
    throw new Error(
      'Set VIBECOMPASS_API_KEY for hosted mode or VIBECOMPASS_ROOT for local mode.',
    );
  }

  const client = config.apiKey
    ? new VibeCompassClient({
        apiKey: config.apiKey,
        baseUrl: config.apiUrl,
      })
    : null;

  const server = new McpServer(
    {
      name: 'vibecompass',
      version: PACKAGE_VERSION,
    },
    {
      instructions: serverInstructions(mode),
    },
  );

  const readProvider = config.rootDir
    ? new LocalReadProvider(config.rootDir, client ?? undefined)
    : new HostedReadProvider(client as VibeCompassClient);

  registerReadTools(server, readProvider);

  if (client) {
    registerWriteTools(server, client);
  }

  return { server, mode };
}

function readPackageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };

  if (typeof manifest.version !== 'string') {
    throw new Error('vibecompass-mcp package.json has no version.');
  }

  return manifest.version;
}
