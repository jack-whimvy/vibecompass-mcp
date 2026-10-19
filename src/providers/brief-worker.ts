import { parentPort, workerData } from 'node:worker_threads';
import { buildBriefResponse, importBriefCore, type BriefJob, type BriefWorkerMessage } from './brief-build.js';

// One get_brief call, off the server's event loop (D-386; review R3). The
// server enforces D-007's limit by terminating this thread, which stops the
// engine even inside synchronous work. Nothing here outlives the call.

const job = workerData as BriefJob;
let message: BriefWorkerMessage;
try {
  message = { response: await buildBriefResponse(await importBriefCore(job.coreModule), job.rootDir, job.input) };
} catch (error) {
  message = { error: error instanceof Error ? error.message : String(error) };
}

parentPort?.postMessage(message);
