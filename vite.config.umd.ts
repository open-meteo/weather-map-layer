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
	build: {
		lib: {
			entry: 'src/index.ts', // or your main entry
			name: 'OpenMeteoMapboxLayer', // global variable name for UMD
			formats: ['umd'],
			fileName: (format) => `index.js`
		},
		rollupOptions: {
			// external: ['@openmeteo/file-reader', '@openmeteo/file-format-wasm'],
			output: {
				globals: {
					'@openmeteo/file-reader': 'OpenMeteoFileReader',
					'@openmeteo/file-format-wasm': 'OpenMeteoFileFormatWasm'
				}
			}
		},
		minify: false
	}
});
