interface ImportMetaEnv {
	readonly VITE_DOMAIN: string;
	readonly VITE_VARIABLE: string;
	readonly VITE_TILE_SIZE: string;
	readonly VITE_TILE_OPACITY: string;
	readonly DEV: boolean;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
