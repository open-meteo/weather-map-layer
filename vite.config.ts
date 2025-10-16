import { defineConfig } from 'vite';

import dts from 'vite-plugin-dts';

export default defineConfig({
	plugins: [
		dts({
			insertTypesEntry: true,
			//rollupTypes: true,
			//declarationOnly: true,
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
				index: 'src/index.ts',
				types: 'src/types.ts',

				'om-protocol': 'src/om-protocol.ts',
				'worker-pool': 'src/worker-pool.ts',
				'om-file-reader': 'src/om-protocol.ts',

				'utils/arrow': 'src/utils/arrow.ts',
				'utils/color-scales': 'src/utils/color-scales.ts',
				'utils/domains': 'src/utils/domains.ts',
				'utils/icons': 'src/utils/icons.ts',
				'utils/index': 'src/utils/index.ts',
				'utils/interpolations': 'src/utils/interpolations.ts',
				'utils/math': 'src/utils/math.ts',
				'utils/projections': 'src/utils/projections.ts',
				'utils/variables': 'src/utils/variables.ts'
			},
			output: {
				entryFileNames: `[name].js`,
				chunkFileNames: `[name].js`,
				assetFileNames: `[name].[ext]`
				// name: 'mapbox-layer',
				// format: "esm",
				// inlineDynamicImports: true
			},
			preserveEntrySignatures: 'strict'
		},
		minify: false
	},
	worker: {
		format: 'es',
		rollupOptions: {
			output: {
				entryFileNames: `[name].js`
			}
		}
	}
});
