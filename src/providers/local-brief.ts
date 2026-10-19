import { Worker } from 'node:worker_threads';
import { boundEcho } from '../budget.js';
import {
  importBriefCore,
  readBriefSettings,
  type BriefInput,
  type BriefJob,
  type BriefResponse,
  type BriefWorkerMessage,
} from './brief-build.js';
import { TIMEOUT_MS, logLocalError, withTimeout } from './local-read.js';

// get_brief (D-386): the session brief engine (D-359, D-364), offered only on
// a local root whose project.yaml sets `brief.enabled: true`. Core owns the
// settings reader and the engine (D-159); the adapter owns the gate, the
// response shape, and the failure path. Each call runs in its own worker
// thread (brief-worker.ts), so the 5-second limit holds while the engine
// computes, and the server keeps answering other calls meanwhile.

export const BRIEF_MIN_BUDGET = 800;
export const BRIEF_MAX_BUDGET = 6_000;
export const BRIEF_DISABLED_NOTE =
  'get_brief built nothing: this root\'s project.yaml no longer sets brief.enabled: true. The tool stays listed until the MCP server restarts. Read the project-memory files at VIBECOMPASS_ROOT directly.';
export const BRIEF_FAILED_NOTE =
  'No brief content is returned, and no earlier brief is served from a cache. Read the project-memory files at VIBECOMPASS_ROOT directly, or run `vibecompass brief` with the same inputs.';

const CORE_MODULE = '@vibecompass/vibecompass';
const BRIEF_WORKER_URL = new URL('./brief-worker.js', import.meta.url);

export interface BriefProvider {
  getBrief(input: BriefInput): Promise<BriefResponse>;
}

interface LocalBriefProviderDependencies {
  // A module specifier for core. Workers import core by specifier, so tests
  // pass a file URL to a fake.
  coreModule?: string;
  timeoutMs?: number;
}

export class LocalBriefProvider implements BriefProvider {
  private readonly coreModule: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly rootDir: string,
    dependencies: LocalBriefProviderDependencies = {},
  ) {
    this.coreModule = dependencies.coreModule ?? CORE_MODULE;
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

  async getBrief(input: BriefInput): Promise<BriefResponse> {
    try {
      return await this.runWorker(input);
    } catch (error) {
      logLocalError('get_brief', error);
      return {
        kind: 'failed',
        reason: boundEcho(error instanceof Error ? error.message : String(error), 300),
      };
    }
  }

  private async readSettings() {
    return readBriefSettings(await importBriefCore(this.coreModule), this.rootDir);
  }

  /**
   * The server owns the deadline: at the limit it terminates the worker,
   * which stops the engine even inside synchronous work (review R3).
   */
  private runWorker(input: BriefInput): Promise<BriefResponse> {
    return new Promise<BriefResponse>((resolve, reject) => {
      const job: BriefJob = { coreModule: this.coreModule, rootDir: this.rootDir, input };
      // stdout is the MCP transport, so the worker's own output goes to stderr.
      const worker = new Worker(BRIEF_WORKER_URL, { workerData: job, stdout: true });
      worker.stdout.on('data', (chunk: Buffer) => process.stderr.write(chunk));

      let settled = false;
      const settle = (outcome: () => void) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          outcome();
        }
        worker.terminate().catch(() => {});
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error(`Request timed out after ${this.timeoutMs}ms`))),
        this.timeoutMs,
      );

      worker.once('message', (message: BriefWorkerMessage) =>
        settle(() => ('response' in message ? resolve(message.response) : reject(new Error(message.error)))),
      );
      worker.once('error', (error) => settle(() => reject(error)));
      worker.once('exit', (code) =>
        settle(() => reject(new Error(`the brief worker stopped (exit code ${code}) before it sent a brief`))),
      );
    });
  }
}
