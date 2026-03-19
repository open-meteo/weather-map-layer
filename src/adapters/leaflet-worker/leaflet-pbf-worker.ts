interface RenderFeature {
	type: 1 | 2 | 3;
	rings: number[][];
	strokeStyle: string;
	lineWidth: number;
	lineCap: string;
	globalAlpha: number;
	fill: boolean;
	pointRadius: number;
}

interface RenderMessage {
	id: number;
	tileSize: number;
	clip: boolean;
	features: RenderFeature[];
}

self.onmessage = (e: MessageEvent<RenderMessage>): void => {
	const { id, tileSize, clip, features } = e.data;
	const canvas = new OffscreenCanvas(tileSize, tileSize);
	const ctx = canvas.getContext('2d');
	if (!ctx) {
		self.postMessage({ id, bitmap: null });
		return;
	}

	if (clip) {
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, 0, tileSize, tileSize);
		ctx.clip();
	}

	for (let i = 0; i < features.length; i++) {
		const f = features[i];
		ctx.strokeStyle = f.strokeStyle;
		ctx.lineWidth = f.lineWidth;
		ctx.lineCap = f.lineCap as CanvasLineCap;
		ctx.globalAlpha = f.globalAlpha;

		if (f.type === 2 || f.type === 3) {
			ctx.beginPath();
			for (let ri = 0; ri < f.rings.length; ri++) {
				const ring = f.rings[ri];
				for (let j = 0; j < ring.length; j += 2) {
					if (j === 0) ctx.moveTo(ring[j], ring[j + 1]);
					else ctx.lineTo(ring[j], ring[j + 1]);
				}
				if (f.type === 3) ctx.closePath();
			}
			ctx.stroke();
			if (f.fill) ctx.fill();
		} else if (f.type === 1) {
			for (let ri = 0; ri < f.rings.length; ri++) {
				const ring = f.rings[ri];
				for (let j = 0; j < ring.length; j += 2) {
					ctx.beginPath();
					ctx.arc(ring[j], ring[j + 1], f.pointRadius, 0, Math.PI * 2);
					ctx.fill();
				}
			}
		}
	}

	if (clip) ctx.restore();
	ctx.globalAlpha = 1;

	const bitmap = canvas.transferToImageBitmap();
	self.postMessage({ id, bitmap }, [bitmap] as unknown as Transferable[]);
};
