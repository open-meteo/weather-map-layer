import { modPositive } from './math';

/**
 * Implementation of a Gaussian grid projection for mapping, specifically the O1280 version used by ECMWF IFS
 */
export class GaussianGrid {
	private readonly latitudeLines: number;

	/// 1280 for O1280
	constructor(latitudeLines: number) {
		this.latitudeLines = latitudeLines;
	}

	/**
	 * Number of points in the grid
	 */
	private get count(): number {
		return 4 * this.latitudeLines * (this.latitudeLines + 9); // 6599680
	}

	/**
	 * Get the number of points in a specific latitude line
	 * @param y - The latitude line index
	 */
	nxOf(y: number): number {
		return y < this.latitudeLines ? 20 + y * 4 : (2 * this.latitudeLines - y - 1) * 4 + 20;
	}

	private integral(y: number): number {
		return y < this.latitudeLines
			? 2 * y * y + 18 * y
			: this.count -
					(2 * (2 * this.latitudeLines - y) * (2 * this.latitudeLines - y) +
						18 * (2 * this.latitudeLines - y));
	}

	/**
	 * Get the latitude and longitude coordinates for a grid point
	 */
	/*getCoordinates(gridpoint: number): { latitude: number; longitude: number } {
		const { y: y, x: x, nx: nx } = this.getPos(gridpoint);

		const dx = 360 / nx;
		const dy = 180 / (2 * this.latitudeLines + 0.5);

		const lon = x * dx;
		const adjustedLon = lon >= 180 ? lon - 360 : lon;

		return {
			latitude: (this.latitudeLines - y - 1) * dy + dy / 2,
			longitude: adjustedLon
		};
	}*/

	/**
	 * Find the grid point index for given latitude and longitude
	 */
	/*findPoint(lat: number, lon: number): number {
		const dy = 180 / (2 * this.latitudeLines + 0.5);
		const y =
			(Math.round(this.latitudeLines - 1 - (lat - dy / 2) / dy) + 2 * this.latitudeLines) %
			(2 * this.latitudeLines);

		const nx = this.nxOf(y);
		const dx = 360 / nx;

		const x = (Math.round(lon / dx) + nx) % nx;
		return this.integral(y) + x;
	}*/

	/*getPos(gridpoint: number): { y: number; x: number; nx: number } {
		const y =
			gridpoint < this.count / 2
				? Math.floor((Math.sqrt(2 * gridpoint + 81) - 9) / 2)
				: 2 * this.latitudeLines -
					1 -
					Math.floor((Math.sqrt(2 * (this.count - gridpoint - 1) + 81) - 9) / 2);

		const integral = this.integral(y);
		const x = gridpoint - integral;
		const nx = this.nxOf(y);

		return { y, x, nx };
	}*/

	/// Values is the 1D array of all HRES values (6 million something values)
	getLinearInterpolatedValue(values: Float32Array, lat: number, lon: number): number {
		const latitudeLines = this.latitudeLines;
		const dy = 180 / (2 * latitudeLines + 0.5);
		const yLower = modPositive(
			Math.floor(latitudeLines - 1 - (lat - dy / 2) / dy),
			2 * latitudeLines
		);
		const yFraction = modPositive(latitudeLines - 1 - (lat - dy / 2) / dy, 1);
		const yUpper = yLower + 1;
		const nxLower = this.nxOf(yLower);
		const nxUpper = this.nxOf(yUpper);
		const dxLower = 360 / nxLower;
		const dxUpper = 360 / nxUpper;
		const xLower0 = modPositive(Math.floor(lon / dxLower), nxLower);
		const xUpper0 = modPositive(Math.floor(lon / dxUpper), nxUpper);
		const integralLower = this.integral(yLower);
		const integralUpper = this.integral(yUpper);
		const xFractionLower = modPositive(lon / dxLower, 1);
		const xFractionUpper = modPositive(lon / dxUpper, 1);
		const p0 = values[integralLower + xLower0];
		const p1 = values[integralLower + ((xLower0 + 1) % nxLower)];
		const p2 = values[integralUpper + xUpper0];
		const p3 = values[integralUpper + ((xUpper0 + 1) % nxUpper)];
		return (
			p0 * (1 - xFractionLower) * (1 - yFraction) +
			p1 * xFractionLower * (1 - yFraction) +
			p2 * (1 - xFractionUpper) * yFraction +
			p3 * xFractionUpper * yFraction
		);
	}

	/// Values is the 1D array of all HRES values (6 million something values)
	getNearestNeighborValue(values: Float32Array, lat: number, lon: number): number {
		const latitudeLines = this.latitudeLines;
		const dy = 180 / (2 * latitudeLines + 0.5);
		const y = modPositive(Math.round(latitudeLines - 1 - (lat - dy / 2) / dy), 2 * latitudeLines);
		const nx = this.nxOf(y);
		const dx = 360 / nx;
		const x = modPositive(Math.floor(lon / dx), nx);
		const integral = this.integral(y);
		const index = integral + x;
		return values[index];
	}
}
