export const EARTH_RADIUS_METERS = 6371000;
export const MERCATOR_LATITUDE_LIMIT = 85.0511287798066;

export const advectLonLat = (
	longitude: number,
	latitude: number,
	u: number,
	v: number,
	seconds: number
): [longitude: number, latitude: number] => {
	const latitudeRadians = (latitude * Math.PI) / 180;
	const cosLatitude = Math.max(0.01, Math.cos(latitudeRadians));
	const latitudeDelta = ((v * seconds) / EARTH_RADIUS_METERS) * (180 / Math.PI);
	const longitudeDelta = ((u * seconds) / (EARTH_RADIUS_METERS * cosLatitude)) * (180 / Math.PI);
	return [
		longitude + longitudeDelta,
		Math.max(-MERCATOR_LATITUDE_LIMIT, Math.min(MERCATOR_LATITUDE_LIMIT, latitude + latitudeDelta))
	];
};

export const advectLonLatRK2 = (
	longitude: number,
	latitude: number,
	seconds: number,
	sample: (longitude: number, latitude: number) => [u: number, v: number]
): [longitude: number, latitude: number] => {
	const [u0, v0] = sample(longitude, latitude);
	const midpoint = advectLonLat(longitude, latitude, u0, v0, seconds * 0.5);
	const [uMidpoint, vMidpoint] = sample(midpoint[0], midpoint[1]);
	return advectLonLat(longitude, latitude, uMidpoint, vMidpoint, seconds);
};

export const computeParticleCount = (
	cssWidth: number,
	cssHeight: number,
	density: number,
	minimum: number = 4096,
	maximum: number = 65536
): number => Math.max(minimum, Math.min(maximum, Math.round(cssWidth * cssHeight * density)));
