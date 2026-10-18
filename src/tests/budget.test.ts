import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HARD_CAP_NOTE,
  applyHardCap,
  boundEcho,
  notesFirst,
  clampDecisionLimit,
  estimateTokens,
  shedToBudget,
} from '../budget.js';
import {
  LocalReadProvider,
  shedLocalFeatureContext,
  shedLocalProjectContext,
} from '../providers/local-read.js';

// ---------------------------------------------------------------------------
// Hosted reference: a port of the hosted shedding and hard cap, pinned to
// vibecompass-app 61f04cc (src/lib/mcp/response.ts mcpJson/estimateTokens,
// src/app/api/mcp/context/route.ts, src/app/api/mcp/features/[slug]/route.ts).
// The notes are copied as literals so a drift in budget.ts fails these tests.
// The port covers the shaping operations, not the routes' whole assembly: the
// fixtures model no null session, unassigned features, or open conflicts.
// ---------------------------------------------------------------------------

function hostedEstimateTokens(data: unknown): number {
  return Math.ceil(JSON.stringify(data).length / 4);
}

function hostedMcpJsonData(data: unknown): unknown {
  const json = JSON.stringify(data);
  if (json.length > 10_000) {
    return {
      _truncated: true,
      _note:
        'Response exceeded token budget and was truncated. Use scoped tools (get_feature_context, get_decision_log) for full data.',
      _data_preview: json.slice(0, 10_000),
    };
  }
  return data;
}

interface ScenarioFeature {
  domain: string;
  slug: string;
  name: string;
  status: string;
}

interface ContextScenario {
  features: ScenarioFeature[];
  decisions: Array<{ number: number; title: string }>;
  session: { title: string; date: string; number: number };
}

function hostedProjectContext(scenario: ContextScenario) {
  const domainNames = [...new Set(scenario.features.map((f) => f.domain))];
  const featureRows = scenario.features.map((f) => ({
    slug: f.slug,
    name: f.name,
    status: f.status,
    domainId: f.domain,
  }));
  const lastSession = {
    summary: scenario.session.title,
    featuresTouched: [] as string[],
    createdAt: `${scenario.session.date}T00:00:00.000Z`,
  };
  const featureSummary = (rows: typeof featureRows) =>
    rows.map((f) => ({ slug: f.slug, name: f.name, status: f.status }));
  const data: Record<string, unknown> = {
    domains: domainNames.map((name) => ({
      name,
      features: featureSummary(featureRows.filter((f) => f.domainId === name)),
    })),
    unassignedFeatures: [],
    openConflictCount: 0,
    recentDecisions: scenario.decisions.map((d) => ({
      number: d.number,
      title: d.title,
    })),
    lastSession: {
      summary: lastSession.summary,
      featuresTouched: lastSession.featuresTouched,
      at: lastSession.createdAt,
    },
  };
  const shed: string[] = [];

  if (hostedEstimateTokens(data) > 2000) {
    data.lastSession = {
      summary: '(truncated — call get_feature_context for details)',
      featuresTouched: lastSession.featuresTouched,
    };
    shed.push('session-detail');
  }
  if (hostedEstimateTokens(data) > 2000) {
    data.recentDecisions = [];
    data._note =
      'Large project — call get_decision_log() for decisions, get_feature_context() for detail';
    shed.push('recent-decisions');
  }
  if (hostedEstimateTokens(data) > 2000) {
    const slim = (rows: typeof featureRows) =>
      rows.map((f) => ({ s: f.slug, st: f.status }));
    data.domains = domainNames.map((name) => ({
      name,
      features: slim(featureRows.filter((f) => f.domainId === name)),
    }));
    data.unassignedFeatures = [];
    shed.push('feature-names');
  }

  return { data: hostedMcpJsonData(data), shed };
}

function localProjectContext(scenario: ContextScenario) {
  const domainNames = [...new Set(scenario.features.map((f) => f.domain))];
  const data = {
    freshness: '2026-10-18T00:00:00.000Z',
    manifest_state: { exists: true, current: true, manifest_hash: 'hash' },
    project: { name: 'Parity', slug: 'parity', mode: 'local-primary' },
    warning_summary: { total: 0, by_code: [] },
    domains: domainNames.map((name) => {
      const features = scenario.features.filter((f) => f.domain === name);
      return {
        domain: name,
        domain_key: name,
        feature_count: features.length,
        features: features.map((f) => ({
          feature_key: f.slug,
          feature: f.name,
          feature_slug: f.slug,
          overall_status: f.status,
          component_count: 1,
          repo_ids: ['app'],
        })),
      };
    }),
    recent_decisions: scenario.decisions.map((d) => ({
      decision_id: d.number,
      title: d.title,
    })),
    recent_sessions: [
      {
        title: scenario.session.title,
        session_date: scenario.session.date,
        session_number: scenario.session.number,
        path: `sessions/${scenario.session.date}-${scenario.session.number}-x.md`,
      },
    ],
    decision_lineage: { status: 'available', unavailable_sources: [] },
  };
  const shaped = shedLocalProjectContext(data);
  return { data: applyHardCap(shaped.data), shed: shaped.shed };
}

interface FeatureScenario {
  description: string;
  components: Array<{ slug: string; description: string; files: string[]; details?: string }>;
  decisions: Array<{ number: number; title: string; description: string }>;
}

function featureFiles(scenario: FeatureScenario): string[] {
  // Local features list the union of their components' files; the hosted
  // fixture carries the same union so both modes hold the same content.
  return [...new Set(scenario.components.flatMap((c) => c.files))].sort();
}

function hostedFeatureContext(scenario: FeatureScenario) {
  const componentRows = scenario.components.map((c) => ({
    slug: c.slug,
    name: c.slug,
    description: c.description,
    status: 'Complete',
    involvedFiles: c.files,
  }));
  const featureDecisions = scenario.decisions.map((d) => ({
    decisionNumber: d.number,
    title: d.title,
    description: d.description,
    source: 'manual',
    createdAt: '2026-10-18T00:00:00.000Z',
  }));
  const data: Record<string, unknown> = {
    slug: 'parity',
    name: 'Parity',
    description: scenario.description,
    status: 'Complete',
    domain: 'Platform',
    primaryRepo: 'app',
    repoNames: ['app'],
    involvedFiles: featureFiles(scenario),
    nextSteps: [],
    components: componentRows.map((c) => ({ ...c })),
    decisions: featureDecisions,
    conflicts: [],
  };
  const shed: string[] = [];

  if (hostedEstimateTokens(data) > 2000) {
    data.decisions = featureDecisions.map((d) => ({
      number: d.decisionNumber,
      title: d.title,
    }));
    shed.push('decision-descriptions');
  }
  if (hostedEstimateTokens(data) > 2000) {
    data.components = componentRows.map((c) => ({
      slug: c.slug,
      name: c.name,
      status: c.status,
      description: c.description,
    }));
    shed.push('component-files');
  }
  if (hostedEstimateTokens(data) > 2000) {
    data.involvedFiles = [];
    data._note =
      'Truncated to fit token budget — use get_file_context() for file mappings';
    shed.push('feature-files');
  }
  if (hostedEstimateTokens(data) > 2000) {
    data.decisions = [];
    const desc = typeof data.description === 'string' ? data.description : '';
    if (desc.length > 500) {
      data.description = desc.slice(0, 500) + '... (truncated)';
    }
    shed.push('decisions-and-descriptions');
  }

  return { data: hostedMcpJsonData(data), shed };
}

function localFeatureContext(scenario: FeatureScenario) {
  // Local features have no description of their own: the scenario's feature
  // description is the first component's, which is what the last tier trims.
  const components = scenario.components.map((c, index) => ({
    component_key: c.slug,
    component: c.slug,
    status: 'Complete',
    path: `architecture/platform/parity/${c.slug}.md`,
    repo_ids: ['app'],
    description: index === 0 ? scenario.description : c.description,
    details: c.details ?? '',
    next_steps: '',
    retrieval_guidance: '',
    retrieval_scope: '',
    involved_files: c.files,
    warnings: [],
    warning_count: 0,
  }));
  const data = {
    freshness: '2026-10-18T00:00:00.000Z',
    feature: {
      feature_key: 'platform--parity',
      domain: 'Platform',
      domain_key: 'platform',
      feature: 'Parity',
      feature_slug: 'platform--parity',
      overall_status: 'Complete',
      component_count: components.length,
      component_status_counts: { Complete: components.length },
      repo_ids: ['app'],
      involved_files: featureFiles(scenario),
      components,
      warnings: [],
      warning_count: 0,
    },
    decisions: scenario.decisions.map((d) => ({
      decisionNumber: d.number,
      title: d.title,
      description: d.description,
      createdAt: '2026-10-18T00:00:00.000Z',
    })),
    _decisions_note: 'scope note',
    conflicts: [],
    _conflicts_note: 'conflicts note',
  };
  const shaped = shedLocalFeatureContext(data);
  return { data: applyHardCap(shaped.data), shed: shaped.shed };
}

const LOCAL_ONLY_FEATURE_TIERS = new Set(['component-text']);

function sharedTiers(shed: string[]): string[] {
  return shed.filter((tier) => !LOCAL_ONLY_FEATURE_TIERS.has(tier));
}

function isHardCapped(data: unknown): boolean {
  return Boolean(
    data &&
      typeof data === 'object' &&
      (data as { _truncated?: boolean })._truncated === true,
  );
}

function features(count: number, nameLength: number): ScenarioFeature[] {
  return Array.from({ length: count }, (_, index) => ({
    domain: `domain-${index % 4}`,
    slug: `domain-${index % 4}--feature-${index}`,
    name: `Feature ${index} `.padEnd(nameLength, 'n'),
    status: 'Complete',
  }));
}

function decisions(count: number, titleLength: number, descriptionLength = 40) {
  return Array.from({ length: count }, (_, index) => ({
    number: 300 - index,
    title: `Decision ${index} `.padEnd(titleLength, 't'),
    description: `Description ${index} `.padEnd(descriptionLength, 'd'),
  }));
}

function files(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `app:src/${prefix}/module-${String(index).padStart(3, '0')}.ts`,
  );
}

const SESSION = { title: 'Parity session', date: '2026-10-18', number: 3 };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

test('hard cap keeps a response at exactly 2,500 tokens and caps one character over', () => {
  // A JSON string of length n serializes to n + 2 characters.
  const atCap = 'x'.repeat(10_000 - 2);
  assert.equal(JSON.stringify(atCap).length, 10_000);
  assert.equal(estimateTokens(atCap), 2500);
  assert.equal(applyHardCap(atCap), atCap);

  const overCap = 'x'.repeat(10_000 - 1);
  const capped = applyHardCap(overCap) as Record<string, unknown>;
  assert.deepEqual(Object.keys(capped), ['_truncated', '_note', '_data_preview']);
  assert.equal(capped._truncated, true);
  assert.equal(capped._note, HARD_CAP_NOTE);
  assert.equal((capped._data_preview as string).length, 10_000);
  assert.deepEqual(capped, hostedMcpJsonData(overCap));
});

test('shedding stops once data fits and never mutates its input', () => {
  const input = { list: ['a'.repeat(9_000)], keep: true };
  const frozen = JSON.stringify(input);
  const result = shedToBudget(input, 2000, [
    { name: 'drop-list', apply: (data) => ({ ...data, list: [] }) },
    { name: 'drop-keep', apply: (data) => ({ ...data, keep: false }) },
  ]);

  assert.deepEqual(result.shed, ['drop-list']);
  assert.equal(result.data.keep, true);
  assert.equal(JSON.stringify(input), frozen);
});

test('notes move ahead of the payload and echoed input is bounded', () => {
  assert.deepEqual(
    Object.keys(notesFirst({ freshness: 'f', feature: {}, _decisions_note: 'a', decisions: [], _note: 'b' }) as object),
    ['_decisions_note', '_note', 'freshness', 'feature', 'decisions'],
  );
  const rows = [{ _x: 1 }];
  assert.equal(notesFirst(rows), rows);
  assert.equal(notesFirst(null), null);
  assert.equal(boundEcho('short'), 'short');
  assert.equal(boundEcho('y'.repeat(201)), `${'y'.repeat(200)}…`);
});

test('decision-log limits clamp the way hosted parses them', () => {
  assert.equal(clampDecisionLimit(20), 20);
  assert.equal(clampDecisionLimit(0), 1);
  assert.equal(clampDecisionLimit(-5), 1);
  assert.equal(clampDecisionLimit(500), 100);
  assert.equal(clampDecisionLimit(7.9), 7);
  assert.equal(clampDecisionLimit(Number.NaN), 20);
});

// ---------------------------------------------------------------------------
// Parity fixtures: the same content, shaped by the hosted port and by Local
// ---------------------------------------------------------------------------

test('project context: Local and hosted shed the same tiers in the same order', () => {
  const scenarios: Array<{ label: string; scenario: ContextScenario; shed: string[]; capped: boolean }> = [
    {
      label: 'fits',
      scenario: { features: features(6, 20), decisions: decisions(5, 40), session: SESSION },
      shed: [],
      capped: false,
    },
    {
      label: 'recent decisions dominate',
      scenario: { features: features(6, 20), decisions: decisions(5, 1_800), session: SESSION },
      shed: ['session-detail', 'recent-decisions'],
      capped: false,
    },
    {
      label: 'feature names dominate',
      scenario: { features: features(120, 80), decisions: decisions(5, 40), session: SESSION },
      shed: ['session-detail', 'recent-decisions', 'feature-names'],
      capped: false,
    },
    {
      label: 'pathological',
      scenario: { features: features(600, 80), decisions: decisions(5, 40), session: SESSION },
      shed: ['session-detail', 'recent-decisions', 'feature-names'],
      capped: true,
    },
  ];

  for (const { label, scenario, shed, capped } of scenarios) {
    const hosted = hostedProjectContext(scenario);
    const local = localProjectContext(scenario);

    assert.deepEqual(hosted.shed, shed, `hosted ${label}`);
    assert.deepEqual(local.shed, shed, `local ${label}`);
    assert.equal(isHardCapped(hosted.data), capped, `hosted cap ${label}`);
    assert.equal(isHardCapped(local.data), capped, `local cap ${label}`);

    if (capped) {
      assert.deepEqual(
        Object.keys(local.data as object),
        Object.keys(hosted.data as object),
      );
      continue;
    }

    assert.ok(estimateTokens(local.data) <= 2000, `local budget ${label}`);
    const hostedData = hosted.data as Record<string, unknown>;
    const localData = local.data as Record<string, any>;
    assert.equal(localData._note, hostedData._note, `note ${label}`);
    if (shed.includes('feature-names')) {
      assert.deepEqual(
        localData.domains[0].features[0],
        (hostedData.domains as any[])[0].features[0],
      );
    }
  }
});

test('feature context: Local sheds hosted tiers in hosted order, plus its one Local-only tier', () => {
  const shortComponents = [
    { slug: 'api', description: 'API routes.', files: files('api', 3) },
    { slug: 'ui', description: 'Pages.', files: files('ui', 3) },
  ];
  const sharedFiles = files('shared', 110);
  const scenarios: Array<{
    label: string;
    scenario: FeatureScenario;
    hostedShed: string[];
    localShed: string[];
    capped: boolean;
  }> = [
    {
      label: 'fits',
      scenario: { description: 'A feature.', components: shortComponents, decisions: decisions(5, 40) },
      hostedShed: [],
      localShed: [],
      capped: false,
    },
    {
      label: 'decision descriptions dominate',
      scenario: { description: 'A feature.', components: shortComponents, decisions: decisions(20, 40, 600) },
      hostedShed: ['decision-descriptions'],
      localShed: ['decision-descriptions'],
      capped: false,
    },
    {
      label: 'component files dominate',
      scenario: {
        description: 'A feature.',
        components: [
          { slug: 'api', description: 'API routes.', files: sharedFiles },
          { slug: 'ui', description: 'Pages.', files: sharedFiles },
        ],
        decisions: decisions(5, 40),
      },
      hostedShed: ['decision-descriptions', 'component-files'],
      localShed: ['decision-descriptions', 'component-text', 'component-files'],
      capped: false,
    },
    {
      label: 'feature files dominate',
      scenario: {
        description: 'A feature.',
        components: [
          { slug: 'api', description: 'API routes.', files: files('api', 150) },
          { slug: 'ui', description: 'Pages.', files: files('ui', 150) },
        ],
        decisions: decisions(5, 40),
      },
      hostedShed: ['decision-descriptions', 'component-files', 'feature-files'],
      localShed: ['decision-descriptions', 'component-text', 'component-files', 'feature-files'],
      capped: false,
    },
    {
      label: 'description dominates',
      scenario: {
        description: 'Long description. '.repeat(500),
        components: [{ slug: 'api', description: '', files: files('api', 3) }],
        decisions: decisions(5, 40),
      },
      hostedShed: ['decision-descriptions', 'component-files', 'feature-files', 'decisions-and-descriptions'],
      localShed: [
        'decision-descriptions',
        'component-text',
        'component-files',
        'feature-files',
        'decisions-and-descriptions',
      ],
      capped: false,
    },
    {
      label: 'pathological',
      scenario: {
        description: 'Long description. '.repeat(500),
        components: Array.from({ length: 40 }, (_, index) => ({
          slug: `component-${index}`,
          description: 'Component description. '.repeat(30),
          files: files(`c${index}`, 2),
        })),
        decisions: decisions(5, 40),
      },
      hostedShed: ['decision-descriptions', 'component-files', 'feature-files', 'decisions-and-descriptions'],
      localShed: [
        'decision-descriptions',
        'component-text',
        'component-files',
        'feature-files',
        'decisions-and-descriptions',
      ],
      capped: true,
    },
  ];

  for (const { label, scenario, hostedShed, localShed, capped } of scenarios) {
    const hosted = hostedFeatureContext(scenario);
    const local = localFeatureContext(scenario);

    assert.deepEqual(hosted.shed, hostedShed, `hosted ${label}`);
    assert.deepEqual(local.shed, localShed, `local ${label}`);
    assert.deepEqual(sharedTiers(local.shed), hosted.shed, `shared order ${label}`);
    assert.equal(isHardCapped(hosted.data), capped, `hosted cap ${label}`);
    assert.equal(isHardCapped(local.data), capped, `local cap ${label}`);

    if (capped) {
      continue;
    }

    assert.ok(estimateTokens(local.data) <= 2000, `local budget ${label}`);
    const hostedData = hosted.data as Record<string, any>;
    const localData = local.data as Record<string, any>;
    // Local rows carry `source` only when the entry records one (read-tools.md).
    assert.deepEqual(
      localData.decisions,
      hostedData.decisions.map(({ source: _source, ...row }: Record<string, unknown>) => row),
      `decisions ${label}`,
    );
    if (hostedShed.includes('feature-files')) {
      assert.match(localData._note, new RegExp(escapeRegExp(hostedData._note)));
      assert.deepEqual(localData.feature.involved_files, hostedData.involvedFiles);
    }
    if (hostedShed.includes('decisions-and-descriptions')) {
      assert.equal(localData.feature.components[0].description, hostedData.description);
    }
  }
});

test('feature context: component details are the one documented Local-only tier', () => {
  const scenario: FeatureScenario = {
    description: 'A feature.',
    components: [
      { slug: 'api', description: 'API routes.', files: files('api', 3), details: 'Details. '.repeat(1_000) },
    ],
    decisions: decisions(5, 40),
  };
  const hosted = hostedFeatureContext(scenario);
  const local = localFeatureContext(scenario);

  // Hosted never returns component details, so it has nothing to shed.
  assert.deepEqual(hosted.shed, []);
  assert.deepEqual(local.shed, ['decision-descriptions', 'component-text']);
  const localData = local.data as Record<string, any>;
  assert.equal('details' in localData.feature.components[0], false);
  assert.equal(localData.feature.components[0].path, 'architecture/platform/parity/api.md');
  assert.match(localData._note, /read each component's doc/);
  assert.ok(estimateTokens(localData) <= 2000);
});

// ---------------------------------------------------------------------------
// Each Local tool at and over its budget, through the provider
// ---------------------------------------------------------------------------

interface FakeRoot {
  projectName: string;
  featureDescription: string;
  decisionDescription: string;
  decisionCount: number;
  ownerComponent: string;
  componentName: string;
  newerOtherDomainDecisions: number;
}

function fakeProvider(root: FakeRoot, hosted = false) {
  // Newest first, as the core read model sorts them. Only the first platform
  // decision carries the padded description, so it appears once per response.
  const otherDecisions = Array.from({ length: root.newerOtherDomainDecisions }, (_, index) => ({
    decision_id: 500 - index,
    title: `Cross-cutting ${index}`,
    timestamp: '2026-10-18 13:48 PDT',
    decision: 'Short.',
    rationale: 'Because.',
    path: 'decisions/cross-cutting.md',
    domain_file: 'cross-cutting',
  }));
  const domainDecisions = Array.from({ length: root.decisionCount }, (_, index) => ({
    decision_id: 400 - index,
    title: `Decision ${index}`,
    timestamp: '2026-10-18 13:48 PDT',
    decision: index === 0 ? root.decisionDescription : 'Short.',
    rationale: 'Because.',
    path: 'decisions/platform.md',
    domain_file: 'platform',
  }));
  const decisionsList = [...otherDecisions, ...domainDecisions];
  const feature = {
    feature_key: 'platform--parity',
    domain: 'Platform',
    domain_key: 'platform',
    feature: 'Parity',
    feature_slug: 'parity',
    overall_status: 'Complete',
    component_count: 1,
    component_status_counts: { Complete: 1 },
    repo_ids: ['app'],
    involved_files: ['app:src/a.ts'],
    components: [
      {
        component_key: 'api',
        component: root.componentName,
        status: 'Complete',
        path: 'architecture/platform/parity/api.md',
        repo_ids: ['app'],
        description: root.featureDescription,
        details: '',
        next_steps: '',
        retrieval_guidance: '',
        retrieval_scope: '',
        involved_files: ['app:src/a.ts'],
        warnings: [],
        warning_count: 0,
      },
    ],
    warnings: [],
    warning_count: 0,
  };
  const readModel = {
    freshness: '2026-10-18T20:48:00.000Z',
    features: [feature],
    decisions: decisionsList,
  };

  return new LocalReadProvider(
    '/virtual/root',
    hosted
      ? ({
          async get() {
            return { data: null, _freshness: readModel.freshness };
          },
        } as never)
      : undefined,
    {
      async coreModuleLoader() {
        return {
          async loadProjectReadModel() {
            return readModel;
          },
          getProjectContext() {
            return {
              freshness: readModel.freshness,
              project: { name: root.projectName },
              warning_summary: { total: 0, by_code: [] },
              domains: [
                {
                  domain: 'Platform',
                  domain_key: 'platform',
                  feature_count: 1,
                  features: [
                    {
                      feature_key: feature.feature_key,
                      feature: feature.feature,
                      feature_slug: feature.feature_slug,
                      overall_status: feature.overall_status,
                      component_count: 1,
                      repo_ids: ['app'],
                    },
                  ],
                },
              ],
              recent_decisions: decisionsList.slice(0, 5),
              recent_sessions: [
                { title: 'S1', session_date: '2026-10-18', session_number: 3, path: 'sessions/a.md' },
                { title: 'S0', session_date: '2026-10-17', session_number: 1, path: 'sessions/b.md' },
              ],
            };
          },
          getFeatureContext() {
            return { freshness: readModel.freshness, feature };
          },
          getDecisionLog(_model: unknown, options?: { limit?: number }) {
            return { decisions: decisionsList.slice(0, options?.limit ?? 20) };
          },
          getFileContext() {
            return {
              freshness: readModel.freshness,
              path: 'app:src/a.ts',
              owners: [
                {
                  feature_key: feature.feature_key,
                  domain: 'Platform',
                  feature: 'Parity',
                  component: root.ownerComponent,
                  component_key: 'api',
                  component_path: 'architecture/platform/parity/api.md',
                  repo_ids: ['app'],
                  matched_file: 'app:src/a.ts',
                },
              ],
            };
          },
        };
      },
      async rootSignatureLoader() {
        return { contentFingerprint: 'sig', stateManifestHash: 'manifest' };
      },
    },
  );
}

const BASE_ROOT: FakeRoot = {
  projectName: 'P',
  featureDescription: 'D',
  decisionDescription: 'Short.',
  decisionCount: 3,
  ownerComponent: 'API',
  componentName: 'API',
  newerOtherDomainDecisions: 0,
};

// Pads one string field so the tool's data serializes to exactly `target`
// characters, then returns the data at that size and one character over.
async function atAndOver(
  target: number,
  field: keyof FakeRoot,
  call: (provider: LocalReadProvider) => Promise<{ data: unknown }>,
) {
  const base = await call(fakeProvider(BASE_ROOT));
  const baseLength = JSON.stringify(base.data).length;
  const padding = target - baseLength;
  assert.ok(padding > 0, `base ${baseLength} must be under ${target}`);
  const pad = (extra: number) => ({
    ...BASE_ROOT,
    [field]: `${BASE_ROOT[field]}${'x'.repeat(padding + extra)}`,
  });

  const at = await call(fakeProvider(pad(0)));
  const over = await call(fakeProvider(pad(1)));
  return { at: at.data, over: over.data };
}

test('get_project_context: no tier at 2,000 tokens, session detail sheds one character over', async () => {
  const { at, over } = await atAndOver(8_000, 'projectName', (provider) =>
    provider.getProjectContext(),
  );
  const atData = at as Record<string, any>;
  const overData = over as Record<string, any>;

  assert.equal(estimateTokens(atData), 2000);
  assert.equal(atData.recent_sessions.length, 2);
  assert.deepEqual(Object.keys(atData.recent_decisions[0]), ['decision_id', 'title']);

  assert.equal(overData.recent_sessions.length, 1);
  assert.deepEqual(Object.keys(overData.recent_sessions[0]), [
    'title',
    'session_date',
    'session_number',
  ]);
  assert.equal(overData.recent_decisions.length, 3);
  assert.ok(estimateTokens(overData) <= 2000);
});

test('get_project_context: over the hard cap after every tier returns the capped shape', async () => {
  const provider = fakeProvider({ ...BASE_ROOT, projectName: 'x'.repeat(12_000) });
  const response = await provider.getProjectContext();
  const data = response.data as Record<string, unknown>;

  assert.equal(data._truncated, true);
  assert.equal(data._note, HARD_CAP_NOTE);
  assert.equal((data._data_preview as string).length, 10_000);
  assert.equal(response._stale, undefined);
});

test('get_feature_context: no tier at 2,000 tokens, decision descriptions shed one character over', async () => {
  const { at, over } = await atAndOver(8_000, 'featureDescription', (provider) =>
    provider.getFeatureContext({ featureSlug: 'platform--parity' }),
  );
  const atData = at as Record<string, any>;
  const overData = over as Record<string, any>;

  assert.equal(estimateTokens(atData), 2000);
  assert.equal(atData.decisions[0].description, 'Short.');
  assert.deepEqual(atData.conflicts, []);
  assert.match(atData._decisions_note, /scoped to the "platform" decision file/);
  assert.match(atData._conflicts_note, /unavailable in Local mode/);

  assert.deepEqual(Object.keys(overData.decisions[0]), ['number', 'title']);
  assert.ok(estimateTokens(overData) <= 2000);
});

test('get_feature_context: over the hard cap after every tier returns the capped shape', async () => {
  // Only content no tier sheds can reach the cap: here, a very long
  // component name.
  const response = await fakeProvider({
    ...BASE_ROOT,
    componentName: 'x'.repeat(12_000),
  }).getFeatureContext({ featureSlug: 'platform--parity' });
  const data = response.data as Record<string, unknown>;

  assert.equal(data._truncated, true);
  assert.equal(data._note, HARD_CAP_NOTE);
  assert.equal((data._data_preview as string).length, 10_000);

  // The qualifications are serialized first, so the preview keeps them all
  // (review R1): the decision scope, the conflicts note, and the shed notes.
  const preview = data._data_preview as string;
  assert.ok(preview.startsWith('{"_decisions_note":'));
  for (const note of [
    'Results are scoped to the "platform" decision file for feature "platform--parity"; decisions in other files, such as cross-cutting ones, are not included.',
    'Hosted collaboration conflicts are unavailable in Local mode without VIBECOMPASS_API_KEY.',
    "read each component's doc (its path, under VIBECOMPASS_ROOT) for them.",
    'Truncated to fit token budget — use get_file_context() for file mappings',
  ]) {
    assert.ok(preview.includes(jsonEscaped(note)), note);
  }
});

test('get_decision_log: unchanged at 2,500 tokens, capped one character over', async () => {
  const { at, over } = await atAndOver(10_000, 'decisionDescription', (provider) =>
    provider.getDecisionLog({ limit: 3 }),
  );

  assert.equal(estimateTokens(at), 2500);
  assert.equal(Array.isArray(at), true);
  assert.equal((over as Record<string, unknown>)._truncated, true);
  assert.equal((over as Record<string, unknown>)._note, HARD_CAP_NOTE);
});

test('get_decision_log with a feature: unchanged at 2,500 tokens, capped one character over', async () => {
  const { at, over } = await atAndOver(10_000, 'decisionDescription', (provider) =>
    provider.getDecisionLog({ limit: 3, featureSlug: 'platform--parity' }),
  );

  assert.equal(estimateTokens(at), 2500);
  const scopeNote = (at as { _note: string })._note;
  assert.match(scopeNote, /does not yet store feature-level decision links/);

  // Capped, the preview still opens with the full scope note (review R1).
  const capped = over as Record<string, unknown>;
  assert.equal(capped._truncated, true);
  assert.ok(
    (capped._data_preview as string).startsWith(`{"_note":"${jsonEscaped(scopeNote)}"`),
  );
});

test('get_decision_log with an oversized unknown slug stays a short D-181 note under the cap', async () => {
  const slug = 'x'.repeat(20_000);
  const response = await fakeProvider(BASE_ROOT).getDecisionLog({ limit: 20, featureSlug: slug });
  const data = response.data as { decisions: unknown[]; _note: string };

  assert.deepEqual(data.decisions, []);
  assert.equal(data._note, `Feature "${'x'.repeat(200)}…" was not found in the local root.`);
  assert.ok(estimateTokens(data) < 100);
  assert.equal(response._stale, undefined);
});

test('get_decision_log with a feature reads every decision in the domain file', async () => {
  // 100 newer decisions in another file: the old path filtered only the
  // newest 100 overall and returned nothing for this feature.
  const provider = fakeProvider({
    ...BASE_ROOT,
    newerOtherDomainDecisions: 100,
    decisionCount: 30,
  });
  const response = await provider.getDecisionLog({ limit: 50, featureSlug: 'platform--parity' });
  const data = response.data as { decisions: Array<{ decisionNumber: number }> };

  assert.equal(data.decisions.length, 30);
  assert.equal(data.decisions[0].decisionNumber, 400);

  const clamped = await provider.getDecisionLog({ limit: 0, featureSlug: 'platform--parity' });
  assert.equal((clamped.data as { decisions: unknown[] }).decisions.length, 1);
});

test('get_file_context: unchanged at 2,500 tokens, capped one character over', async () => {
  const { at, over } = await atAndOver(10_000, 'ownerComponent', (provider) =>
    provider.getFileContext({ filepath: 'app:src/a.ts' }),
  );

  assert.equal(estimateTokens(at), 2500);
  assert.equal((at as { path: string }).path, 'app:src/a.ts');
  assert.equal((over as Record<string, unknown>)._truncated, true);
});

test('get_conflicts and list_pending_proposals: Local bodies are fixed and far under the cap', async () => {
  const provider = fakeProvider(BASE_ROOT);
  const conflicts = await provider.getConflicts();
  const proposals = await provider.listPendingProposals({});

  // Neither body depends on the root, so neither can reach the cap; both
  // still pass through it like every other Local response.
  assert.deepEqual((conflicts.data as { conflicts: unknown[] }).conflicts, []);
  assert.deepEqual((proposals.data as { proposals: unknown[] }).proposals, []);
  assert.ok(estimateTokens(conflicts.data) < 100);
  assert.ok(estimateTokens(proposals.data) < 100);
});

test('get_feature_context in Hybrid points to get_conflicts for hosted conflicts', async () => {
  const response = await fakeProvider(BASE_ROOT, true).getFeatureContext({
    featureSlug: 'platform--parity',
  });
  const data = response.data as Record<string, any>;

  assert.deepEqual(data.conflicts, []);
  assert.match(data._conflicts_note, /Call get_conflicts\(\)/);
});

function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
