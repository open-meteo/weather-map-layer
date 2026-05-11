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
		},
		minify: false
	}
});
