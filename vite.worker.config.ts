import { defineConfig } from 'vite';

export default defineConfig({
	build: {
		outDir: 'dist/worker',
		emptyOutDir: false, // so it doesn't wipe your main build
		lib: {
			entry: 'src/worker.ts',
			formats: ['es'],
			fileName: () => 'worker.js'
		},
		rollupOptions: {
			external: [], // inline everything!
			output: {
				entryFileNames: `worker.js`,
				// This disables code splitting
				manualChunks: undefined
			}
		},
		minify: false
	}
});
