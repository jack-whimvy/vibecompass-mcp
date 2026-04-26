import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApiResponse, VibeCompassClient } from '../api-client.js';
import type { ReadProvider } from '../read-provider.js';

const TIMEOUT_MS = 5_000;
const LOG_DIR = join(homedir(), '.vibecompass');
const LOG_FILE = join(LOG_DIR, 'mcp-errors.log');
const NON_CANONICAL_DECISION_FILES = new Set(['INDEX.md']);
const NON_CANONICAL_SESSION_FILES = new Set(['wip.md', 'handoff.md']);
const NON_CANONICAL_ARCHITECTURE_FILES = new Set(['README.md']);
const LOCAL_CONFLICTS_UNAVAILABLE_NOTE =
  'Hosted collaboration conflicts are unavailable in Local mode without VIBECOMPASS_API_KEY. This response does not indicate that local files were checked for hosted conflict records.';
const HOSTED_DECISION_SOURCES = new Set(['mcp', 'scan', 'manual', 'pipeline']);

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
        decisionLimit: 20,
        sessionLimit: 5,
      });

      return {
        data: transformProjectContext(readModel, data),
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

        const transformed = result
          ? {
              ...result,
              feature: transformFeature(
                result.feature,
                input.componentSlug,
              ),
            }
          : null;

        return {
          data: transformed,
          _freshness: readModel.freshness,
        };
      },
    );
  }

  async getDecisionLog(input: {
    limit: number;
    featureSlug?: string;
  }): Promise<ApiResponse> {
    return this.withResilience(
      `get_decision_log:${input.limit}:${input.featureSlug ?? ''}`,
      async () => {
        const { core, readModel } = await this.loadCoreModel();
        const feature = input.featureSlug
          ? findFeatureByExternalSlug(readModel.features, input.featureSlug)
          : null;
        // Local decisions are grouped by canonical decision file, so filtered reads
        // inspect a wider raw window before narrowing to the feature's domain file.
        const data = core.getDecisionLog(readModel, {
          limit: input.featureSlug ? 100 : input.limit,
        });
        if (input.featureSlug && !feature) {
          return {
            data: {
              decisions: [],
              _note: `Feature "${input.featureSlug}" was not found in the local root.`,
            },
            _freshness: readModel.freshness,
          };
        }

        const decisions =
          input.featureSlug && feature
            ? data.decisions
                .filter((decision: any) =>
                  decisionBelongsToFeatureDomain(decision, feature),
                )
                .slice(0, input.limit)
            : data.decisions;
        const transformed = decisions.map(transformDecisionLogDecision);

        return {
          data:
            input.featureSlug && feature
              ? {
                  decisions: transformed,
                  _note: `Local mode does not yet store feature-level decision links. Results are scoped to the "${feature.domain_key}" decision file for feature "${input.featureSlug}".`,
                }
              : transformed,
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
          data: getLocalConflictsUnavailableData(),
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
        data: {
          ...data,
          owners: data.owners.map((owner: any) => ({
            ...owner,
            feature_slug: toExternalFeatureSlug(owner),
          })),
        },
        _freshness: readModel.freshness,
      };
    });
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
  };
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
