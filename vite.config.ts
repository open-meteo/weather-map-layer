import dts from 'unplugin-dts/rolldown';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		dts({
			exclude: ['src/tests'],
			entryRoot: 'src',
			insertTypesEntry: true
		})
	],
	// Asset URLs are resolved relative to the chunk that references them, so the
	// package works from any directory (node_modules, a CDN path), not a site root.
	base: './',
	build: {
		// Not a `lib` build: lib mode always inlines assets, which would turn the
		// file reader's WASM binary into a 2.8 MB base64 data URL. As a separate
		// file it transfers a third smaller, compiles while it streams in and can
		// be kept compiled in the browser cache.
		assetsInlineLimit: 0,
		modulePreload: false,
		rolldownOptions: {
			input: { index: 'src/index.ts' },
			output: {
				entryFileNames: '[name].mjs',
				chunkFileNames: '[name].mjs',
				assetFileNames: '[name][extname]'
			},
			preserveEntrySignatures: 'strict'
		}
	}
});
