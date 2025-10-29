import { defineConfig } from 'vite';

export default defineConfig({
	build: {
		emptyOutDir: false, // so it doesn't wipe the main build
		lib: {
			entry: 'src/index.ts',
			name: 'OpenMeteoMapboxLayer', // global variable name for UMD
			formats: ['umd'],
			fileName: (_format) => `index.js`
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
