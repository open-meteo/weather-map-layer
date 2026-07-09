import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// CJS ships as a single file too; inline the worker (see vite.config.umd.ts).
const inlineWorkerLoader = fileURLToPath(new URL('./src/worker-loader-inline.ts', import.meta.url));

export default defineConfig({
	resolve: {
		alias: [{ find: /^\.\/worker-loader$/, replacement: inlineWorkerLoader }]
	},
	optimizeDeps: {
		exclude: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm']
	},
	build: {
		emptyOutDir: false, // so it doesn't wipe the main build
		chunkSizeWarningLimit: 1200,
		rolldownOptions: {
			external: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm'],
			input: {
				index: 'src/index.ts'
			},
			output: {
				format: 'cjs',
				entryFileNames: `[name].cjs`,
				// keep CJS a single self-contained file (inline any code-split
				// dynamic import) so `require('.../index.cjs')` needs no sibling chunks
				inlineDynamicImports: true
			},
			preserveEntrySignatures: 'strict'
		}
	}
});
