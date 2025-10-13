import * as maplibregl from 'maplibre-gl';

import type { DomainMetaData } from '../types';
import { Domain } from '../types';

const TILE_SIZE = Number(import.meta.env.VITE_TILE_SIZE);

const beforeLayer = 'waterway-tunnel';

const now = new Date();
now.setHours(now.getHours() + 1, 0, 0, 0);

let omUrl: string;

export const pad = (n: string | number) => {
	return ('0' + n).slice(-2);
};

export const checkClosestDomainInterval = (url: URL) => {
	const t = get(time);
	const domain = get(d);
	if (domain.time_interval > 1) {
		if (t.getUTCHours() % domain.time_interval > 0) {
			const closestUTCHour = t.getUTCHours() - (t.getUTCHours() % domain.time_interval);
			t.setUTCHours(closestUTCHour + domain.time_interval);
			url.searchParams.set('time', t.toISOString().replace(/[:Z]/g, '').slice(0, 15));
		}
	}
	time.set(t);
};

export const closestModelRun = (
	domain: Domain,
	selectedTime: Date,
	latest?: DomainMetaData
) => {
	const year = selectedTime.getUTCFullYear();
	const month = selectedTime.getUTCMonth();
	const date = selectedTime.getUTCDate();

	const closestModelRunUTCHour = selectedTime.getUTCHours() - (selectedTime.getUTCHours() % domain.model_interval);

	const closestModelRun = new Date();
	closestModelRun.setUTCFullYear(year);
	closestModelRun.setUTCMonth(month);
	closestModelRun.setUTCDate(date);
	closestModelRun.setUTCHours(closestModelRunUTCHour);
	closestModelRun.setUTCMinutes(0);
	closestModelRun.setUTCSeconds(0);
	closestModelRun.setUTCMilliseconds(0);

	return closestModelRun
};

let omFileSource: maplibregl.RasterTileSource | undefined;
export const addOmFileLayer = (map: maplibregl.Map) => {
	omUrl = getOMUrl();
	map.addSource('omFileRasterSource', {
		url: 'om://' + omUrl,
		type: 'raster',
		tileSize: TILE_SIZE
	});

	omFileSource = map.getSource('omFileRasterSource');
	if (omFileSource) {
		omFileSource.on('error', (e) => {
			checked = 0;
			clearInterval(checkSourceLoadedInterval);
		});
	}

	map.addLayer(
		{
			id: 'omFileRasterLayer',
			type: 'raster',
			source: 'omFileRasterSource'
		},
		beforeLayer
	);
};

let checked = 0;
let checkSourceLoadedInterval: ReturnType<typeof setInterval>;
export const changeOMfileURL = (
	map: maplibregl.Map,
	url: URL,
	latest?: DomainMetaData | undefined,
	resetBounds = true
) => {
	if (map && omFileSource) {

		mB.set(map.getBounds());
		if (resetBounds) {
			pB.set(map.getBounds());
		}

		checkClosestModelRun(map, url, latest);

		omUrl = getOMUrl();
		omFileSource.setUrl('om://' + omUrl);

		checkSourceLoadedInterval = setInterval(() => {
			checked++;
			if ((omFileSource && omFileSource.loaded()) || checked >= 200) {
				if (checked >= 200) {
					// Timeout after 10s
					toast.error('Request timed out');
				}
				checked = 0;
				loading.set(false);
				clearInterval(checkSourceLoadedInterval);
			}
		}, 50);
	}
};

export const getOMUrl = () => {
	const domain = get(d);
	const modelRun = get(mR);
	const paddedBounds = get(pB);
	if (paddedBounds) {
		return `https://map-tiles.open-meteo.com/data_spatial/${domain.value}/${modelRun.getUTCFullYear()}/${pad(modelRun.getUTCMonth() + 1)}/${pad(modelRun.getUTCDate())}/${pad(modelRun.getUTCHours())}00Z/${get(time).getUTCFullYear()}-${pad(get(time).getUTCMonth() + 1)}-${pad(get(time).getUTCDate())}T${pad(get(time).getUTCHours())}00.om?dark=${mode.current === 'dark'}&variable=${get(variables)[0].value}&bounds=${paddedBounds.getSouth()},${paddedBounds.getWest()},${paddedBounds.getNorth()},${paddedBounds.getEast()}&partial=${preferences.partial}`;
	} else {
		return `https://map-tiles.open-meteo.com/data_spatial/${domain.value}/${modelRun.getUTCFullYear()}/${pad(modelRun.getUTCMonth() + 1)}/${pad(modelRun.getUTCDate())}/${pad(modelRun.getUTCHours())}00Z/${get(time).getUTCFullYear()}-${pad(get(time).getUTCMonth() + 1)}-${pad(get(time).getUTCDate())}T${pad(get(time).getUTCHours())}00.om?dark=${mode.current === 'dark'}&variable=${get(variables)[0].value}&partial=${preferences.partial}`;
	}
};
