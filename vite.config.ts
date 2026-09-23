import dts from 'unplugin-dts/rolldown';
import { type Plugin, defineConfig } from 'vite';

/**
 * The decode worker bundles @openmeteo/file-format-wasm (externals cannot
 * stay external inside an inline worker), whose loader locates its .wasm via
 * `new URL("om_reader_wasm.web.wasm", import.meta.url)`. Inside a blob-URL
 * worker that base is `blob:` and the constructor throws — and the emitted
 * `/assets/...` path would not exist on a consumer's server anyway. Rewrite
 * it to a URL the host injects at worker init (FileReaderConfig
 * .workerWasmUrl); without one the first read fails and the client falls
 * back to main-thread decoding.
 */
const injectedWorkerWasmUrl = (): Plugin => ({
	name: 'om-injected-worker-wasm-url',
	transform(code, id) {
		if (!id.includes('om_reader_wasm.web.js')) return;
		return code.replace(
			'new URL("om_reader_wasm.web.wasm",import.meta.url)',
			'new URL(self.__OM_WASM_URL__)'
		);
	}
});

export default defineConfig({
	plugins: [
		injectedWorkerWasmUrl(),
		dts({
			exclude: ['src/tests'],
			entryRoot: 'src',
			insertTypesEntry: true
		})
	],
	// Asset URLs are resolved relative to the chunk that references them, so the
	// package works from any directory (node_modules, a CDN path), not a site root.
	base: './',
	build: {
		modulePreload: false,
		rolldownOptions: {
			// A plain entry rather than `build.lib`: lib mode always inlines assets,
			// which would turn the file reader's WASM binary into a 2.8 MB base64
			// data URL. As a separate file it transfers a third smaller, compiles
			// while it streams in and can be kept compiled in the browser cache.
			input: { index: 'src/index.ts' },
			output: {
				entryFileNames: '[name].mjs',
				chunkFileNames: '[name].mjs',
				assetFileNames: '[name][extname]'
			},
			preserveEntrySignatures: 'strict'
		}
	},
	worker: {
		// The tile worker is a plain file next to the module, like the WASM binary.
		rolldownOptions: {
			output: {
				entryFileNames: '[name].js'
			}
		}
	}
});
