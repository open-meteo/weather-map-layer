import { MainThreadRenderer } from './node/main-thread-renderer';
import { encodePng } from './node/png';
import { WorkerThreadPool } from './node/worker-thread-pool';
import { createOmProtocol } from './om-protocol-core';

// Functions

export { encodePng };
export { createOmProtocol };
export { getValueFromLatLong, clearBlockCache, clearBackends } from './om-protocol-state';

// Classes

export { MainThreadRenderer, WorkerThreadPool };
export { LruBlockCache } from '@openmeteo/file-reader';

// Objects / Constants

export { defaultOmProtocolSettings } from './om-protocol-core';
export { domainOptions, domainGroups } from './domains';

// Types

export type { Domain, OmProtocolSettings, RgbaTile, TileJSON, TileRenderer } from './types';
export type { WorkerThreadPoolOptions } from './node/worker-thread-pool';

/**
 * The `om://` handler for Node, rendering on a pool of worker threads that
 * starts with the first tile. Same signature as the browser `omProtocol`;
 * `image` requests resolve to an `RgbaTile` (see `encodePng`) instead of an
 * `ImageBitmap`. For a pool of another size, or rendering on the calling
 * thread, build a handler with `createOmProtocol(renderer)`.
 */
export const omProtocol = createOmProtocol(new WorkerThreadPool());
