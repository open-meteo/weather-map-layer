import type { IconListPixels } from './icons';
const arrowPixelsSource: IconListPixels = {};

for (const [i, _] of Object.entries({ 0: 'arrow' })) {
	const index = Number(i);
	arrowPixelsSource[index] = `images/weather-icons/wi-direction-up2.svg`;
}

export default arrowPixelsSource;
