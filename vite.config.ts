import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
	plugins: [
		dts({
			exclude: ['src/tests'],
			entryRoot: 'src',
			rollupTypes: true,
			insertTypesEntry: true
		})
	],
	optimizeDeps: {
		exclude: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm']
	},
	build: {
		chunkSizeWarningLimit: 1200,
		rollupOptions: {
			external: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm'],
			input: {
				index: 'src/index.ts'
			},
			output: {
				entryFileNames: `[name].mjs`
			},
			preserveEntrySignatures: 'strict'
		},
		minify: false
	}
});
