// Vite resolves `?url` imports to the emitted asset's URL (see vite.config.ts).
declare module '*.bin?url' {
	const url: string;
	export default url;
}
