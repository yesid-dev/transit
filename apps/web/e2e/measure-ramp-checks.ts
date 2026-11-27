import { expect, type Locator } from '@playwright/test';

export async function expectRampLightness(swatches: Locator, theme: 'light' | 'dark') {
	await expect(swatches).toHaveCount(5);
	const steps = await swatches.evaluateAll((nodes) => {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
		return nodes.map((node) => {
			ctx.fillStyle = getComputedStyle(node).backgroundColor;
			ctx.fillRect(0, 0, 1, 1);
			const channels = ctx.getImageData(0, 0, 1, 1).data.slice(0, 3);
			const luminance = channels.reduce((sum, channel, index) => {
				const value = channel / 255;
				const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
				return sum + linear * [0.2126, 0.7152, 0.0722][index]!;
			}, 0);
			return {
				lightness:
					luminance > 216 / 24389 ? 116 * Math.cbrt(luminance) - 16 : (luminance * 24389) / 27,
				height: node.getBoundingClientRect().height,
			};
		});
	});
	for (const step of steps) expect(step.height).toBeGreaterThanOrEqual(16);
	const lightness = steps.map((step) => step.lightness);
	const ordered = theme === 'light' ? lightness : [...lightness].reverse();
	expect(ordered[0]).toBeGreaterThanOrEqual(80);
	expect(ordered.at(-1)).toBeLessThanOrEqual(30);
	for (let index = 1; index < ordered.length; index++) {
		expect(ordered[index - 1]! - ordered[index]!).toBeGreaterThanOrEqual(12);
	}
	return lightness;
}
