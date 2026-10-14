import { createOmProtocol } from './om-protocol-core';
import { WorkerPool } from './worker-pool';

export { defaultOmProtocolSettings } from './om-protocol-core';

/** The `om://` handler for `maplibregl.addProtocol`, rendering in a pool of web workers. */
export const omProtocol = createOmProtocol(new WorkerPool());
