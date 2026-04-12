import assert from 'node:assert/strict';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VibeCompassClient } from '../api-client.js';
import { formatError, formatResponse } from '../format.js';
import { registerReadTools } from '../tools/read.js';
import { registerWriteTools } from '../tools/write.js';

interface RegisteredTool {
  config: unknown;
  handler: (input?: Record<string, unknown>) => Promise<unknown>;
}

function getFirstText(result: { content?: Array<{ type: string; text?: string }> }) {
  const first = result.content?.[0];
  return first?.type === 'text' ? first.text ?? '' : '';
}

function createFakeServer(registry: Map<string, RegisteredTool>): McpServer {
  return {
    registerTool(
      name: string,
      config: unknown,
      handler: (input?: Record<string, unknown>) => Promise<unknown>,
    ) {
      registry.set(name, { config, handler });
    },
  } as unknown as McpServer;
}

test('format helpers surface stale data and hard errors correctly', () => {
  const stale = formatResponse({
    data: { ok: true },
    _freshness: '2026-04-12T00:00:00.000Z',
    _stale: true,
  });

  assert.equal(stale.isError, undefined);
  assert.match(getFirstText(stale), /WARNING: This data may be stale/);
  assert.match(getFirstText(stale), /"ok": true/);

  const error = formatResponse({
    data: null,
    _freshness: '2026-04-12T00:00:00.000Z',
    _error: 'HTTP 500: boom',
  });

  assert.equal(error.isError, true);
  assert.equal(getFirstText(error), 'Error: HTTP 500: boom');
  assert.equal(getFirstText(formatError('bad input')), 'Error: bad input');
});

test('API client falls back to cache on read failure and clears cache after writes', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = (async () => {
    callCount += 1;

    if (callCount === 1) {
      return new Response(
        JSON.stringify({
          data: { source: 'fresh' },
          _freshness: '2026-04-12T00:00:00.000Z',
        }),
        { status: 200 },
      );
    }

    if (callCount === 2) {
      throw new Error('temporary outage');
    }

    if (callCount === 3) {
      return new Response(
        JSON.stringify({
          data: { saved: true },
          _freshness: '2026-04-12T00:01:00.000Z',
        }),
        { status: 200 },
      );
    }

    throw new Error('still down');
  }) as typeof fetch;

  try {
    const client = new VibeCompassClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
    });

    const fresh = await client.get('/api/mcp/context');
    assert.deepEqual(fresh.data, { source: 'fresh' });
    assert.equal(fresh._stale, undefined);

    const cached = await client.get('/api/mcp/context');
    assert.equal(cached._stale, true);
    assert.deepEqual(cached.data, { source: 'fresh' });

    const write = await client.post('/api/mcp/decisions', {
      title: 'Ship it',
    });
    assert.equal(write._error, undefined);

    const afterWriteFailure = await client.get('/api/mcp/context');
    assert.equal(afterWriteFailure._stale, true);
    assert.equal(afterWriteFailure.data, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('read and write tool registries expose the expected tool surface', async () => {
  const tools = new Map<string, RegisteredTool>();
  const server = createFakeServer(tools);
  const calls: Array<{
    method: 'get' | 'post' | 'patch';
    path: string;
    payload?: Record<string, unknown>;
  }> = [];

  const client = {
    async get(path: string, payload?: Record<string, unknown>) {
      calls.push({ method: 'get', path, payload });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
    async post(path: string, payload: Record<string, unknown>) {
      calls.push({ method: 'post', path, payload });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
    async patch(path: string, payload: Record<string, unknown>) {
      calls.push({ method: 'patch', path, payload });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
  } as unknown as VibeCompassClient;

  registerReadTools(server, client);
  registerWriteTools(server, client);

  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      'add_session_summary',
      'flag_conflict',
      'get_conflicts',
      'get_decision_log',
      'get_feature_context',
      'get_file_context',
      'get_project_context',
      'log_decision',
      'update_feature_status',
    ].sort(),
  );

  await tools.get('get_file_context')?.handler({ filepath: 'src/lib/auth.ts' });
  await tools.get('update_feature_status')?.handler({
    feature_slug: 'auth',
    status: 'complete',
    notes: 'done',
  });
  await tools.get('add_session_summary')?.handler({
    summary: 'Wrapped up the auth pass',
    features_touched: ['auth'],
  });

  assert.deepEqual(calls, [
    {
      method: 'get',
      path: '/api/mcp/files',
      payload: { path: 'src/lib/auth.ts' },
    },
    {
      method: 'patch',
      path: '/api/mcp/features/auth/status',
      payload: { status: 'complete', notes: 'done' },
    },
    {
      method: 'post',
      path: '/api/mcp/sessions',
      payload: {
        summary: 'Wrapped up the auth pass',
        features_touched: ['auth'],
      },
    },
  ]);
});
