import { defineConfig } from 'vite';

const importMetaUrlPolyfillVariableName = '__import_meta_url__';

export default defineConfig({
	build: {
		emptyOutDir: false, // so it doesn't wipe the main build
		lib: {
			entry: 'src/index.ts',
			name: 'OMWeatherMapLayer', // global variable name for UMD
			formats: ['umd'],
			fileName: (_format) => `index.js`
		},
		rolldownOptions: {
			transform: {
				define: {
					'import.meta.url': importMetaUrlPolyfillVariableName
				}
			},
			output: {
				format: 'umd',
				intro:
					"var _documentCurrentScript = typeof document !== 'undefined' ? document.currentScript : null;" +
					`var ${importMetaUrlPolyfillVariableName} = (typeof document === 'undefined' && typeof location === 'undefined' ? require('u' + 'rl').pathToFileURL(__filename).href : typeof document === 'undefined' ? location.href : (_documentCurrentScript && _documentCurrentScript.tagName.toUpperCase() === 'SCRIPT' && _documentCurrentScript.src || new URL('main.js', document.baseURI).href))`,
				globals: {
					'@openmeteo/file-reader': 'OpenMeteoFileReader',
					'@openmeteo/file-format-wasm': 'OpenMeteoFileFormatWasm'
				}
			}
		},
		minify: true
	}
});
