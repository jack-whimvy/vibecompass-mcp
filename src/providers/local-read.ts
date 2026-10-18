import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApiResponse, VibeCompassClient } from '../api-client.js';
import {
  CONTEXT_DECISIONS_SHED_NOTE,
  CONTEXT_TOKEN_BUDGET,
  DESCRIPTION_TRIM_CHARS,
  FEATURE_DECISION_LIMIT,
  FEATURE_FILES_SHED_NOTE,
  FEATURE_TOKEN_BUDGET,
  RECENT_DECISION_LIMIT,
  appendNote,
  applyHardCap,
  notesFirst,
  boundEcho,
  clampDecisionLimit,
  shedToBudget,
  type SheddingTier,
} from '../budget.js';
import type { ReadProvider } from '../read-provider.js';

const TIMEOUT_MS = 5_000;
const LOG_DIR = join(homedir(), '.vibecompass');
const LOG_FILE = join(LOG_DIR, 'mcp-errors.log');
const NON_CANONICAL_DECISION_FILES = new Set(['INDEX.md']);
const NON_CANONICAL_SESSION_FILES = new Set(['wip.md', 'handoff.md']);
const NON_CANONICAL_ARCHITECTURE_FILES = new Set(['README.md']);
const LOCAL_CONFLICTS_UNAVAILABLE_NOTE =
  'Hosted collaboration conflicts are unavailable in Local mode without VIBECOMPASS_API_KEY. This response does not indicate that local files were checked for hosted conflict records.';
const HYBRID_FEATURE_CONFLICTS_NOTE =
  'Hosted conflicts are not matched to local features. Call get_conflicts() for the hosted project\'s open conflicts.';
const LOCAL_PROPOSALS_UNAVAILABLE_NOTE =
  'Hosted proposals are unavailable in Local mode without VIBECOMPASS_API_KEY. Local project-memory files remain authoritative; use the package sync flow when hosted proposals are available.';
const LOCAL_COMPONENT_TEXT_SHED_NOTE =
  'Component details, next steps, retrieval guidance, and warning lists were omitted to fit the token budget; read each component\'s doc (its path, under VIBECOMPASS_ROOT) for them.';
const LOCAL_COMPONENT_TEXT_FIELDS = new Set([
  'details',
  'next_steps',
  'retrieval_guidance',
  'retrieval_scope',
  'warnings',
]);
const HOSTED_DECISION_SOURCES = new Set(['mcp', 'scan', 'manual', 'pipeline']);
const RECENT_SESSION_LIMIT = 5;

interface CacheEntry {
  data: unknown;
  timestamp: string;
}

interface LocalCoreModule {
  loadProjectReadModel(rootDir: string): Promise<any>;
  getProjectContext(readModel: any, options?: { decisionLimit?: number; sessionLimit?: number }): any;
  getFeatureContext(readModel: any, lookup: { featureKey: string }): any;
  getDecisionLog(readModel: any, options?: { limit?: number }): any;
  getFileContext(readModel: any, filepath: string): any;
}

interface RootSignature {
  contentFingerprint: string;
  stateManifestHash: string | null;
}

interface ReadModelCacheEntry {
  signature: RootSignature;
  readModel: any;
}

interface LocalReadProviderDependencies {
  coreModuleLoader?: () => Promise<LocalCoreModule>;
  rootSignatureLoader?: (rootDir: string) => Promise<RootSignature>;
}

export class LocalReadProvider implements ReadProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly coreModuleLoader: () => Promise<LocalCoreModule>;
  private readonly rootSignatureLoader: (rootDir: string) => Promise<RootSignature>;
  private coreModulePromise: Promise<LocalCoreModule> | null = null;
  private readModelCache: ReadModelCacheEntry | null = null;
  private readModelLoadPromise: Promise<any> | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly hostedClient?: VibeCompassClient,
    dependencies: LocalReadProviderDependencies = {},
  ) {
    this.coreModuleLoader = dependencies.coreModuleLoader ?? importLocalCoreModule;
    this.rootSignatureLoader = dependencies.rootSignatureLoader ?? loadRootSignature;
  }

  async getProjectContext(): Promise<ApiResponse> {
    return this.withResilience('get_project_context', async () => {
      const { core, readModel } = await this.loadCoreModel();
      const data = core.getProjectContext(readModel, {
        decisionLimit: RECENT_DECISION_LIMIT,
        sessionLimit: RECENT_SESSION_LIMIT,
      });

      return {
        data: capLocalResponse(
          shedLocalProjectContext(transformProjectContext(readModel, data)).data,
        ),
        _freshness: readModel.freshness,
      };
    });
  }

  async getFeatureContext(input: {
    featureSlug: string;
    componentSlug?: string;
  }): Promise<ApiResponse> {
    return this.withResilience(
      `get_feature_context:${input.featureSlug}:${input.componentSlug ?? ''}`,
      async () => {
        const { core, readModel } = await this.loadCoreModel();
        const feature = readModel.features.find(
          (candidate: any) => toExternalFeatureSlug(candidate) === input.featureSlug,
        );

        if (!feature) {
          return {
            data: null,
            _freshness: readModel.freshness,
          };
        }

        const result = core.getFeatureContext(readModel, {
          featureKey: feature.feature_key,
        });

        if (!result) {
          return {
            data: null,
            _freshness: readModel.freshness,
          };
        }

        // Hosted returns the feature's decisions and open conflicts alongside
        // it. Local decisions come from the feature's domain decision file,
        // and conflicts are hosted collaboration metadata (D-179, D-385).
        const data = {
          ...result,
          feature: transformFeature(result.feature, input.componentSlug),
          decisions: findDomainDecisions(readModel, feature)
            .slice(0, FEATURE_DECISION_LIMIT)
            .map(transformDecisionLogDecision),
          _decisions_note: decisionScopeNote(feature, input.featureSlug),
          conflicts: [],
          _conflicts_note: this.hostedClient
            ? HYBRID_FEATURE_CONFLICTS_NOTE
            : LOCAL_CONFLICTS_UNAVAILABLE_NOTE,
        };

        return {
          data: capLocalResponse(shedLocalFeatureContext(data).data),
          _freshness: readModel.freshness,
        };
      },
    );
  }

  async getDecisionLog(input: {
    limit: number;
    featureSlug?: string;
  }): Promise<ApiResponse> {
    const limit = clampDecisionLimit(input.limit);

    return this.withResilience(
      `get_decision_log:${limit}:${input.featureSlug ?? ''}`,
      async () => {
        const { core, readModel } = await this.loadCoreModel();

        if (!input.featureSlug) {
          const data = core.getDecisionLog(readModel, { limit });
          return {
            data: capLocalResponse(data.decisions.map(transformDecisionLogDecision)),
            _freshness: readModel.freshness,
          };
        }

        const feature = findFeatureByExternalSlug(
          readModel.features,
          input.featureSlug,
        );
        if (!feature) {
          return {
            data: capLocalResponse({
              decisions: [],
              _note: `Feature "${boundEcho(input.featureSlug)}" was not found in the local root.`,
            }),
            _freshness: readModel.freshness,
          };
        }

        return {
          data: capLocalResponse({
            decisions: findDomainDecisions(readModel, feature)
              .slice(0, limit)
              .map(transformDecisionLogDecision),
            _note: decisionScopeNote(feature, input.featureSlug),
          }),
          _freshness: readModel.freshness,
        };
      },
    );
  }

  async getConflicts(): Promise<ApiResponse> {
    if (this.hostedClient) {
      return this.hostedClient.get('/api/mcp/conflicts');
    }

    return this.withResilience(
      'get_conflicts',
      async () => {
        const { readModel } = await this.loadCoreModel();
        return {
          data: capLocalResponse(getLocalConflictsUnavailableData()),
          _freshness: readModel.freshness,
        };
      },
      getLocalConflictsUnavailableData(),
    );
  }

  async getFileContext(input: { filepath: string }): Promise<ApiResponse> {
    return this.withResilience(`get_file_context:${input.filepath}`, async () => {
      const { core, readModel } = await this.loadCoreModel();
      const data = core.getFileContext(readModel, input.filepath);

      return {
        data: capLocalResponse({
          ...data,
          owners: data.owners.map((owner: any) => ({
            ...owner,
            feature_slug: toExternalFeatureSlug(owner),
          })),
        }),
        _freshness: readModel.freshness,
      };
    });
  }

  async listPendingProposals(input: { status?: string }): Promise<ApiResponse> {
    if (this.hostedClient) {
      return this.hostedClient.get('/api/mcp/proposals', {
        status: input.status ?? 'open',
      });
    }

    return this.withResilience(
      `list_pending_proposals:${input.status ?? 'open'}`,
      async () => {
        const { readModel } = await this.loadCoreModel();
        return {
          data: capLocalResponse(getLocalProposalsUnavailableData()),
          _freshness: readModel.freshness,
        };
      },
      getLocalProposalsUnavailableData(),
    );
  }

  private async loadCoreModel(): Promise<{
    core: LocalCoreModule;
    readModel: any;
  }> {
    const core = await this.loadCoreModule();
    const readModel = await this.loadReadModel(core);

    return { core, readModel };
  }

  private async loadCoreModule(): Promise<LocalCoreModule> {
    if (!this.coreModulePromise) {
      this.coreModulePromise = this.coreModuleLoader();
    }

    return this.coreModulePromise;
  }

  private async loadReadModel(core: LocalCoreModule): Promise<any> {
    const signature = await this.rootSignatureLoader(this.rootDir);
    if (
      this.readModelCache &&
      rootSignaturesMatch(this.readModelCache.signature, signature)
    ) {
      return this.readModelCache.readModel;
    }

    if (!this.readModelLoadPromise) {
      this.readModelLoadPromise = this.buildReadModel(core);
    }

    const readModel = await this.readModelLoadPromise;
    const refreshedSignature = await this.rootSignatureLoader(this.rootDir);
    if (
      this.readModelCache &&
      rootSignaturesMatch(this.readModelCache.signature, refreshedSignature)
    ) {
      return this.readModelCache.readModel;
    }

    this.readModelLoadPromise = this.buildReadModel(core);
    return this.readModelLoadPromise;
  }

  private async buildReadModel(core: LocalCoreModule): Promise<any> {
    try {
      const readModel = await core.loadProjectReadModel(this.rootDir);
      const signature = await this.rootSignatureLoader(this.rootDir);

      this.readModelCache = {
        signature,
        readModel,
      };

      return readModel;
    } finally {
      this.readModelLoadPromise = null;
    }
  }

  private async withResilience(
    cacheKey: string,
    loader: () => Promise<ApiResponse>,
    // Some tools, such as Local get_conflicts (D-179), have a stable empty shape.
    // Other local read failures fall back to null so clients do not confuse absence with an authoritative empty result.
    fallbackData: unknown = null,
  ): Promise<ApiResponse> {
    try {
      const response = await withTimeout(loader(), TIMEOUT_MS);
      this.cache.set(cacheKey, {
        data: response.data,
        timestamp: response._freshness,
      });
      return response;
    } catch (error) {
      this.logError(cacheKey, error);

      const cached = this.cache.get(cacheKey);
      if (cached) {
        return {
          data: cached.data,
          _freshness: cached.timestamp,
          _stale: true,
        };
      }

      return {
        data: fallbackData,
        _freshness: new Date().toISOString(),
        _stale: true,
      };
    }
  }

  private logError(cacheKey: string, error: unknown): void {
    try {
      if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
      }

      const message = error instanceof Error ? error.message : String(error);
      appendFileSync(
        LOG_FILE,
        `[${new Date().toISOString()}] local:${cacheKey} — ${message}\n`,
      );
    } catch {
      // Logging must never crash the MCP process.
    }
  }
}

async function importLocalCoreModule(): Promise<LocalCoreModule> {
  try {
    return (await import('@vibecompass/vibecompass')) as LocalCoreModule;
  } catch (error) {
    throw new Error(
      `Failed to load @vibecompass/vibecompass for local mode: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function toExternalFeatureSlug(entity: {
  feature_key?: string;
  domain_key?: string;
  feature_slug?: string;
}): string {
  if (typeof entity.feature_key === 'string' && entity.feature_key.length > 0) {
    return entity.feature_key;
  }

  return `${entity.domain_key ?? 'unknown'}--${entity.feature_slug ?? 'unknown'}`;
}

function findFeatureByExternalSlug(features: any[], featureSlug: string): any | null {
  return (
    features.find((feature: any) => toExternalFeatureSlug(feature) === featureSlug) ??
    null
  );
}

function decisionBelongsToFeatureDomain(decision: any, feature: any): boolean {
  return decision.domain_file === feature.domain_key;
}

// The whole decision list, newest first, so older domain files are not crowded
// out by newer decisions in other files.
function findDomainDecisions(readModel: any, feature: any): any[] {
  return (Array.isArray(readModel.decisions) ? readModel.decisions : []).filter(
    (decision: any) => decisionBelongsToFeatureDomain(decision, feature),
  );
}

// Every Local response passes the hosted hard cap, with its notes serialized
// first so the capped preview still carries them (D-385).
function capLocalResponse(data: unknown): unknown {
  return applyHardCap(notesFirst(data));
}

function decisionScopeNote(feature: any, featureSlug: string): string {
  return `Local mode does not yet store feature-level decision links. Results are scoped to the "${feature.domain_key}" decision file for feature "${featureSlug}"; decisions in other files, such as cross-cutting ones, are not included.`;
}

function transformDecisionLogDecision(decision: any) {
  const row: Record<string, unknown> = {
    decisionNumber: decision.decision_id,
    title: decision.title,
    description: decision.decision,
    createdAt: normalizeDecisionTimestamp(decision.timestamp),
  };

  if (typeof decision.source === 'string' && HOSTED_DECISION_SOURCES.has(decision.source)) {
    row.source = decision.source;
  }

  return row;
}

function getLocalConflictsUnavailableData() {
  return {
    conflicts: [],
    _note: LOCAL_CONFLICTS_UNAVAILABLE_NOTE,
  };
}

function getLocalProposalsUnavailableData() {
  return {
    proposals: [],
    _note: LOCAL_PROPOSALS_UNAVAILABLE_NOTE,
  };
}

function normalizeDecisionTimestamp(timestamp: unknown): string | null {
  if (timestamp instanceof Date) {
    return timestamp.toISOString();
  }

  if (typeof timestamp !== 'string' || timestamp.trim().length === 0) {
    return null;
  }

  const trimmed = timestamp.trim();
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }

  const timezoneNormalized = trimmed.replace(
    /\s+(PDT|PST|EDT|EST|CDT|CST|MDT|MST|UTC|GMT)$/,
    (_match, zone: string) => {
      // Current canonical files use US timezone abbreviations; extend this
      // allowlist if international shorthand appears in project memory.
      const offsets: Record<string, string> = {
        PDT: '-07:00',
        PST: '-08:00',
        EDT: '-04:00',
        EST: '-05:00',
        CDT: '-05:00',
        CST: '-06:00',
        MDT: '-06:00',
        MST: '-07:00',
        UTC: 'Z',
        GMT: 'Z',
      };
      return offsets[zone] ? ` ${offsets[zone]}` : _match;
    },
  );
  const normalizedParsed = Date.parse(timezoneNormalized);

  return Number.isNaN(normalizedParsed)
    ? null
    : new Date(normalizedParsed).toISOString();
}

function transformProjectContext(readModel: any, data: any) {
  const slugByFeatureKey = new Map(
    readModel.features.map((feature: any) => [
      feature.feature_key,
      toExternalFeatureSlug(feature),
    ]),
  );

  return {
    ...data,
    domains: data.domains.map((domain: any) => ({
      ...domain,
      features: domain.features.map((feature: any) => ({
        ...feature,
        feature_slug:
          slugByFeatureKey.get(feature.feature_key) ?? feature.feature_slug,
      })),
    })),
    // Hosted lists recent decisions by number and title only; the text is
    // one get_decision_log call away.
    recent_decisions: (data.recent_decisions ?? []).map((decision: any) => ({
      decision_id: decision.decision_id,
      title: decision.title,
    })),
  };
}

// Hosted context tiers, in order (app src/app/api/mcp/context/route.ts):
// session detail, recent decisions, feature names.
const LOCAL_PROJECT_CONTEXT_TIERS: Array<SheddingTier<Record<string, any>>> = [
  {
    name: 'session-detail',
    apply: (data) => ({
      ...data,
      recent_sessions: (data.recent_sessions ?? [])
        .slice(0, 1)
        .map((session: any) => ({
          title: session.title,
          session_date: session.session_date,
          session_number: session.session_number,
        })),
    }),
  },
  {
    name: 'recent-decisions',
    apply: (data) => ({
      ...data,
      recent_decisions: [],
      _note: CONTEXT_DECISIONS_SHED_NOTE,
    }),
  },
  {
    name: 'feature-names',
    apply: (data) => ({
      ...data,
      domains: (data.domains ?? []).map((domain: any) => ({
        ...domain,
        features: domain.features.map((feature: any) => ({
          s: feature.feature_slug,
          st: feature.overall_status,
        })),
      })),
    }),
  },
];

// Hosted feature tiers, in order (app src/app/api/mcp/features/[slug]/route.ts):
// decision descriptions, component files, feature files, then decisions and
// long descriptions. The one Local-only tier sheds component text hosted never
// returns, so the fields both modes share still shed in hosted's order (D-385).
const LOCAL_FEATURE_CONTEXT_TIERS: Array<SheddingTier<Record<string, any>>> = [
  {
    name: 'decision-descriptions',
    apply: (data) => ({
      ...data,
      decisions: (data.decisions ?? []).map((decision: any) => ({
        number: decision.decisionNumber,
        title: decision.title,
      })),
    }),
  },
  {
    name: 'component-text',
    apply: (data) => ({
      ...data,
      feature: {
        ...omitKeys(data.feature, ['warnings']),
        components: data.feature.components.map((component: any) =>
          omitKeys(component, LOCAL_COMPONENT_TEXT_FIELDS),
        ),
      },
      _note: appendNote(data._note, LOCAL_COMPONENT_TEXT_SHED_NOTE),
    }),
  },
  {
    name: 'component-files',
    apply: (data) => ({
      ...data,
      feature: {
        ...data.feature,
        components: data.feature.components.map((component: any) =>
          omitKeys(component, ['involved_files']),
        ),
      },
    }),
  },
  {
    name: 'feature-files',
    apply: (data) => ({
      ...data,
      feature: { ...data.feature, involved_files: [] },
      _note: appendNote(data._note, FEATURE_FILES_SHED_NOTE),
    }),
  },
  {
    name: 'decisions-and-descriptions',
    apply: (data) => ({
      ...data,
      decisions: [],
      feature: {
        ...data.feature,
        components: data.feature.components.map((component: any) => ({
          ...component,
          description: trimDescription(component.description),
        })),
      },
    }),
  },
];

export function shedLocalProjectContext(data: Record<string, any>) {
  return shedToBudget(data, CONTEXT_TOKEN_BUDGET, LOCAL_PROJECT_CONTEXT_TIERS);
}

export function shedLocalFeatureContext(data: Record<string, any>) {
  return shedToBudget(data, FEATURE_TOKEN_BUDGET, LOCAL_FEATURE_CONTEXT_TIERS);
}

function trimDescription(description: unknown): unknown {
  return typeof description === 'string' &&
    description.length > DESCRIPTION_TRIM_CHARS
    ? `${description.slice(0, DESCRIPTION_TRIM_CHARS)}... (truncated)`
    : description;
}

function omitKeys(
  entity: Record<string, any>,
  keys: Iterable<string>,
): Record<string, any> {
  const omitted = new Set(keys);
  return Object.fromEntries(
    Object.entries(entity).filter(([key]) => !omitted.has(key)),
  );
}

function transformFeature(feature: any, componentSlug?: string) {
  const externalFeatureSlug = toExternalFeatureSlug(feature);
  const components = componentSlug
    ? feature.components.filter(
        (component: any) => component.component_key === componentSlug,
      )
    : feature.components;

  return {
    ...feature,
    feature_slug: externalFeatureSlug,
    components,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function rootSignaturesMatch(left: RootSignature, right: RootSignature): boolean {
  return (
    left.contentFingerprint === right.contentFingerprint &&
    left.stateManifestHash === right.stateManifestHash
  );
}

async function loadRootSignature(rootDir: string): Promise<RootSignature> {
  const watchedFiles = [
    'project.yaml',
    ...(await listCanonicalMarkdownFiles(rootDir, 'architecture', (filename) =>
      !NON_CANONICAL_ARCHITECTURE_FILES.has(filename),
    )),
    ...(await listCanonicalMarkdownFiles(rootDir, 'decisions', (filename) =>
      !NON_CANONICAL_DECISION_FILES.has(filename),
    )),
    ...(await listCanonicalMarkdownFiles(rootDir, 'sessions', (filename) =>
      !NON_CANONICAL_SESSION_FILES.has(filename),
    )),
    ...(await fileExists(join(rootDir, 'state/manifest.json'))
      ? ['state/manifest.json']
      : []),
  ];

  const fingerprintSource = [];
  for (const relativePath of watchedFiles) {
    const stats = await stat(join(rootDir, relativePath));
    fingerprintSource.push(
      `${relativePath}:${stats.size}:${Math.trunc(stats.mtimeMs)}`,
    );
  }

  return {
    contentFingerprint: createHash('sha256')
      .update(fingerprintSource.join('\n'))
      .digest('hex'),
    stateManifestHash: await readStateManifestHash(rootDir),
  };
}

async function readStateManifestHash(rootDir: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await readFile(join(rootDir, 'state/manifest.json'), 'utf8'),
    ) as { canonical?: { manifest_hash?: string } };

    return typeof manifest.canonical?.manifest_hash === 'string'
      ? manifest.canonical.manifest_hash
      : null;
  } catch {
    return null;
  }
}

async function listCanonicalMarkdownFiles(
  rootDir: string,
  directoryName: string,
  shouldInclude: (filename: string) => boolean,
): Promise<string[]> {
  const directoryPath = join(rootDir, directoryName);
  return listMarkdownFiles(directoryPath, directoryName, shouldInclude);
}

async function listMarkdownFiles(
  directoryPath: string,
  relativeRoot: string,
  shouldInclude: (filename: string) => boolean,
): Promise<string[]> {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const paths = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const absoluteChildPath = join(directoryPath, entry.name);
      const relativeChildPath = join(relativeRoot, entry.name);

      if (entry.isDirectory()) {
        paths.push(
          ...(await listMarkdownFiles(
            absoluteChildPath,
            relativeChildPath,
            shouldInclude,
          )),
        );
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue;
      }

      if (!shouldInclude(entry.name)) {
        continue;
      }

      paths.push(relativeChildPath);
    }

    return paths.sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
