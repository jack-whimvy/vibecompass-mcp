import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VibeCompassClient } from '../api-client.js';
import { formatError, formatResponse } from '../format.js';
import { HostedReadProvider } from '../providers/hosted-read.js';
import { LocalReadProvider } from '../providers/local-read.js';
import type { ReadProvider } from '../read-provider.js';
import {
  PACKAGE_VERSION,
  createServer,
  resolveServerMode,
  serverInstructions,
  type ServerConfig,
  type ServerMode,
} from '../server.js';
import { registerReadTools } from '../tools/read.js';
import { registerWriteTools } from '../tools/write.js';

const READ_TOOLS = [
  'get_conflicts',
  'get_decision_log',
  'get_feature_context',
  'get_file_context',
  'get_project_context',
  'list_pending_proposals',
];
const WRITE_TOOLS = [
  'add_session_summary',
  'flag_conflict',
  'log_decision',
  'update_feature_status',
];

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

function assertHostedDecisionRowShape(row: Record<string, unknown>) {
  assert.equal(typeof row.decisionNumber, 'number');
  assert.equal(typeof row.title, 'string');
  assert.equal(typeof row.description, 'string');
  assert.match(
    String(row.createdAt),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/,
  );

  if ('source' in row) {
    assert.match(String(row.source), /^(mcp|scan|manual|pipeline)$/);
  }
}

async function assertToolDoesNotThrow(
  tool: RegisteredTool | undefined,
  input?: Record<string, unknown>,
): Promise<string> {
  assert.ok(tool);
  const result = await tool.handler(input) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  assert.equal(result.isError, undefined);
  assert.ok(result.content?.length);
  const firstText = getFirstText(result);
  assert.notEqual(firstText, '');
  return firstText;
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

test('API client read timeout returns cached fallback without crashing', async (t) => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  t.mock.timers.enable({ apis: ['setTimeout'] });

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
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

    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }) as typeof fetch;

  try {
    const client = new VibeCompassClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.com',
    });

    await client.get('/api/mcp/context');

    const timedOutPromise = client.get('/api/mcp/context');
    t.mock.timers.tick(5_000);
    const timedOut = await timedOutPromise;

    assert.equal(timedOut._stale, true);
    assert.deepEqual(timedOut.data, { source: 'fresh' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('hosted read tools return stale results instead of tool errors when the API is down', async () => {
  const originalFetch = globalThis.fetch;
  const tools = new Map<string, RegisteredTool>();
  const server = createFakeServer(tools);

  globalThis.fetch = (async () => {
    throw new Error('hosted API unavailable');
  }) as typeof fetch;

  try {
    registerReadTools(
      server,
      new HostedReadProvider(
        new VibeCompassClient({
          apiKey: 'test-key',
          baseUrl: 'https://example.com',
        }),
      ),
    );

    const projectContext = await assertToolDoesNotThrow(
      tools.get('get_project_context'),
    );
    const featureContext = await assertToolDoesNotThrow(
      tools.get('get_feature_context'),
      { feature_slug: 'mcp-server--context-delivery' },
    );
    const decisions = await assertToolDoesNotThrow(
      tools.get('get_decision_log'),
      { limit: 5, feature_slug: 'mcp-server--context-delivery' },
    );
    const conflicts = await assertToolDoesNotThrow(tools.get('get_conflicts'));
    const fileContext = await assertToolDoesNotThrow(
      tools.get('get_file_context'),
      { filepath: 'mcp:src/tools/read.ts' },
    );

    for (const text of [
      projectContext,
      featureContext,
      decisions,
      conflicts,
      fileContext,
    ]) {
      assert.match(text, /WARNING: This data may be stale/);
      assert.match(text, /No data available/);
    }
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
    async listPendingProposals(payload) {
      readCalls.push({ method: 'listPendingProposals', payload });
      return { data: { proposals: [] }, _freshness: '2026-04-12T00:00:00.000Z' };
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
    [...READ_TOOLS, ...WRITE_TOOLS].sort(),
  );
  // The read registry never adds get_brief: createServer registers it
  // separately, and only on a local root that opts in (D-386).
  assert.equal(tools.has('get_brief'), false);

  await tools.get('get_file_context')?.handler({ filepath: 'src/lib/auth.ts' });
  await tools.get('list_pending_proposals')?.handler({ status: 'open' });
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
    {
      method: 'listPendingProposals',
      payload: { status: 'open' },
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

async function connectClient(config: ServerConfig) {
  const { server, mode } = await createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vibecompass-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server, mode };
}

test('each mode serves its tool surface, the package version, and its instructions over MCP', async (t) => {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  // A root that opts into the brief (D-386); '/virtual/root' has no
  // project.yaml, so it does not.
  const optedInRoot = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-mcp-brief-on-'));
  t.after(() => rm(optedInRoot, { recursive: true, force: true }));
  await writeFile(
    path.join(optedInRoot, 'project.yaml'),
    ['format_version: 1', 'name: Brief On', 'brief:', '  enabled: true', ''].join('\n'),
    'utf8',
  );
  const cases: Array<{ config: ServerConfig; mode: ServerMode; tools: string[] }> = [
    { config: { rootDir: '/virtual/root' }, mode: 'local', tools: READ_TOOLS },
    { config: { apiKey: 'test-key' }, mode: 'hosted', tools: [...READ_TOOLS, ...WRITE_TOOLS] },
    {
      config: { rootDir: '/virtual/root', apiKey: 'test-key' },
      mode: 'hybrid',
      tools: [...READ_TOOLS, ...WRITE_TOOLS],
    },
    { config: { rootDir: optedInRoot }, mode: 'local', tools: [...READ_TOOLS, 'get_brief'] },
    {
      config: { rootDir: optedInRoot, apiKey: 'test-key' },
      mode: 'hybrid',
      tools: [...READ_TOOLS, 'get_brief', ...WRITE_TOOLS],
    },
  ];

  assert.equal(PACKAGE_VERSION, manifest.version);

  for (const { config, mode, tools } of cases) {
    const { client, server, mode: resolved } = await connectClient(config);
    try {
      assert.equal(resolved, mode);
      const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(listed, [...tools].sort(), mode);
      // get_brief is listed only on a local root that opts in (D-386).
      assert.equal(listed.includes('get_brief'), tools.includes('get_brief'), mode);

      assert.deepEqual(client.getServerVersion(), {
        name: 'vibecompass',
        version: manifest.version,
      });

      const instructions = client.getInstructions() ?? '';
      assert.equal(instructions, serverInstructions(resolved));
      assert.match(instructions, /source of truth/);
      // Never, in any mode, on any root, opted in or not (D-385, D-386).
      assert.doesNotMatch(instructions, /brief/i);
      for (const tool of instructions.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) {
        assert.ok(listed.includes(tool), `${mode} instructions name ${tool}`);
      }
    } finally {
      await client.close();
      await server.close();
    }
  }

  assert.match(serverInstructions('local'), /local project-memory files at VIBECOMPASS_ROOT/);
  assert.match(serverInstructions('hybrid'), /writes never change the local files/);
  assert.match(serverInstructions('hosted'), /hosted VibeCompass project/);
  assert.equal(resolveServerMode({}), null);
  await assert.rejects(createServer({}), /VIBECOMPASS_API_KEY/);
});

test('every tool lists its inputs and their limits, and the server rejects a call past one', async (t) => {
  const optedInRoot = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-mcp-schemas-'));
  t.after(() => rm(optedInRoot, { recursive: true, force: true }));
  await writeFile(
    path.join(optedInRoot, 'project.yaml'),
    ['format_version: 1', 'name: Schemas', 'brief:', '  enabled: true', ''].join('\n'),
    'utf8',
  );
  // Hybrid on a root that opts in lists all eleven tools. The API URL refuses
  // connections, so a call that wrongly passed validation could not reach a server.
  const { client, server } = await connectClient({
    rootDir: optedInRoot,
    apiKey: 'test-key',
    apiUrl: 'http://127.0.0.1:9',
  });
  t.after(async () => {
    await client.close();
    await server.close();
  });

  // Drops the description annotations (tested elsewhere), not an input that is
  // named description, whose value is a schema object.
  const withoutDescriptions = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutDescriptions);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key, entry]) => !(key === 'description' && typeof entry === 'string'))
          .map(([key, entry]) => [key, withoutDescriptions(entry)]),
      );
    }
    return value;
  };
  const draft7 = 'http://json-schema.org/draft-07/schema#';
  const objectOf = (properties: Record<string, unknown>, required?: string[]) => ({
    $schema: draft7,
    type: 'object',
    properties,
    ...(required ? { required } : {}),
  });
  const text = (limits: Record<string, number> = {}) => ({ type: 'string', ...limits });
  const noInputs = { type: 'object', properties: {} };
  const expected: Record<string, unknown> = {
    get_project_context: noInputs,
    get_conflicts: noInputs,
    get_feature_context: objectOf({ feature_slug: text(), component_slug: text() }, ['feature_slug']),
    get_decision_log: objectOf({ limit: { type: 'number', default: 20 }, feature_slug: text() }),
    get_file_context: objectOf({ filepath: text() }, ['filepath']),
    list_pending_proposals: objectOf({
      status: { type: 'string', enum: ['open', 'stale', 'dismissed', 'applied'], default: 'open' },
    }),
    get_brief: objectOf(
      {
        task: text({ minLength: 1, maxLength: 1_000 }),
        files: { type: 'array', items: text({ minLength: 1, maxLength: 300 }), maxItems: 20 },
        feature_slugs: { type: 'array', items: text({ minLength: 1, maxLength: 300 }), maxItems: 10 },
        claims: { type: 'array', items: text({ minLength: 1, maxLength: 300 }), maxItems: 20 },
        budget: { type: 'integer', minimum: 800, maximum: 6_000 },
        lane_id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' },
      },
      ['task'],
    ),
    log_decision: objectOf(
      {
        feature_slug: text({ minLength: 1 }),
        title: text({ minLength: 1, maxLength: 200 }),
        description: text({ minLength: 1, maxLength: 5_000 }),
      },
      ['feature_slug', 'title', 'description'],
    ),
    update_feature_status: objectOf(
      {
        feature_slug: text({ minLength: 1 }),
        status: { type: 'string', enum: ['draft', 'in_progress', 'complete', 'blocked', 'deprecated'] },
        notes: text({ maxLength: 2_000 }),
      },
      ['feature_slug', 'status'],
    ),
    flag_conflict: objectOf(
      { feature_slug: text({ minLength: 1 }), description: text({ minLength: 1, maxLength: 5_000 }) },
      ['feature_slug', 'description'],
    ),
    add_session_summary: objectOf(
      {
        summary: text({ minLength: 1, maxLength: 10_000 }),
        features_touched: { type: 'array', items: text({ minLength: 1 }), minItems: 1 },
      },
      ['summary', 'features_touched'],
    ),
  };

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(expected).sort());
  for (const tool of tools) {
    assert.deepEqual(withoutDescriptions(tool.inputSchema), expected[tool.name], tool.name);
  }

  // A write tool's limit holds before any request is sent.
  const tooLong = await client.callTool({
    name: 'log_decision',
    arguments: { feature_slug: 'web--authentication', title: 'a'.repeat(201), description: 'd' },
  });
  assert.equal(tooLong.isError, true);
  assert.match(getFirstText(tooLong as { content?: Array<{ type: string; text?: string }> }), /Input validation error[\s\S]*title/);
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
      path.join(rootDir, 'decisions/mcp-server.md'),
      [
        '### D-180 — Hybrid MCP conflict reads prefer hosted conflict metadata',
        '**Timestamp:** 2026-04-26 01:43 PDT',
        '**Decision:** In Hybrid mode, get_conflicts reads from the hosted API.',
        '**Rationale:** Conflicts remain hosted collaboration metadata.',
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
    const filteredDecisionLog = await provider.getDecisionLog({
      limit: 5,
      featureSlug: 'mcp-server--context-delivery',
    });
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
    const featurePayload = featureContext.data as {
      decisions: Array<Record<string, unknown>>;
      _decisions_note: string;
      conflicts: unknown[];
      _conflicts_note: string;
    };
    // Domain-file decisions only: D-159 lives in cross-cutting.md.
    assert.deepEqual(
      featurePayload.decisions.map((decision) => decision.decisionNumber),
      [180],
    );
    assertHostedDecisionRowShape(featurePayload.decisions[0]);
    assert.match(
      featurePayload._decisions_note,
      /Results are scoped to the "mcp-server" decision file for feature "mcp-server--context-delivery"; decisions in other files, such as cross-cutting ones, are not included\./,
    );
    assert.deepEqual(featurePayload.conflicts, []);
    assert.match(featurePayload._conflicts_note, /unavailable in Local mode/);
    assert.deepEqual(
      (projectContext.data as { recent_decisions: unknown[] }).recent_decisions,
      [
        { decision_id: 180, title: 'Hybrid MCP conflict reads prefer hosted conflict metadata' },
        { decision_id: 159, title: 'Local file-backed query logic lives in vibecompass' },
      ],
    );
    assert.equal(
      (decisionLog.data as Array<{ decisionNumber: number }>)[0].decisionNumber,
      180,
    );
    const filteredDecisionPayload = filteredDecisionLog.data as {
      decisions: Array<Record<string, unknown>>;
      _note: string;
    };
    assert.deepEqual(
      filteredDecisionPayload.decisions.map((decision) => decision.decisionNumber),
      [180],
    );
    assert.match(
      filteredDecisionPayload._note,
      /Results are scoped to the "mcp-server" decision file/,
    );
    assertHostedDecisionRowShape(filteredDecisionPayload.decisions[0]);
    assert.equal('source' in filteredDecisionPayload.decisions[0], false);
    assert.equal(
      filteredDecisionPayload.decisions[0].createdAt,
      '2026-04-26T08:43:00.000Z',
    );
    assert.deepEqual((conflicts.data as { conflicts: unknown[] }).conflicts, []);
    assert.equal(
      (conflicts.data as { _note: string })._note,
      'Hosted collaboration conflicts are unavailable in Local mode without VIBECOMPASS_API_KEY. This response does not indicate that local files were checked for hosted conflict records.',
    );
    assert.equal(conflicts._freshness, projectContext._freshness);
    assert.equal(
      (fileContext.data as { owners: Array<{ feature_slug: string }> }).owners[0].feature_slug,
      'mcp-server--context-delivery',
    );

    const missingFeatureDecisionLog = await provider.getDecisionLog({
      limit: 5,
      featureSlug: 'mcp-server--missing',
    });
    assert.deepEqual(
      (missingFeatureDecisionLog.data as { decisions: unknown[] }).decisions,
      [],
    );
    assert.equal(
      (missingFeatureDecisionLog.data as { _note: string })._note,
      'Feature "mcp-server--missing" was not found in the local root.',
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('local read tools degrade without throwing when the root is missing', async () => {
  const missingRoot = path.join(
    os.tmpdir(),
    `vibecompass-mcp-missing-${Date.now()}`,
  );
  const tools = new Map<string, RegisteredTool>();
  const server = createFakeServer(tools);

  registerReadTools(server, new LocalReadProvider(missingRoot));

  const projectContext = await assertToolDoesNotThrow(
    tools.get('get_project_context'),
  );
  const featureContext = await assertToolDoesNotThrow(
    tools.get('get_feature_context'),
    { feature_slug: 'mcp-server--context-delivery' },
  );
  const decisions = await assertToolDoesNotThrow(
    tools.get('get_decision_log'),
    { limit: 5, feature_slug: 'mcp-server--context-delivery' },
  );
  const conflicts = await assertToolDoesNotThrow(tools.get('get_conflicts'));
  const fileContext = await assertToolDoesNotThrow(
    tools.get('get_file_context'),
    { filepath: 'mcp:src/tools/read.ts' },
  );

  assert.match(projectContext, /WARNING: This data may be stale/);
  assert.match(projectContext, /No data available/);
  assert.match(featureContext, /WARNING: This data may be stale/);
  assert.match(featureContext, /No data available/);
  assert.match(decisions, /WARNING: This data may be stale/);
  assert.match(decisions, /No data available/);
  assert.match(conflicts, /"conflicts": \[\]/);
  assert.match(fileContext, /WARNING: This data may be stale/);
  assert.match(fileContext, /No data available/);
});

test('local and hosted read providers assert decision and conflict fixture contracts', async () => {
  const freshness = '2026-04-26T08:43:00.000Z';
  // Modeled after GET /api/mcp/decisions?limit=5&feature_slug=...:
  // hosted rows use numeric decisionNumber, ISO createdAt, and source from the DB enum.
  const hostedDecisionFixture = [
    {
      decisionNumber: 180,
      title: 'Hybrid MCP conflict reads prefer hosted conflict metadata',
      description: 'In Hybrid mode, get_conflicts reads from the hosted API.',
      source: 'mcp',
      createdAt: freshness,
    },
  ];
  const localDecisionFixture = [
    {
      decision_id: 180,
      title: 'Hybrid MCP conflict reads prefer hosted conflict metadata',
      decision: 'In Hybrid mode, get_conflicts reads from the hosted API.',
      timestamp: '2026-04-26 01:43 PDT',
      domain_file: 'mcp-server',
      source: 'mcp',
    },
    {
      decision_id: 176,
      title: 'Publish the core package under the VibeCompass npm org scope',
      decision: 'Publish the core package under the VibeCompass npm org scope.',
      timestamp: freshness,
      domain_file: 'cross-cutting',
      source: 'manual',
    },
  ];
  const hostedConflictFixture = {
    conflicts: [],
    _note:
      'Hosted collaboration conflicts are unavailable in Local mode without VIBECOMPASS_API_KEY. This response does not indicate that local files were checked for hosted conflict records.',
  };

  const localProvider = new LocalReadProvider('/virtual/root', undefined, {
    async coreModuleLoader() {
      return {
        async loadProjectReadModel() {
          return {
            freshness,
            features: [
              {
                feature_key: 'mcp-server--context-delivery',
                domain_key: 'mcp-server',
                feature_slug: 'context-delivery',
              },
            ],
            // A feature filter reads the whole decision list, not a window.
            decisions: localDecisionFixture,
          };
        },
        getProjectContext() {
          return {
            project: { name: 'Local MCP' },
            domains: [],
            recent_decisions: [],
            recent_sessions: [],
            warning_summary: { total: 0, by_code: [] },
          };
        },
        getFeatureContext() {
          return null;
        },
        getDecisionLog() {
          return {
            decisions: localDecisionFixture,
          };
        },
        getFileContext() {
          return { owners: [], path: 'virtual:file' };
        },
      };
    },
    async rootSignatureLoader() {
      return {
        contentFingerprint: 'sig-1',
        stateManifestHash: 'manifest-1',
      };
    },
  });

  const hostedProvider = new HostedReadProvider({
    async get(pathname: string) {
      if (pathname === '/api/mcp/decisions') {
        return { data: hostedDecisionFixture, _freshness: freshness };
      }

      if (pathname === '/api/mcp/conflicts') {
        return { data: hostedConflictFixture, _freshness: freshness };
      }

      throw new Error(`Unexpected fixture path: ${pathname}`);
    },
  } as unknown as VibeCompassClient);

  const localDecisions = await localProvider.getDecisionLog({
    limit: 5,
    featureSlug: 'mcp-server--context-delivery',
  });
  const hostedDecisions = await hostedProvider.getDecisionLog({
    limit: 5,
    featureSlug: 'mcp-server--context-delivery',
  });
  const localConflicts = await localProvider.getConflicts();
  const hostedConflicts = await hostedProvider.getConflicts();

  assert.equal(Array.isArray(hostedDecisions.data), true);
  const localDecisionPayload = localDecisions.data as {
    decisions: Array<Record<string, unknown>>;
    _note: string;
  };
  assert.equal(Array.isArray(localDecisionPayload.decisions), true);
  assert.match(
    localDecisionPayload._note,
    /Local mode does not yet store feature-level decision links/,
  );
  assertHostedDecisionRowShape(
    localDecisionPayload.decisions[0],
  );
  assertHostedDecisionRowShape(
    (hostedDecisions.data as Array<Record<string, unknown>>)[0],
  );
  assert.equal(
    localDecisionPayload.decisions[0].source,
    'mcp',
  );
  assert.equal(
    localDecisionPayload.decisions[0].createdAt,
    freshness,
  );
  assert.deepEqual(
    Object.keys(localConflicts.data as Record<string, unknown>).sort(),
    Object.keys(hostedConflicts.data as Record<string, unknown>).sort(),
  );
  assert.equal(
    (localConflicts.data as { _note: string })._note,
    (hostedConflicts.data as { _note: string })._note,
  );
  assert.equal(localConflicts._freshness, freshness);
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

test('hybrid mode keeps local reads available when hosted conflict reads fail', async () => {
  const hostedClient = {
    async get(pathname: string) {
      assert.equal(pathname, '/api/mcp/conflicts');
      return {
        data: null,
        _freshness: '2026-04-26T09:00:00.000Z',
        _stale: true,
      };
    },
  } as unknown as VibeCompassClient;

  let localLoadCount = 0;
  const provider = new LocalReadProvider('/virtual/root', hostedClient, {
    async coreModuleLoader() {
      return {
        async loadProjectReadModel() {
          localLoadCount += 1;
          return {
            freshness: '2026-04-26T08:43:00.000Z',
            features: [],
          };
        },
        getProjectContext() {
          return {
            project: { name: 'Hybrid Local MCP' },
            domains: [],
            recent_decisions: [],
            recent_sessions: [],
            warning_summary: { total: 0, by_code: [] },
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
      return {
        contentFingerprint: 'sig-1',
        stateManifestHash: 'manifest-1',
      };
    },
  });

  const conflicts = await provider.getConflicts();
  const projectContext = await provider.getProjectContext();

  assert.equal(conflicts._stale, true);
  assert.equal(conflicts._error, undefined);
  assert.equal(conflicts.data, null);
  assert.equal(
    (projectContext.data as { project: { name: string } }).project.name,
    'Hybrid Local MCP',
  );
  assert.equal(projectContext._stale, undefined);
  assert.equal(localLoadCount, 1);
});
