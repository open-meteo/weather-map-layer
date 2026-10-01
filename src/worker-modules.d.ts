/**
 * Vite's inline-worker imports: `./x?worker&inline` resolves to a constructor
 * for a Worker whose script is the bundled module graph of `./x`. Declared
 * here so the imports typecheck without per-site @ts-expect-error comments
 * (which import sorting tends to detach from their line).
 */
declare module '*?worker&inline' {
	const WorkerFactory: new () => Worker;
	export default WorkerFactory;
}
