// The tile-render worker as a Worker constructor.
//
// This (default) variant loads it NON-INLINE — Vite emits the worker as a
// separate chunk — so the ESM build's main entry (index.mjs) stays small and any
// heavy, optional code the worker pulls in can code-split out of it. The
// single-file UMD and CJS builds alias this module to `worker-loader-inline.ts`
// (see vite.config.umd.ts / vite.config.cjs.ts) so they stay self-contained.
// @ts-expect-error virtual worker import resolved by Vite
import TileWorker from './worker?worker';

export default TileWorker as { new (): Worker };
