import { defineConfig } from 'vite';

export default defineConfig({
	build: {
		emptyOutDir: false, // so it doesn't wipe your main build
		lib: {
			entry: 'src/index.ts', // or your main entry
			name: 'OpenMeteoMapboxLayer', // global variable name for UMD
			formats: ['umd'],
			fileName: 'index.js'
		},
		rollupOptions: {
			output: {
				globals: {
					'@openmeteo/file-reader': 'OpenMeteoFileReader',
					'@openmeteo/file-format-wasm': 'OpenMeteoFileFormatWasm'
				}
			}
		},
		minify: true
	}
});
