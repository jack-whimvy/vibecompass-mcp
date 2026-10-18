#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, resolveServerMode } from './server.js';

function main(): void {
  const config = {
    apiKey: process.env.VIBECOMPASS_API_KEY,
    apiUrl: process.env.VIBECOMPASS_API_URL,
    rootDir: process.env.VIBECOMPASS_ROOT,
  };

  if (!resolveServerMode(config)) {
    process.stderr.write(
      'Error: set VIBECOMPASS_API_KEY for hosted mode or VIBECOMPASS_ROOT for local mode.\n',
    );
    process.exit(1);
  }

  const { server, mode } = createServer(config);

  if (mode === 'local') {
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
