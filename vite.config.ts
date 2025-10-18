import { defineConfig } from 'vite';

import dts from 'vite-plugin-dts';

export default defineConfig({
	plugins: [
		dts({
			insertTypesEntry: true,
			entryRoot: 'src',
			exclude: 'src/tests'
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
				entryFileNames: `[name].js`,
				chunkFileNames: `[name].js`,
				assetFileNames: `[name].[ext]`
			},
			preserveEntrySignatures: 'strict'
		},
		minify: false
	}
});
