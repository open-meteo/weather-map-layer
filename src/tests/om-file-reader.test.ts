import { WeatherMapLayerFileReader } from '../om-file-reader';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the per-URL memoized reader pool: concurrent reads of different
 * files must not dispose each other's readers (the pre-pool implementation
 * disposed the single shared reader on every setToOmFile), same-URL reads
 * share one reader, and LRU eviction defers disposal until in-flight reads
 * finish.
 */

const mocks = vi.hoisted(() => {
	const created: string[] = [];
	const disposed: string[] = [];
	/** URL → deferred gate that read() awaits, so tests control timing. */
	const readGates = new Map<string, () => void>();
	/** URLs whose gate was opened before their reader was constructed. */
	const preOpened = new Set<string>();

	class MockChildReader {
		constructor(private owner: MockReader) {}
		getDimensions(): number[] {
			return [2, 2];
		}
		scaleFactor(): number {
			return 20;
		}
		async read(): Promise<Float32Array> {
			await this.owner.gate;
			if (this.owner.disposed) throw new Error(`read after dispose: ${this.owner.url}`);
			return new Float32Array([1, 2, 3, 4]);
		}
		async readPrefetch(): Promise<void> {
			await this.owner.gate;
		}
	}

	class MockReader {
		disposed = false;
		gate: Promise<void>;
		constructor(public url: string) {
			this.gate = preOpened.has(url)
				? Promise.resolve()
				: new Promise((resolve) => readGates.set(url, resolve));
		}
		async getChildByName(_name: string): Promise<MockChildReader> {
			return new MockChildReader(this);
		}
		dispose(): void {
			this.disposed = true;
			disposed.push(this.url);
		}
	}

	class MockBackend {
		constructor(private opts: { url: string }) {}
		async asCachedReader(): Promise<MockReader> {
			created.push(this.opts.url);
			return new MockReader(this.opts.url);
		}
	}

	return { created, disposed, readGates, preOpened, MockBackend };
});

vi.mock('@openmeteo/file-reader', () => ({
	OmDataType: { FloatArray: 'FloatArray' },
	OmHttpBackend: mocks.MockBackend,
	LruBlockCache: class {
		async clear(): Promise<void> {}
	}
}));

const openGate = (url: string): void => {
	mocks.preOpened.add(url);
	mocks.readGates.get(url)?.();
};

const makeReader = (maxOpenFiles = 12): WeatherMapLayerFileReader =>
	new WeatherMapLayerFileReader({ useSAB: false, maxOpenFiles });

describe('WeatherMapLayerFileReader – per-URL reader pool', () => {
	beforeEach(() => {
		mocks.created.length = 0;
		mocks.disposed.length = 0;
		mocks.readGates.clear();
		mocks.preOpened.clear();
	});

	it('reads two files concurrently without disposing either reader', async () => {
		const reader = makeReader();

		const p1 = reader.readVariableFromFile('https://a.om', 'temperature_2m');
		const p2 = reader.readVariableFromFile('https://b.om', 'pressure_msl');

		openGate('https://a.om');
		openGate('https://b.om');

		const [d1, d2] = await Promise.all([p1, p2]);
		expect(d1.values).toEqual(new Float32Array([1, 2, 3, 4]));
		expect(d2.values).toEqual(new Float32Array([1, 2, 3, 4]));
		expect(mocks.disposed).toEqual([]);
	});

	it('memoizes the reader per URL', async () => {
		const reader = makeReader();

		openGate('https://a.om');
		const p1 = reader.readVariableFromFile('https://a.om', 'temperature_2m');
		const p2 = reader.readVariableFromFile('https://a.om', 'cloud_cover');
		await Promise.all([p1, p2]);
		await reader.setToOmFile('https://a.om');

		expect(mocks.created).toEqual(['https://a.om']);
	});

	it('evicts least recently used readers beyond maxOpenFiles', async () => {
		const reader = makeReader(2);

		for (const url of ['https://a.om', 'https://b.om', 'https://c.om']) {
			openGate(url);
			await reader.readVariableFromFile(url, 'temperature_2m');
		}

		expect(mocks.created).toEqual(['https://a.om', 'https://b.om', 'https://c.om']);
		expect(mocks.disposed).toEqual(['https://a.om']);
	});

	it('defers eviction disposal until in-flight reads finish', async () => {
		const reader = makeReader(1);

		// Start a read on A but keep it in flight (gate closed)
		const pending = reader.readVariableFromFile('https://a.om', 'temperature_2m');

		// Opening B evicts A from the pool while A's read is still running
		openGate('https://b.om');
		await reader.readVariableFromFile('https://b.om', 'temperature_2m');
		expect(mocks.disposed).toEqual([]);

		// Once A's read completes it must succeed, and only then is A disposed
		openGate('https://a.om');
		const data = await pending;
		expect(data.values).toEqual(new Float32Array([1, 2, 3, 4]));
		await Promise.resolve();
		expect(mocks.disposed).toEqual(['https://a.om']);
	});

	it('legacy setToOmFile + readVariable still works and does not dispose other readers', async () => {
		const reader = makeReader();

		openGate('https://a.om');
		openGate('https://b.om');

		await reader.setToOmFile('https://a.om');
		const pending = reader.readVariable('temperature_2m');

		// Re-pointing to another file (e.g. neighbour-timestep prefetch) must not
		// kill the reader the pending read is using.
		await reader.setToOmFile('https://b.om');
		const data = await pending;

		expect(data.values).toEqual(new Float32Array([1, 2, 3, 4]));
		expect(mocks.disposed).toEqual([]);
	});

	it('throws when readVariable is used before setToOmFile', async () => {
		const reader = makeReader();
		await expect(reader.readVariable('temperature_2m')).rejects.toThrow('Reader not initialized');
	});
});
