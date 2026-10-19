import { applyHardCap, boundEcho } from '../budget.js';
import { TIMEOUT_MS, logLocalError, withTimeout } from './local-read.js';

// get_brief (D-386): the session brief engine (D-359, D-364), offered only on
// a local root whose project.yaml sets `brief.enabled: true`. Core owns the
// settings reader and the engine (D-159); the adapter owns the gate, the
// response shape, and the failure path.

export const BRIEF_MIN_BUDGET = 800;
export const BRIEF_MAX_BUDGET = 6_000;
export const BRIEF_PROJECTION = 'units-as-references/1';

// Core's starting-point note (USE_NOTE in src/brief-render.js) without its
// markdown emphasis. The markdown block carries it for every status except
// no-match; the metadata block carries it always.
export const BRIEF_STARTING_POINT_NOTE =
  'Use this brief as a starting point, not the whole context. It shows cut excerpts chosen by keyword and citation matching, so it can miss the doc this task depends on. Read the full source behind any fact you rely on, and search memory beyond this list.';
export const BRIEF_PROJECTION_NOTE =
  'This JSON is an adapter projection of the brief contract: units and omitted units are references (id, kind, tier, estimated_tokens). Packed units\' excerpts are in the markdown block; their evidence and provenance records, and omitted units\' text, are not. `vibecompass brief --json` with the same inputs returns the full records.';
export const BRIEF_DISABLED_NOTE =
  'get_brief built nothing: this root\'s project.yaml no longer sets brief.enabled: true. The tool stays listed until the MCP server restarts. Read the project-memory files at VIBECOMPASS_ROOT directly.';
export const BRIEF_FAILED_NOTE =
  'No brief content is returned, and no earlier brief is served from a cache. Read the project-memory files at VIBECOMPASS_ROOT directly, or run `vibecompass brief` with the same inputs.';

// The contract's fields in an order that keeps the status, follow-up reads,
// and gaps inside a hard-capped preview. Fields a later contract adds follow.
const PROJECTION_KEY_ORDER = [
  'contract_version',
  'status',
  'status_reason',
  'retrieval_error',
  'follow_ups',
  'follow_up_cap',
  'gaps',
  'warnings',
  'budget',
  'render',
  'units',
  'omitted',
  'covered_by_other_units',
  'selection',
  'orientation',
  'task',
  'inputs',
  'source',
];
const SETTINGS_PROBLEM_LIMIT = 5;

export interface BriefInput {
  task: string;
  files?: string[];
  featureSlugs?: string[];
  claims?: string[];
  budget?: number;
  laneId?: string;
}

export type BriefResponse =
  | { kind: 'brief'; markdown: string; metadata: unknown }
  | { kind: 'disabled'; problems: string[] }
  | { kind: 'failed'; reason: string };

export interface BriefProvider {
  getBrief(input: BriefInput): Promise<BriefResponse>;
}

interface BriefSettings {
  enabled: boolean;
  problems: string[];
}

export interface BriefCoreModule {
  // Optional so an older core (before 0.17.5) is detected instead of crashing.
  readBriefSettingsForRoot?(rootDir: string): Promise<BriefSettings>;
  buildSessionBrief(options: Record<string, unknown>): Promise<any>;
  renderBrief(result: any): string;
}

interface LocalBriefProviderDependencies {
  coreModuleLoader?: () => Promise<BriefCoreModule>;
  timeoutMs?: number;
}

export class LocalBriefProvider implements BriefProvider {
  private readonly coreModuleLoader: () => Promise<BriefCoreModule>;
  private readonly timeoutMs: number;
  private coreModulePromise: Promise<BriefCoreModule> | null = null;

  constructor(
    private readonly rootDir: string,
    dependencies: LocalBriefProviderDependencies = {},
  ) {
    this.coreModuleLoader = dependencies.coreModuleLoader ?? importBriefCoreModule;
    this.timeoutMs = dependencies.timeoutMs ?? TIMEOUT_MS;
  }

  /**
   * Read at server start: only a boolean `true` opts in. Any failure means the
   * tool is not registered, and the other read tools register as before.
   */
  async isEnabled(): Promise<boolean> {
    try {
      const settings = await withTimeout(this.readSettings(), this.timeoutMs);
      return settings.enabled === true;
    } catch (error) {
      logLocalError('get_brief:settings', error);
      return false;
    }
  }

  /**
   * Never served from a cache: a cached brief could carry text the root's
   * current settings exclude or no longer allow (D-386).
   */
  async getBrief(input: BriefInput): Promise<BriefResponse> {
    try {
      return await withTimeout(this.buildBrief(input), this.timeoutMs);
    } catch (error) {
      logLocalError('get_brief', error);
      return {
        kind: 'failed',
        reason: boundEcho(error instanceof Error ? error.message : String(error), 300),
      };
    }
  }

  private async buildBrief(input: BriefInput): Promise<BriefResponse> {
    const settings = await this.readSettings();
    if (settings.enabled !== true) {
      return {
        kind: 'disabled',
        problems: (settings.problems ?? [])
          .slice(0, SETTINGS_PROBLEM_LIMIT)
          .map((problem) => boundEcho(String(problem), 300)),
      };
    }

    // The engine reads the root's exclusions itself and fails closed on
    // malformed settings, as it does for `vibecompass brief`.
    const core = await this.loadCoreModule();
    const result = await core.buildSessionBrief({
      rootDir: this.rootDir,
      task: input.task,
      files: input.files ?? [],
      featureSlugs: input.featureSlugs ?? [],
      claims: input.claims ?? [],
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
      ...(input.laneId !== undefined ? { laneId: input.laneId } : {}),
    });

    return {
      kind: 'brief',
      markdown: core.renderBrief(result),
      metadata: applyHardCap(projectBrief(result)),
    };
  }

  private async readSettings(): Promise<BriefSettings> {
    const core = await this.loadCoreModule();
    if (typeof core.readBriefSettingsForRoot !== 'function') {
      throw new Error(
        '@vibecompass/vibecompass does not export readBriefSettingsForRoot; get_brief needs core 0.17.5 or later.',
      );
    }

    return core.readBriefSettingsForRoot(this.rootDir);
  }

  private loadCoreModule(): Promise<BriefCoreModule> {
    if (!this.coreModulePromise) {
      this.coreModulePromise = this.coreModuleLoader().catch((error: unknown) => {
        // A failed import is retried on the next call.
        this.coreModulePromise = null;
        throw error;
      });
    }

    return this.coreModulePromise;
  }
}

/**
 * The metadata block: the engine's result with packed and omitted units as
 * references, the adapter's notes first. A lossy projection, named on the wire
 * by `_projection` (D-386).
 */
export function projectBrief(result: Record<string, any>): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    ...result,
    units: unitReferences(result.units),
    omitted: unitReferences(result.omitted),
  };
  const ordered: Record<string, unknown> = {
    _note: `${BRIEF_STARTING_POINT_NOTE} ${BRIEF_PROJECTION_NOTE}`,
    _projection: BRIEF_PROJECTION,
  };

  for (const key of PROJECTION_KEY_ORDER) {
    if (key in projected) {
      ordered[key] = projected[key];
    }
  }
  for (const [key, value] of Object.entries(projected)) {
    if (!(key in ordered)) {
      ordered[key] = value;
    }
  }

  return ordered;
}

function unitReferences(units: unknown): unknown {
  if (!Array.isArray(units)) {
    return units;
  }

  return units.map((unit: any) => ({
    id: unit?.id,
    kind: unit?.kind,
    tier: unit?.tier,
    estimated_tokens: unit?.estimated_tokens,
  }));
}

async function importBriefCoreModule(): Promise<BriefCoreModule> {
  try {
    return (await import('@vibecompass/vibecompass')) as unknown as BriefCoreModule;
  } catch (error) {
    throw new Error(
      `Failed to load @vibecompass/vibecompass for get_brief: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
