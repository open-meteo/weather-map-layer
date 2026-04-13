import { defineConfig } from 'vite';

export default defineConfig({
	optimizeDeps: {
		exclude: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm']
	},
	build: {
		emptyOutDir: false, // so it doesn't wipe the main build
		chunkSizeWarningLimit: 1200,
		rollupOptions: {
			external: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm'],
			input: {
				index: 'src/index.ts'
			},
			output: {
				format: 'cjs',
				entryFileNames: `[name].cjs`
			},
			preserveEntrySignatures: 'strict'
		},
		minify: false
	}
});
