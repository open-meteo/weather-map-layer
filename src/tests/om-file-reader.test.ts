import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression tests for the per-URL reader LRU in WeatherMapLayerFileReader.
 *
 * The maps app's postReadCallback prefetches upcoming timesteps, so rapid time
 * stepping opens more readers than MAX_OPEN_READERS. Eviction must never
 * dispose a reader that still has an in-flight read/prefetch ("Reader not
 * initialized" crash), only once its last operation has released it.
 */

const openReaders: FakeFileReader[] = [];
const gates = new Map<string, Promise<void>>();

class FakeChild {
	constructor(
		private parent: FakeFileReader,
		private gate?: Promise<void>
	) {}

	getDimensions() {
		return [4, 4];
	}

	scaleFactor() {
		return 20;
	}

	async read() {
		if (this.gate) await this.gate;
		this.parent.assertAlive();
		return new Float32Array(16);
	}

	async readPrefetch() {
		if (this.gate) await this.gate;
		this.parent.assertAlive();
	}
}

class FakeFileReader {
	disposed = false;

	constructor(readonly url: string) {
		openReaders.push(this);
	}

	assertAlive() {
		if (this.disposed) throw new Error('Reader not initialized');
	}

	async getChildByName(_name: string) {
		this.assertAlive();
		return new FakeChild(this, gates.get(this.url));
	}

	dispose() {
		this.disposed = true;
	}
}

vi.mock('@openmeteo/file-reader', () => ({
	OmDataType: { FloatArray: 'FloatArray' },
	LruBlockCache: class {},
	OmHttpBackend: class {
		private url: string;
		constructor(opts: { url: string }) {
			this.url = opts.url;
		}
		async asCachedReader() {
			return new FakeFileReader(this.url);
		}
	}
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('WeatherMapLayerFileReader reader LRU', () => {
	beforeEach(() => {
		openReaders.length = 0;
		gates.clear();
	});

	it('keeps an evicted reader alive until its in-flight read finishes', async () => {
		const { WeatherMapLayerFileReader } = await import('../om-file-reader');
		const reader = new WeatherMapLayerFileReader();

		let releaseGate!: () => void;
		gates.set('url-0', new Promise<void>((resolve) => (releaseGate = resolve)));

		// Start a read that blocks inside the fake child
		const pending = reader.readVariableFromUrl('url-0', 'temperature_2m');
		await tick();

		// Open enough other readers to push url-0 out of the LRU
		for (let i = 1; i <= 8; i++) {
			await reader.setToOmFile(`url-${i}`);
		}

		const r0 = openReaders.find((r) => r.url === 'url-0')!;
		expect(r0).toBeDefined();
		// Evicted, but still referenced by the in-flight read — must not be disposed
		expect(r0.disposed).toBe(false);

		releaseGate();
		await expect(pending).resolves.toMatchObject({ values: expect.any(Float32Array) });

		// After the read released its reference, the evicted reader is disposed
		await tick();
		expect(r0.disposed).toBe(true);
	});

	it('disposes idle evicted readers and keeps the LRU within its cap', async () => {
		const { WeatherMapLayerFileReader } = await import('../om-file-reader');
		const reader = new WeatherMapLayerFileReader();

		for (let i = 0; i < 9; i++) {
			await reader.setToOmFile(`url-${i}`);
		}
		await tick();

		const disposed = openReaders.filter((r) => r.disposed).map((r) => r.url);
		const alive = openReaders.filter((r) => !r.disposed);
		expect(disposed).toEqual(['url-0', 'url-1', 'url-2']);
		expect(alive).toHaveLength(6);
	});

	it('survives prefetch churn across many URLs without touching live readers', async () => {
		const { WeatherMapLayerFileReader } = await import('../om-file-reader');
		const reader = new WeatherMapLayerFileReader();

		// Simulate the maps postReadCallback: for each timestep, read the current
		// file while prefetching the next ones — all overlapping.
		const ops: Promise<unknown>[] = [];
		for (let i = 0; i < 12; i++) {
			ops.push(reader.readVariableFromUrl(`step-${i}`, 'temperature_2m'));
			await reader.setToOmFile(`step-${i + 1}`);
			ops.push(reader.prefetchVariable('temperature_2m'));
			ops.push(reader.prefetchVariableFromUrl(`step-${i + 2}`, 'temperature_2m'));
		}

		await expect(Promise.all(ops)).resolves.toBeDefined();
	});
});
