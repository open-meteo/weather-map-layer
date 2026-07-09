// Inline variant of the tile-render worker (see worker-loader.ts). Vite embeds
// the whole worker as a base64/blob inside the bundle, so the output is a single
// self-contained file. Used by the UMD and CJS builds, which are meant to be
// dropped in via a <script> tag / required directly with no separate assets to
// serve, via a resolve.alias that redirects './worker-loader' here.
// @ts-expect-error virtual worker import resolved by Vite
import TileWorker from './worker?worker&inline';

export default TileWorker as { new (): Worker };
