import Pbf from 'pbf';

interface Feature {
	id: number;
	type: number;
	properties: {};
	geom: number[];
}

interface Context {
	feature: Feature | undefined;
	keys: string[];
	values: any[];
	keycache: {};
	valuecache: {};
}

// writer for VectorTileLayer
export const writeLayer = (layer: any, pbf: Pbf) => {
	pbf.writeVarintField(15, layer.version || 2);
	pbf.writeStringField(1, layer.name);
	pbf.writeVarintField(5, layer.extent);

	const context: Context = {
		feature: undefined,
		keys: [],
		values: [],
		keycache: {},
		valuecache: {}
	};

	layer.features.forEach((feat: Feature) => {
		context.feature = feat;
		pbf.writeMessage(2, writeFeature, context);
	});

	const keys = context.keys;
	for (let i = 0; i < keys.length; i++) {
		pbf.writeStringField(3, keys[i]);
	}

	const values = context.values;
	for (let i = 0; i < values.length; i++) {
		pbf.writeMessage(4, writeValue, values[i]);
	}
};

export const writeFeature = (context: Context, pbf: Pbf) => {
	const feature = context.feature as Feature;

	if (feature.id !== undefined) {
		pbf.writeVarintField(1, feature.id);
	}

	pbf.writeMessage(2, writeProperties, context);
	pbf.writeVarintField(3, feature.type);
	pbf.writePackedVarint(4, feature.geom);
};

export const command = (cmd: number, length: number) => {
	return (length << 3) + (cmd & 0x7);
};

export const zigzag = (n: number) => {
	return (n << 1) ^ (n >> 31);
};

export const writeGeometry = (feature: any, pbf: Pbf) => {
	const geometry = feature.loadGeometry();
	const type = feature.type;
	let x = 0;
	let y = 0;
	const rings = geometry.length;
	for (let r = 0; r < rings; r++) {
		const ring = geometry[r];
		let count = 1;
		if (type === 1) {
			count = ring.length;
		}
		pbf.writeVarint(command(1, count)); // moveto
		// do not write polygon closing path as lineto
		const lineCount = type === 3 ? ring.length - 1 : ring.length;
		for (let i = 0; i < lineCount; i++) {
			if (i === 1 && type !== 1) {
				pbf.writeVarint(command(2, lineCount - 1)); // lineto
			}
			const dx = ring[i].x - x;
			const dy = ring[i].y - y;
			pbf.writeVarint(zigzag(dx));
			pbf.writeVarint(zigzag(dy));
			x += dx;
			y += dy;
		}
		if (type === 3) {
			pbf.writeVarint(command(7, 1)); // closepath
		}
	}
};

export const writeProperties = (context: any, pbf: Pbf) => {
	const feature = context.feature;
	const keys = context.keys;
	const values = context.values;
	const keycache = context.keycache;
	const valuecache = context.valuecache;

	for (const key in feature.properties) {
		let value = feature.properties[key];

		let keyIndex = keycache[key];
		if (value === null) continue; // don't encode null value properties

		if (typeof keyIndex === 'undefined') {
			keys.push(key);
			keyIndex = keys.length - 1;
			keycache[key] = keyIndex;
		}
		pbf.writeVarint(keyIndex);

		const type = typeof value;
		if (type !== 'string' && type !== 'boolean' && type !== 'number') {
			value = JSON.stringify(value);
		}
		const valueKey = type + ':' + value;
		let valueIndex = valuecache[valueKey];
		if (typeof valueIndex === 'undefined') {
			values.push(value);
			valueIndex = values.length - 1;
			valuecache[valueKey] = valueIndex;
		}
		pbf.writeVarint(valueIndex);
	}
};

export const writeValue = (value: any, pbf: Pbf) => {
	const type = typeof value;
	if (type === 'string') {
		pbf.writeStringField(1, value);
	} else if (type === 'boolean') {
		pbf.writeBooleanField(7, value);
	} else if (type === 'number') {
		if (value % 1 !== 0) {
			pbf.writeDoubleField(3, value);
		} else if (value < 0) {
			pbf.writeSVarintField(6, value);
		} else {
			pbf.writeVarintField(5, value);
		}
	}
};
