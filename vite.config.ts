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
	build: {
		// The file reader and its WASM binary are bundled (base64-inlined) so the
		// module is self-contained and importable straight from a CDN; the lazily
		// loaded reader chunk therefore exceeds the default size limit.
		chunkSizeWarningLimit: 4000,
		lib: {
			entry: 'src/index.ts',
			formats: ['es'],
			fileName: () => 'index.mjs'
		},
		rolldownOptions: {
			output: {
				chunkFileNames: '[name].mjs'
			}
		}
	}
});
