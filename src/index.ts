#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { VibeCompassClient } from './api-client.js';
import { registerReadTools } from './tools/read.js';
import { registerWriteTools } from './tools/write.js';

const VERSION = '0.1.0';

function main(): void {
  const apiKey = process.env.VIBECOMPASS_API_KEY;
  const apiUrl = process.env.VIBECOMPASS_API_URL;

  if (!apiKey) {
    process.stderr.write(
      'Error: VIBECOMPASS_API_KEY environment variable is required.\n' +
        'Get your API key from the VibeCompass dashboard: Settings → API Keys\n',
    );
    process.exit(1);
  }

  const client = new VibeCompassClient({
    apiKey,
    baseUrl: apiUrl,
  });

  const server = new McpServer({
    name: 'vibecompass',
    version: VERSION,
  });

  registerReadTools(server, client);
  registerWriteTools(server, client);

  const transport = new StdioServerTransport();
  server.connect(transport).catch((error) => {
    process.stderr.write(`Failed to start MCP server: ${error}\n`);
    process.exit(1);
  });
}

main();
