import {
	degreesToRadians,
	lat2tile,
	lon2tile,
	radiansToDegrees,
	tile2lat,
	tile2lon
} from '../utils/math';

import type {
	LAEAProjectionData,
	LCCProjectionData,
	ProjectionData,
	RotatedLatLonProjectionData,
	StereographicProjectionData
} from '../types';

export function createProjection(opts: ProjectionData): Projection {
	switch (opts.name) {
		case 'StereographicProjection':
			return new StereographicProjection(opts);
		case 'RotatedLatLonProjection':
			return new RotatedLatLonProjection(opts);
		case 'LambertConformalConicProjection':
			return new LambertConformalConicProjection(opts);
		case 'LambertAzimuthalEqualAreaProjection':
			return new LambertAzimuthalEqualAreaProjection(opts);
		default:
			// This ensures exhaustiveness checking
			const _exhaustive: never = opts;
			throw new Error(`Unknown projection: ${_exhaustive}`);
	}
}

export interface Projection {
	forward(latitude: number, longitude: number): [x: number, y: number];
	reverse(x: number, y: number): [latitude: number, longitude: number];
}

export class MercatorProjection implements Projection {
	forward(latitude: number, longitude: number): [x: number, y: number] {
		const x = lon2tile(longitude, 0);
		const y = lat2tile(latitude, 0);
		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		const lon = tile2lon(x, 0);
		const lat = tile2lat(y, 0);
		return [lat, lon];
	}
}

export class RotatedLatLonProjection implements Projection {
	θ: number;
	ϕ: number;

	constructor(projectionData: RotatedLatLonProjectionData) {
		this.θ = degreesToRadians(90 + projectionData.rotatedLat);
		this.ϕ = degreesToRadians(projectionData.rotatedLon);
	}

	forward(latitude: number, longitude: number): [x: number, y: number] {
		const lon = degreesToRadians(longitude);
		const lat = degreesToRadians(latitude);

		const x1 = Math.cos(lon) * Math.cos(lat);
		const y1 = Math.sin(lon) * Math.cos(lat);
		const z1 = Math.sin(lat);

		const x2 =
			Math.cos(this.θ) * Math.cos(this.ϕ) * x1 +
			Math.cos(this.θ) * Math.sin(this.ϕ) * y1 +
			Math.sin(this.θ) * z1;
		const y2 = -Math.sin(this.ϕ) * x1 + Math.cos(this.ϕ) * y1;
		const z2 =
			-Math.sin(this.θ) * Math.cos(this.ϕ) * x1 -
			Math.sin(this.θ) * Math.sin(this.ϕ) * y1 +
			Math.cos(this.θ) * z1;

		const x = -1 * radiansToDegrees(Math.atan2(y2, x2));
		const y = -1 * radiansToDegrees(Math.asin(z2));

		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		const lon1 = degreesToRadians(x);
		const lat1 = degreesToRadians(y);

		// quick solution without conversion in cartesian space
		const lat2 =
			-1 *
			Math.asin(
				Math.cos(this.θ) * Math.sin(lat1) - Math.cos(lon1) * Math.sin(this.θ) * Math.cos(lat1)
			);
		const lon2 =
			-1 *
			(Math.atan2(
				Math.sin(lon1),
				Math.tan(lat1) * Math.sin(this.θ) + Math.cos(lon1) * Math.cos(this.θ)
			) -
				this.ϕ);

		const lon = ((radiansToDegrees(lon2) + 180) % 360) - 180;
		const lat = radiansToDegrees(lat2);

		return [lat, lon];
	}
}

export class LambertConformalConicProjection implements Projection {
	ρ0;
	F;
	n;
	λ0;
	R = 6370.997; // Radius of the Earth

	constructor(projectionData: LCCProjectionData) {
		const λ0_dec = projectionData.λ0;
		const ϕ0_dec = projectionData.ϕ0;
		const ϕ1_dec = projectionData.ϕ1;
		const ϕ2_dec = projectionData.ϕ2;
		const radius = projectionData.radius;

		this.λ0 = degreesToRadians((((λ0_dec as number) + 180) % 360) - 180);
		const ϕ0 = degreesToRadians(ϕ0_dec as number);
		const ϕ1 = degreesToRadians(ϕ1_dec as number);
		const ϕ2 = degreesToRadians(ϕ2_dec as number);

		if (ϕ1 == ϕ2) {
			this.n = Math.sin(ϕ1);
		} else {
			this.n =
				Math.log(Math.cos(ϕ1) / Math.cos(ϕ2)) /
				Math.log(Math.tan(Math.PI / 4 + ϕ2 / 2) / Math.tan(Math.PI / 4 + ϕ1 / 2));
		}
		this.F = (Math.cos(ϕ1) * Math.pow(Math.tan(Math.PI / 4 + ϕ1 / 2), this.n)) / this.n;
		this.ρ0 = this.F / Math.pow(Math.tan(Math.PI / 4 + ϕ0 / 2), this.n);

		if (radius) {
			this.R = radius;
		}
	}

	forward(latitude: number, longitude: number): [x: number, y: number] {
		const ϕ = degreesToRadians(latitude);
		const λ = degreesToRadians(longitude);
		// If (λ - λ0) exceeds the range:±: 180°, 360° should be added or subtracted.
		const θ = this.n * (λ - this.λ0);

		const p = this.F / Math.pow(Math.tan(Math.PI / 4 + ϕ / 2), this.n);
		const x = this.R * p * Math.sin(θ);
		const y = this.R * (this.ρ0 - p * Math.cos(θ));
		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		const x_scaled = x / this.R;
		const y_scaled = y / this.R;

		const θ =
			this.n >= 0
				? Math.atan2(x_scaled, this.ρ0 - y_scaled)
				: Math.atan2(-1 * x_scaled, y_scaled - this.ρ0);
		const ρ =
			(this.n > 0 ? 1 : -1) * Math.sqrt(Math.pow(x_scaled, 2) + Math.pow(this.ρ0 - y_scaled, 2));

		const ϕ_rad = 2 * Math.atan(Math.pow(this.F / ρ, 1 / this.n)) - Math.PI / 2;
		const λ_rad = this.λ0 + θ / this.n;

		const λ = radiansToDegrees(λ_rad);

		const lat = radiansToDegrees(ϕ_rad);
		const lon = λ > 180 ? λ - 360 : λ;

		return [lat, lon];
	}
}

export class LambertAzimuthalEqualAreaProjection implements Projection {
	λ0;
	ϕ1;
	R = 6371229; // Radius of the Earth

	constructor(projectionData: LAEAProjectionData) {
		const λ0_dec = projectionData.λ0 as number;
		const ϕ1_dec = projectionData.ϕ1 as number;
		const radius = projectionData.radius;
		this.λ0 = degreesToRadians(λ0_dec);
		this.ϕ1 = degreesToRadians(ϕ1_dec);
		if (radius) {
			this.R = radius;
		}
	}

	forward(latitude: number, longitude: number): [x: number, y: number] {
		const λ = degreesToRadians(longitude);
		const ϕ = degreesToRadians(latitude);

		const k = Math.sqrt(
			2 /
				(1 +
					Math.sin(this.ϕ1) * Math.sin(ϕ) +
					Math.cos(this.ϕ1) * Math.cos(ϕ) * Math.cos(λ - this.λ0))
		);

		const x = this.R * k * Math.cos(ϕ) * Math.sin(λ - this.λ0);
		const y =
			this.R *
			k *
			(Math.cos(this.ϕ1) * Math.sin(ϕ) - Math.sin(this.ϕ1) * Math.cos(ϕ) * Math.cos(λ - this.λ0));

		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		x = x / this.R;
		y = y / this.R;
		const ρ = Math.sqrt(x * x + y * y);
		const c = 2 * Math.asin(0.5 * ρ);
		const ϕ = Math.asin(
			Math.cos(c) * Math.sin(this.ϕ1) + (y * Math.sin(c) * Math.cos(this.ϕ1)) / ρ
		);
		const λ =
			this.λ0 +
			Math.atan(
				(x * Math.sin(c)) /
					(ρ * Math.cos(this.ϕ1) * Math.cos(c) - y * Math.sin(this.ϕ1) * Math.sin(c))
			);

		const lat = radiansToDegrees(ϕ);
		const lon = radiansToDegrees(λ);

		return [lat, lon];
	}
}

export class StereographicProjection implements Projection {
	λ0: number; // Central longitude
	sinϕ1: number; // Sinus of central latitude
	cosϕ1: number; // Cosine of central latitude
	R = 6371229; // Radius of Earth

	constructor(projectionData: StereographicProjectionData) {
		this.λ0 = degreesToRadians(projectionData.longitude);
		this.sinϕ1 = Math.sin(degreesToRadians(projectionData.latitude));
		this.cosϕ1 = Math.cos(degreesToRadians(projectionData.latitude));
		if (projectionData.radius) {
			this.R = projectionData.radius;
		}
	}

	forward(latitude: number, longitude: number): [x: number, y: number] {
		const ϕ = degreesToRadians(latitude);
		const λ = degreesToRadians(longitude);
		const k =
			(2 * this.R) /
			(1 + this.sinϕ1 * Math.sin(ϕ) + this.cosϕ1 * Math.cos(ϕ) * Math.cos(λ - this.λ0));
		const x = k * Math.cos(ϕ) * Math.sin(λ - this.λ0);
		const y = k * (this.cosϕ1 * Math.sin(ϕ) - this.sinϕ1 * Math.cos(ϕ) * Math.cos(λ - this.λ0));
		return [x, y];
	}

	reverse(x: number, y: number): [latitude: number, longitude: number] {
		const p = Math.sqrt(x * x + y * y);
		const c = 2 * Math.atan2(p, 2 * this.R);
		const ϕ = Math.asin(Math.cos(c) * this.sinϕ1 + (y * Math.sin(c) * this.cosϕ1) / p);
		const λ =
			this.λ0 +
			Math.atan2(x * Math.sin(c), p * this.cosϕ1 * Math.cos(c) - y * this.sinϕ1 * Math.sin(c));

		const lat = radiansToDegrees(ϕ);
		const lon = radiansToDegrees(λ);

		return [lat, lon];
	}
}
