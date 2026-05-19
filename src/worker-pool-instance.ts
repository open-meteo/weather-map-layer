import { WorkerPool } from './worker-pool';

/**
 * Shared WorkerPool singleton used by all protocol handler modules.
 * Centralised here so both om-protocol.ts and om-protocol-seamless.ts
 * can import the same instance without creating duplicate pools.
 */
export const workerPool = new WorkerPool();
