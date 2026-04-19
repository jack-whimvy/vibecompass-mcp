#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VibeCompassClient } from './api-client.js';
import { HostedReadProvider } from './providers/hosted-read.js';
import { LocalReadProvider } from './providers/local-read.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

const VERSION = '0.1.0';

function main(): void {
  const apiKey = process.env.VIBECOMPASS_API_KEY;
  const apiUrl = process.env.VIBECOMPASS_API_URL;
  const rootDir = process.env.VIBECOMPASS_ROOT;

  if (!apiKey && !rootDir) {
    process.stderr.write(
      'Error: set VIBECOMPASS_API_KEY for hosted mode or VIBECOMPASS_ROOT for local mode.\n',
    );
    process.exit(1);
  }

  const client = apiKey
    ? new VibeCompassClient({
        apiKey,
        baseUrl: apiUrl,
      })
    : null;

  const server = new McpServer({
    name: 'vibecompass',
    version: VERSION,
  });

  const readProvider = rootDir
    ? new LocalReadProvider(rootDir, client ?? undefined)
    : new HostedReadProvider(client as VibeCompassClient);

  registerReadTools(server, readProvider);

  if (client) {
    registerWriteTools(server, client);
  } else {
    process.stderr.write(
      'Warning: write tools are disabled in local mode until local write flows are implemented.\n',
    );
  }

  const transport = new StdioServerTransport();
  server.connect(transport).catch((error) => {
    process.stderr.write(`Failed to start MCP server: ${error}\n`);
    process.exit(1);
  });
}

main();
