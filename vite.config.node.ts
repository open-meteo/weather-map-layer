import { defineConfig } from 'vite';

/**
 * The Node entry is a second build rather than a second input of the main
 * one: it must not pull in the worker pool (a `?worker&url` import that only
 * means something in a browser bundle), and its dependencies stay external so
 * that `@openmeteo/file-reader` resolves to its Node build at runtime.
 */
export default defineConfig({
	// No dts plugin: the main build already emits `dist/node/index.d.ts` along with
	// the declarations of every other source file.
	build: {
		ssr: true,
		emptyOutDir: false,
		rolldownOptions: {
			// The render thread's script ships next to the entry, like the
			// browser's tile worker
			input: {
				node: 'src/node/index.ts',
				'node-worker': 'src/node/tile-worker.ts',
				cli: 'src/node/cli.ts'
			},
			external: [/^node:/, '@openmeteo/file-reader', 'pbf', 'point-in-polygon-hao'],
			output: {
				entryFileNames: '[name].mjs',
				chunkFileNames: 'node-[name].mjs',
				// The command is run directly (`npx weather-map-tiles`)
				banner: (chunk) => (chunk.name === 'cli' ? '#!/usr/bin/env node' : '')
			}
		}
	}
});
