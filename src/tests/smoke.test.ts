import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VibeCompassClient } from '../api-client.js';
import { formatError, formatResponse } from '../format.js';
import { LocalReadProvider } from '../providers/local-read.js';
import type { ReadProvider } from '../read-provider.js';
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
  const readCalls: Array<{ method: string; payload?: Record<string, unknown> }> = [];
  const writeCalls: Array<{
    method: 'post' | 'patch';
    path: string;
    payload?: Record<string, unknown>;
  }> = [];

  const readProvider: ReadProvider = {
    async getProjectContext() {
      readCalls.push({ method: 'getProjectContext' });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
    async getFeatureContext(payload) {
      readCalls.push({ method: 'getFeatureContext', payload });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
    async getDecisionLog(payload) {
      readCalls.push({ method: 'getDecisionLog', payload });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
    async getConflicts() {
      readCalls.push({ method: 'getConflicts' });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
    async getFileContext(payload) {
      readCalls.push({ method: 'getFileContext', payload });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
  };

  const writeClient = {
    async post(path: string, payload: Record<string, unknown>) {
      writeCalls.push({ method: 'post', path, payload });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
    async patch(path: string, payload: Record<string, unknown>) {
      writeCalls.push({ method: 'patch', path, payload });
      return { data: { ok: true }, _freshness: '2026-04-12T00:00:00.000Z' };
    },
  } as unknown as VibeCompassClient;

  registerReadTools(server, readProvider);
  registerWriteTools(server, writeClient);

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

  assert.deepEqual(readCalls, [
    {
      method: 'getFileContext',
      payload: { filepath: 'src/lib/auth.ts' },
    },
  ]);

  assert.deepEqual(writeCalls, [
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

test('local read provider serves project and file context from the local root', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-mcp-local-'));

  try {
    await mkdir(path.join(rootDir, 'architecture/mcp-server/context-delivery'), {
      recursive: true,
    });
    await mkdir(path.join(rootDir, 'decisions'), { recursive: true });
    await mkdir(path.join(rootDir, 'sessions'), { recursive: true });
    await mkdir(path.join(rootDir, 'state'), { recursive: true });

    await writeFile(
      path.join(rootDir, 'project.yaml'),
      [
        'format_version: 1',
        'name: Local MCP',
        'mode: local-only',
        'repos:',
        '  - id: mcp',
        '    remote: https://github.com/example/vibecompass-mcp.git',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(rootDir, '.gitignore'),
      'state/\n',
      'utf8',
    );
    await writeFile(
      path.join(rootDir, 'architecture/mcp-server/context-delivery/read-tools.md'),
      [
        '---',
        'domain: MCP Server',
        'feature: Context Delivery',
        'component: Read Tools',
        'status: Complete',
        'repo: mcp',
        '---',
        '',
        '## Description',
        'Local read tools.',
        '',
        '## Details',
        'Details.',
        '',
        '## Next steps',
        '- None.',
        '',
        '## Involved files',
        '- `src/tools/read.ts`',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(rootDir, 'decisions/cross-cutting.md'),
      [
        '### D-159 — Local file-backed query logic lives in vibecompass',
        '**Timestamp:** 2026-04-19 13:10 PDT',
        '**Decision:** Keep local reads in the core package.',
        '**Rationale:** MCP is an adapter.',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(rootDir, 'sessions/2026-04-19-1-local-mcp.md'),
      [
        '# Session — 2026-04-19-1 — Local MCP',
        '',
        '## What we worked on',
        'Local reads.',
        '',
        '## Completed',
        '- Added local reads.',
        '',
        '## Decisions made',
        '- D-159',
        '',
        '## Models used',
        '- Codex',
        '',
        '## Blockers / open questions',
        '- None.',
        '',
        '## Next session should start with',
        '- Wire MCP.',
        '',
      ].join('\n'),
      'utf8',
    );

    const provider = new LocalReadProvider(rootDir);

    const projectContext = await provider.getProjectContext();
    const featureContext = await provider.getFeatureContext({
      featureSlug: 'mcp-server--context-delivery',
    });
    const decisionLog = await provider.getDecisionLog({ limit: 5 });
    const conflicts = await provider.getConflicts();
    const fileContext = await provider.getFileContext({
      filepath: 'mcp:src/tools/read.ts',
    });

    assert.equal((projectContext.data as { project: { name: string } }).project.name, 'Local MCP');
    assert.equal((projectContext.data as { domains: unknown[] }).domains.length, 1);
    assert.equal(
      (
        featureContext.data as {
          feature: { feature_slug: string; components: Array<{ component_key: string }> };
        }
      ).feature.feature_slug,
      'mcp-server--context-delivery',
    );
    assert.equal(
      (
        featureContext.data as {
          feature: { feature_slug: string; components: Array<{ component_key: string }> };
        }
      ).feature.components[0].component_key,
      'read-tools',
    );
    assert.equal(
      (decisionLog.data as { decisions: Array<{ decision_id: number }> }).decisions[0].decision_id,
      159,
    );
    assert.deepEqual((conflicts.data as { conflicts: unknown[] }).conflicts, []);
    assert.match(
      (conflicts.data as { _note: string })._note,
      /not available from the local root/,
    );
    assert.equal(
      (fileContext.data as { owners: Array<{ feature_slug: string }> }).owners[0].feature_slug,
      'mcp-server--context-delivery',
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('local read provider reuses the read model until the root signature changes', async () => {
  let signature = {
    contentFingerprint: 'sig-1',
    stateManifestHash: 'manifest-1',
  };
  let loadCount = 0;

  const provider = new LocalReadProvider('/virtual/root', undefined, {
    async coreModuleLoader() {
      return {
        async loadProjectReadModel() {
          loadCount += 1;

          return {
            freshness: `fresh-${loadCount}`,
            manifest_state: { manifest_hash: `scan-${loadCount}` },
            features: [],
          };
        },
        getProjectContext() {
          return {
            project: { name: `Project ${loadCount}` },
            domains: [],
            recent_decisions: [],
            recent_sessions: [],
            warning_summary: { total: 0, by_code: [] },
            manifest_state: { manifest_hash: `scan-${loadCount}` },
          };
        },
        getFeatureContext() {
          return null;
        },
        getDecisionLog() {
          return { decisions: [] };
        },
        getFileContext() {
          return { owners: [], path: 'virtual:file' };
        },
      };
    },
    async rootSignatureLoader() {
      return signature;
    },
  });

  const first = await provider.getProjectContext();
  const second = await provider.getProjectContext();

  assert.equal(loadCount, 1);
  assert.equal(
    (first.data as { project: { name: string } }).project.name,
    'Project 1',
  );
  assert.equal(
    (second.data as { project: { name: string } }).project.name,
    'Project 1',
  );

  signature = {
    contentFingerprint: 'sig-2',
    stateManifestHash: 'manifest-1',
  };

  const afterContentChange = await provider.getProjectContext();

  assert.equal(loadCount, 2);
  assert.equal(
    (afterContentChange.data as { project: { name: string } }).project.name,
    'Project 2',
  );

  signature = {
    contentFingerprint: 'sig-2',
    stateManifestHash: 'manifest-2',
  };

  const afterManifestChange = await provider.getProjectContext();

  assert.equal(loadCount, 3);
  assert.equal(
    (afterManifestChange.data as { project: { name: string } }).project.name,
    'Project 3',
  );
});
