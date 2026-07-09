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
	optimizeDeps: {
		exclude: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm']
	},
	// Emit module-relative asset URLs (new URL('./assets/x', import.meta.url))
	// instead of absolute '/assets/x'. Absolute paths 404 when another app
	// consumes the built package from node_modules (its dev-server root differs).
	base: './',
	// Ship the worker as a separate ES-module chunk instead of inlining it, so the
	// ESM main entry (index.mjs) stays small — apps that import only utilities
	// (colour scales, parsing…) never pull in the worker. The single-file UMD/CJS
	// builds alias worker-loader back to the inline variant.
	worker: { format: 'es' },
	build: {
		chunkSizeWarningLimit: 1200,
		rolldownOptions: {
			external: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm'],
			input: {
				index: 'src/index.ts'
			},
			output: {
				entryFileNames: `[name].mjs`
			},
			preserveEntrySignatures: 'strict'
		}
	}
});
