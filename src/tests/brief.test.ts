import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildSessionBrief, renderBrief } from '@vibecompass/vibecompass';
import { HARD_CAP_NOTE } from '../budget.js';
import {
  BRIEF_PROJECTION,
  BRIEF_PROJECTION_NOTE,
  BRIEF_STARTING_POINT_NOTE,
  projectBrief,
} from '../providers/brief-build.js';
import { BRIEF_DISABLED_NOTE, LocalBriefProvider } from '../providers/local-brief.js';
import { createServer, serverInstructions, type ServerConfig } from '../server.js';
import { GET_BRIEF_DESCRIPTION, formatBriefResponse } from '../tools/brief.js';

// get_brief (D-386): registered only on a local root that opts in, the brief
// engine unchanged, two text blocks, and no cached brief.

const execFileAsync = promisify(execFile);
const CORE_CLI = path.join(
  path.dirname(createRequire(import.meta.url).resolve('@vibecompass/vibecompass')),
  'cli.js',
);
const READ_TOOLS = [
  'get_conflicts',
  'get_decision_log',
  'get_feature_context',
  'get_file_context',
  'get_project_context',
  'list_pending_proposals',
];
const MATCHING_TASK = 'read tools serve project memory over MCP with token budgets';
const NO_MATCH_TASK = 'token budgets for read tools';
const BRIEF_ON = ['brief:', '  enabled: true'];

interface Fixture {
  workspace: string;
  rootDir: string;
}

async function makeRoot(
  t: TestContext,
  { brief = BRIEF_ON, lanes = [] as Array<{ id: string; workingOn: string }> } = {},
): Promise<Fixture> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-mcp-brief-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const rootDir = path.join(workspace, 'memory');

  await mkdir(path.join(rootDir, 'architecture/mcp-server/context-delivery'), { recursive: true });
  await mkdir(path.join(rootDir, 'decisions'), { recursive: true });
  await mkdir(path.join(rootDir, 'sessions'), { recursive: true });
  await writeProjectYaml(rootDir, brief);
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
      'The read tools serve project memory over MCP with token budgets.',
      '',
      '## Involved files',
      '- `mcp:src/tools/read.ts`',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(rootDir, 'decisions/mcp-server.md'),
    [
      '### D-001 — Read tools apply token budgets',
      '**Timestamp:** 2026-04-19 13:10 PDT',
      '**Decision:** Every read response from the read tools passes a hard cap.',
      '**Rationale:** Bounded project memory over MCP.',
      '',
    ].join('\n'),
  );
  // Session commands need the tooling root's agent file.
  await writeFile(path.join(workspace, 'CLAUDE.md'), '# Brief Fixture\n');
  for (const lane of lanes) {
    await runCli(workspace, ['start-session', '--root', rootDir, '--id', lane.id, '--working-on', lane.workingOn, '--no-brief']);
  }

  return { workspace, rootDir };
}

async function writeProjectYaml(rootDir: string, brief: string[]): Promise<void> {
  await writeFile(
    path.join(rootDir, 'project.yaml'),
    [
      'format_version: 1',
      'name: Brief Fixture',
      'slug: brief-fixture',
      'mode: local-only',
      'repos:',
      '  - id: mcp',
      '    remote: https://github.com/example/mcp.git',
      '    default_branch: main',
      ...brief,
      '',
    ].join('\n'),
  );
}

async function runCli(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [CORE_CLI, ...args], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

/** `vibecompass brief --json`, run from a directory with no lane marker. */
async function cliBrief(fixture: Fixture, args: string[]): Promise<Record<string, any>> {
  return JSON.parse(await runCli(fixture.workspace, ['brief', '--root', fixture.rootDir, ...args, '--json']));
}

async function connect(t: TestContext, config: ServerConfig) {
  const { server, mode } = await createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vibecompass-brief-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, mode };
}

async function callBrief(client: Client, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name: 'get_brief', arguments: args })) as CallToolResult;
}

function texts(result: CallToolResult): string[] {
  return (result.content ?? []).map((block) => (block.type === 'text' ? block.text : ''));
}

/** The documented projection, written independently of `projectBrief`. */
function expectedMetadata(cliJson: Record<string, any>): Record<string, unknown> {
  const { markdown: _markdown, lane_source: _laneSource, cli_warnings: _cliWarnings, ...result } = cliJson;
  const references = (units: any[]) =>
    units.map(({ id, kind, tier, estimated_tokens }) => ({ id, kind, tier, estimated_tokens }));
  return {
    _note: `${BRIEF_STARTING_POINT_NOTE} ${BRIEF_PROJECTION_NOTE}`,
    _projection: BRIEF_PROJECTION,
    ...result,
    units: references(result.units),
    omitted: references(result.omitted),
  };
}

function engineResult(cliJson: Record<string, any>): Record<string, any> {
  const { markdown: _markdown, lane_source: _laneSource, cli_warnings: _cliWarnings, ...result } = cliJson;
  return result;
}

/** A fake core module on disk. A brief worker imports core by specifier, so a fake is a file. */
async function writeFakeCore(t: TestContext, source: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-mcp-fake-core-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'core.mjs');
  await writeFile(file, source);
  return pathToFileURL(file).href;
}

interface FakeControl {
  behavior: 'ok' | 'hang' | 'throw' | 'settings-throw' | 'spin';
  settings: { enabled: boolean; exclude: string[]; problems: string[] };
  spinMs?: number;
}

// Each call runs in a new worker, so this fake reads its behavior from the
// root's control.json, counts builds in builds.log, and marks a spin that
// ran to its end with a `spun` file. A hang keeps a timer alive, so only
// the deadline ends it.
const SCRIPTED_CORE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const control = (rootDir) => JSON.parse(readFileSync(join(rootDir, 'control.json'), 'utf8'));
export async function readBriefSettingsForRoot(rootDir) {
  const { behavior, settings } = control(rootDir);
  if (behavior === 'settings-throw') throw new Error('settings unreadable');
  return settings;
}
export async function buildSessionBrief({ rootDir }) {
  appendFileSync(join(rootDir, 'builds.log'), 'build\\n');
  const { behavior, spinMs } = control(rootDir);
  if (behavior === 'hang') return new Promise(() => setInterval(() => {}, 1000));
  if (behavior === 'throw') throw new Error('engine failed');
  if (behavior === 'spin') {
    const until = Date.now() + spinMs;
    while (Date.now() < until) {}
    writeFileSync(join(rootDir, 'spun'), '');
  }
  return {
    contract_version: 2,
    status: 'complete',
    units: [{ id: 'doc:private.md', kind: 'doc', tier: 'core', estimated_tokens: 12, excerpt: 'PRIVATE-TEXT' }],
    omitted: [],
  };
}
export function renderBrief(result) {
  return '# Brief\\n' + result.units.map((unit) => unit.excerpt).join('\\n') + '\\n';
}
`;
const FAKE_ENABLED = { enabled: true, exclude: [] as string[], problems: [] as string[] };

async function scriptedCore(t: TestContext) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'vibecompass-mcp-scripted-root-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return {
    rootDir,
    coreModule: await writeFakeCore(t, SCRIPTED_CORE),
    control: (control: FakeControl) => writeFile(path.join(rootDir, 'control.json'), JSON.stringify(control)),
    builds: async () => {
      const log = await readFile(path.join(rootDir, 'builds.log'), 'utf8').catch(() => '');
      return log.split('\n').filter(Boolean).length;
    },
  };
}

async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const filePath = path.join(entry.parentPath, entry.name);
      snapshot[path.relative(dir, filePath)] = createHash('sha256').update(await readFile(filePath)).digest('hex');
    }
  }
  return snapshot;
}

test('get_brief is registered only on a local root that opts in, and the instructions never name it (D-386)', async (t) => {
  const roots = {
    none: await makeRoot(t, { brief: [] }),
    disabled: await makeRoot(t, { brief: ['brief:', '  enabled: false'] }),
    quoted: await makeRoot(t, { brief: ['brief:', '  enabled: "true"'] }),
    excludeOnly: await makeRoot(t, { brief: ['brief:', '  exclude:', '    - "decisions/x.md"'] }),
    enabled: await makeRoot(t),
    enabledMalformed: await makeRoot(t, { brief: ['brief:', '  enabled: true', '  exclude: decisions/x.md'] }),
  };
  const cases: Array<{ label: string; config: ServerConfig; brief: boolean }> = [
    { label: 'local, no brief block', config: { rootDir: roots.none.rootDir }, brief: false },
    { label: 'local, enabled: false', config: { rootDir: roots.disabled.rootDir }, brief: false },
    { label: 'local, enabled: "true" (a string)', config: { rootDir: roots.quoted.rootDir }, brief: false },
    { label: 'local, exclude only', config: { rootDir: roots.excludeOnly.rootDir }, brief: false },
    { label: 'local, no project.yaml', config: { rootDir: path.join(roots.none.workspace, 'missing') }, brief: false },
    { label: 'local, enabled: true', config: { rootDir: roots.enabled.rootDir }, brief: true },
    { label: 'local, enabled: true with a malformed exclude', config: { rootDir: roots.enabledMalformed.rootDir }, brief: true },
    { label: 'hybrid, enabled: true', config: { rootDir: roots.enabled.rootDir, apiKey: 'test-key' }, brief: true },
    { label: 'hybrid, no brief block', config: { rootDir: roots.none.rootDir, apiKey: 'test-key' }, brief: false },
    { label: 'hosted', config: { apiKey: 'test-key' }, brief: false },
  ];

  for (const { label, config, brief } of cases) {
    const { client, mode } = await connect(t, config);
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    assert.equal(listed.includes('get_brief'), brief, label);
    for (const tool of READ_TOOLS) {
      assert.ok(listed.includes(tool), `${label}: ${tool} stays registered`);
    }

    const instructions = client.getInstructions() ?? '';
    assert.equal(instructions, serverInstructions(mode), label);
    assert.doesNotMatch(instructions, /brief/i, label);
  }
});

test('the server-start settings check fails closed without touching the other tools (D-386)', async (t) => {
  const missingCore = new LocalBriefProvider('/virtual/root', {
    coreModule: pathToFileURL(path.join(os.tmpdir(), 'vibecompass-mcp-no-such-core.mjs')).href,
  });
  assert.equal(await missingCore.isEnabled(), false);

  const olderCore = new LocalBriefProvider('/virtual/root', {
    coreModule: await writeFakeCore(
      t,
      "export async function buildSessionBrief() { return {}; }\nexport function renderBrief() { return ''; }\n",
    ),
  });
  assert.equal(await olderCore.isEnabled(), false, 'a core without readBriefSettingsForRoot never opts in');
  const olderCall = await olderCore.getBrief({ task: MATCHING_TASK });
  assert.ok(olderCall.kind === 'failed' && /core 0\.17\.5 or later/.test(olderCall.reason));

  const hanging = new LocalBriefProvider('/virtual/root', {
    coreModule: await writeFakeCore(t, 'export function readBriefSettingsForRoot() { return new Promise(() => {}); }\n'),
    timeoutMs: 20,
  });
  assert.equal(await hanging.isEnabled(), false);
});

test('get_brief returns what `vibecompass brief --json` returns for the same root and resolved inputs, and writes nothing (D-386)', async (t) => {
  const fixture = await makeRoot(t);
  const { client } = await connect(t, { rootDir: fixture.rootDir });
  const before = await snapshotTree(fixture.rootDir);

  const requests: Array<{ mcp: Record<string, unknown>; cli: string[] }> = [
    { mcp: { task: MATCHING_TASK }, cli: ['--task', MATCHING_TASK] },
    {
      mcp: {
        task: MATCHING_TASK,
        files: ['mcp:src/tools/read.ts'],
        feature_slugs: ['mcp-server--context-delivery'],
        claims: ['mcp:src/tools/'],
        budget: 1200,
      },
      cli: [
        '--task', MATCHING_TASK,
        '--files', 'mcp:src/tools/read.ts',
        '--feature', 'mcp-server--context-delivery',
        '--claim', 'mcp:src/tools/',
        '--budget', '1200',
      ],
    },
  ];

  for (const { mcp, cli } of requests) {
    const result = await callBrief(client, mcp);
    const expected = await cliBrief(fixture, cli);
    assert.equal(expected.lane_source, 'none', 'no active lane, so the CLI resolves none');
    assert.equal(result.isError, undefined);

    const [markdown, metadata] = texts(result);
    assert.equal(texts(result).length, 2);
    assert.equal(markdown, expected.markdown, 'the markdown block is byte-identical to the CLI');
    assert.deepEqual(JSON.parse(metadata), expectedMetadata(expected), 'the metadata block is the documented projection');
    assert.ok(expected.units.length > 0, 'the fixture brief packs units');
  }

  assert.deepEqual(await snapshotTree(fixture.rootDir), before, 'a call writes nothing');
});

test('get_brief never infers a lane; an explicit lane_id matches `brief --session` (D-277, D-386; review S2)', async (t) => {
  const single = await makeRoot(t, { lanes: [{ id: 'lane-a', workingOn: 'Budget the read tools' }] });
  const several = await makeRoot(t, {
    lanes: [
      { id: 'lane-a', workingOn: 'Budget the read tools' },
      { id: 'lane-b', workingOn: 'Cap the read tools' },
    ],
  });
  const hasLaneUnit = (metadata: string) =>
    (JSON.parse(metadata).units as Array<{ kind: string }>).some((unit) => unit.kind === 'lane');

  for (const fixture of [single, several]) {
    const { client } = await connect(t, { rootDir: fixture.rootDir });

    // Without lane_id: no lane, as the engine builds it with no lane, even
    // where the CLI would select the single active lane.
    const unnamed = await callBrief(client, { task: MATCHING_TASK });
    const [markdown, metadata] = texts(unnamed);
    assert.equal(hasLaneUnit(metadata), false);
    const engine = await buildSessionBrief({ rootDir: fixture.rootDir, task: MATCHING_TASK });
    assert.equal(markdown, renderBrief(engine));
    assert.equal(JSON.parse(metadata).source.lane_id, null);

    // With lane_id: exactly the CLI's `--session` brief.
    const laneId = fixture === single ? 'lane-a' : 'lane-b';
    const named = await callBrief(client, { task: MATCHING_TASK, lane_id: laneId });
    const expected = await cliBrief(fixture, ['--task', MATCHING_TASK, '--session', laneId]);
    assert.equal(expected.lane_source, 'flag');
    const [namedMarkdown, namedMetadata] = texts(named);
    assert.equal(namedMarkdown, expected.markdown);
    assert.deepEqual(JSON.parse(namedMetadata), expectedMetadata(expected));
    assert.equal(hasLaneUnit(namedMetadata), true);
  }

  // The documented difference: the CLI selects a single active lane.
  const cliSingle = await cliBrief(single, ['--task', MATCHING_TASK]);
  assert.equal(cliSingle.lane_source, 'single-lane');
  assert.ok(cliSingle.units.some((unit: { kind: string }) => unit.kind === 'lane'));

  // A lane that is not active gets the engine's disclosed incomplete brief
  // (the CLI's --session refuses it); a reserved id is an error.
  const { client } = await connect(t, { rootDir: single.rootDir });
  const unknown = JSON.parse(texts(await callBrief(client, { task: MATCHING_TASK, lane_id: 'no-such-lane' }))[1]);
  assert.equal(unknown.status, 'incomplete');
  assert.match(unknown.status_reason, /lane "no-such-lane" could not be read/);
  const reserved = await callBrief(client, { task: MATCHING_TASK, lane_id: 'current' });
  assert.equal(reserved.isError, true);
  assert.match(texts(reserved)[0], /reserved/);
});

test('every brief carries the starting-point note and its status, a no-match brief included (D-386)', async (t) => {
  const fixture = await makeRoot(t);
  const { client } = await connect(t, { rootDir: fixture.rootDir });

  const matched = await callBrief(client, { task: MATCHING_TASK });
  const [matchedMarkdown, matchedMetadata] = texts(matched);
  // The adapter's note is core's USE_NOTE without its emphasis; this guards drift.
  assert.ok(
    matchedMarkdown.replace(/\*\*/g, '').includes(BRIEF_STARTING_POINT_NOTE.replace(/\.$/, '')),
    'the markdown carries the same starting-point note',
  );
  assert.equal(JSON.parse(matchedMetadata).status, 'complete');

  const noMatch = await callBrief(client, { task: NO_MATCH_TASK });
  const [noMatchMarkdown, noMatchMetadata] = texts(noMatch);
  const parsed = JSON.parse(noMatchMetadata);
  assert.equal(parsed.status, 'no-match');
  assert.ok(parsed._note.startsWith(BRIEF_STARTING_POINT_NOTE));
  assert.equal(Object.keys(parsed)[0], '_note', 'the note comes first');
  assert.match(noMatchMarkdown, /no-match/i);
});

test('budget is a whole number from 800 to 6,000 (D-386)', async (t) => {
  const fixture = await makeRoot(t);
  const { client } = await connect(t, { rootDir: fixture.rootDir });

  for (const budget of [799, 6001, 1000.5, '1000']) {
    let rejected = false;
    try {
      const result = await callBrief(client, { task: MATCHING_TASK, budget });
      rejected = result.isError === true;
    } catch {
      rejected = true;
    }
    assert.ok(rejected, `budget ${String(budget)} is rejected`);
  }

  for (const budget of [800, 6000]) {
    const result = await callBrief(client, { task: MATCHING_TASK, budget });
    assert.equal(result.isError, undefined);
    assert.equal(JSON.parse(texts(result)[1]).budget.limit, budget);
  }

  const defaulted = await callBrief(client, { task: MATCHING_TASK });
  assert.equal(JSON.parse(texts(defaulted)[1]).budget.limit, 6000);
});

test('the metadata block passes the hard cap; the markdown block keeps the brief budget (D-385, D-386; review S1)', async (t) => {
  const fixture = await makeRoot(t);
  const { client } = await connect(t, { rootDir: fixture.rootDir });
  const files = Array.from({ length: 20 }, (_, index) => `mcp:src/${'deep/'.repeat(55)}file-${index}.ts`);
  const claims = Array.from({ length: 20 }, (_, index) => `mcp:src/${'claim/'.repeat(45)}path-${index}/`);

  const result = await callBrief(client, { task: MATCHING_TASK, files, claims });
  const expected = await cliBrief(fixture, ['--task', MATCHING_TASK, '--files', ...files, ...claims.flatMap((claim) => ['--claim', claim])]);
  const [markdown, metadata] = texts(result);

  assert.equal(markdown, expected.markdown, 'the markdown block is never capped');
  assert.ok(Math.ceil([...markdown].length / 4) <= 6000, 'the markdown stays within the brief budget');

  const capped = JSON.parse(metadata);
  assert.deepEqual(capped, {
    _truncated: true,
    _note: HARD_CAP_NOTE,
    _data_preview: JSON.stringify(projectBrief(engineResult(expected))).slice(0, 10_000),
  });
  assert.ok(capped._data_preview.startsWith(`{"_note":"${BRIEF_STARTING_POINT_NOTE}`), 'the preview keeps the note');
  assert.match(capped._data_preview, /"status":"/, 'and the status');
});

test('a root that stops opting in builds nothing; enabled with malformed settings fails closed (D-364, D-386)', async (t) => {
  const fixture = await makeRoot(t);
  const { client } = await connect(t, { rootDir: fixture.rootDir });
  assert.equal((await callBrief(client, { task: MATCHING_TASK })).isError, undefined);

  const disabledCases: Array<{ label: string; prepare: () => Promise<void>; problem?: RegExp }> = [
    { label: 'enabled: false', prepare: () => writeProjectYaml(fixture.rootDir, ['brief:', '  enabled: false']) },
    {
      label: 'enabled: "true"',
      prepare: () => writeProjectYaml(fixture.rootDir, ['brief:', '  enabled: "true"']),
      problem: /true or false/,
    },
    {
      label: 'no project.yaml',
      prepare: () => rm(path.join(fixture.rootDir, 'project.yaml')),
      problem: /project\.yaml could not be read/,
    },
  ];

  for (const { label, prepare, problem } of disabledCases) {
    await prepare();
    const result = await callBrief(client, { task: MATCHING_TASK });
    assert.equal(result.isError, undefined, label);
    assert.equal(texts(result).length, 1, label);
    const parsed = JSON.parse(texts(result)[0]);
    assert.equal(parsed._note, BRIEF_DISABLED_NOTE, label);
    assert.equal(parsed.brief, null, label);
    if (problem) {
      assert.match(parsed.settings_problems[0], problem, label);
    }
    assert.doesNotMatch(texts(result)[0], /read-tools\.md/, `${label}: no brief content`);
  }

  await writeProjectYaml(fixture.rootDir, ['brief:', '  enabled: true', '  exclude: decisions/x.md']);
  const malformed = await callBrief(client, { task: MATCHING_TASK });
  const [markdown, metadata] = texts(malformed);
  const parsed = JSON.parse(metadata);
  assert.equal(parsed.status, 'incomplete');
  assert.deepEqual(parsed.units, []);
  assert.match(markdown, /incomplete/i);
  assert.doesNotMatch(markdown, /read-tools\.md|D-001/, 'no canonical document was read');
});

test('a failed or timed-out call serves no cached brief, whatever the settings (D-007, D-386; review R1)', async (t) => {
  const fake = await scriptedCore(t);
  const provider = new LocalBriefProvider(fake.rootDir, { coreModule: fake.coreModule, timeoutMs: 750 });
  const request = { task: MATCHING_TASK };

  const scenarios: Array<{ label: string; control: FakeControl; kind: 'failed' | 'disabled'; builds: boolean }> = [
    {
      label: 'settings unchanged, build times out',
      control: { behavior: 'hang', settings: FAKE_ENABLED },
      kind: 'failed',
      builds: true,
    },
    {
      label: 'settings unchanged, build throws',
      control: { behavior: 'throw', settings: FAKE_ENABLED },
      kind: 'failed',
      builds: true,
    },
    {
      label: 'exclusions changed, build times out',
      control: { behavior: 'hang', settings: { ...FAKE_ENABLED, exclude: ['private.md'] } },
      kind: 'failed',
      builds: true,
    },
    {
      label: 'opt-in turned off',
      control: { behavior: 'ok', settings: { enabled: false, exclude: [], problems: [] } },
      kind: 'disabled',
      builds: false,
    },
    {
      label: 'project.yaml unreadable',
      control: {
        behavior: 'ok',
        settings: { enabled: false, exclude: [], problems: ['project.yaml could not be read (EACCES)'] },
      },
      kind: 'disabled',
      builds: false,
    },
    {
      label: 'settings read throws',
      control: { behavior: 'settings-throw', settings: FAKE_ENABLED },
      kind: 'failed',
      builds: false,
    },
  ];

  for (const scenario of scenarios) {
    await fake.control({ behavior: 'ok', settings: FAKE_ENABLED });
    const primed = await provider.getBrief(request);
    assert.equal(primed.kind, 'brief', scenario.label);
    assert.match(texts(formatBriefResponse(primed)).join('\n'), /PRIVATE-TEXT/);

    await fake.control(scenario.control);
    const buildsBefore = await fake.builds();
    const response = await provider.getBrief(request);
    assert.equal(response.kind, scenario.kind, scenario.label);
    assert.equal((await fake.builds()) > buildsBefore, scenario.builds, `${scenario.label}: build attempted`);

    const formatted = formatBriefResponse(response);
    const text = texts(formatted).join('\n');
    assert.doesNotMatch(text, /PRIVATE-TEXT/, `${scenario.label}: no earlier brief`);
    if (scenario.kind === 'failed') {
      assert.equal(formatted.isError, true, scenario.label);
      assert.match(text, /no earlier brief is served from a cache/, scenario.label);
    }
  }
});

test('the deadline holds while the engine computes synchronously, and the server stays responsive (D-007, D-386; review R3)', async (t) => {
  const fake = await scriptedCore(t);
  await fake.control({ behavior: 'spin', spinMs: 1_500, settings: FAKE_ENABLED });
  const provider = new LocalBriefProvider(fake.rootDir, { coreModule: fake.coreModule, timeoutMs: 300 });

  const started = performance.now();
  const call = provider.getBrief({ task: MATCHING_TASK });
  const scheduled = performance.now();
  await delay(50);
  const timerLag = performance.now() - scheduled;
  const response = await call;
  const elapsed = performance.now() - started;

  assert.ok(timerLag < 250, `the event loop stays free while the brief computes (a 50 ms timer took ${Math.round(timerLag)} ms)`);
  assert.equal(response.kind, 'failed');
  assert.match(response.kind === 'failed' ? response.reason : '', /timed out after 300ms/);
  assert.ok(elapsed < 1_200, `the call answers at its deadline, not when the engine finishes (${Math.round(elapsed)} ms)`);

  // Stopped, not abandoned: well after the spin would have ended, it never finished.
  await delay(Math.max(0, 2_000 - (performance.now() - started)));
  assert.equal(existsSync(path.join(fake.rootDir, 'spun')), false, 'the worker was terminated mid-computation');
});

test('the get_brief description frames a starting point and never asks to be called first (D-386; session 26, S1)', async (t) => {
  const fixture = await makeRoot(t);
  const { client } = await connect(t, { rootDir: fixture.rootDir });
  const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'get_brief');
  assert.ok(tool);
  assert.equal(tool.description, GET_BRIEF_DESCRIPTION);
  assert.match(GET_BRIEF_DESCRIPTION, /starting point, not the whole context/);
  assert.doesNotMatch(GET_BRIEF_DESCRIPTION, /\b(first|always|must|every session|by default|before (any|every))\b/i);
  assert.deepEqual(tool.inputSchema.required, ['task']);
  assert.deepEqual(
    Object.keys(tool.inputSchema.properties ?? {}).sort(),
    ['budget', 'claims', 'feature_slugs', 'files', 'lane_id', 'task'],
  );
});
