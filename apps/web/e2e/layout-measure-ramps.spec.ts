import { expect } from '@playwright/test';
import { test } from './layout-test';

test('the late-share hour grid has five contrasting, ordered swatches @layout', async ({
	page,
}) => {
	await page.goto(
		'/network?provider=stm&frameMode=record&recordFrom=2026-11-20&recordTo=2026-11-22',
	);
	const grid = page.locator('#hours [data-slot="hour-grid"]');
	await expect(grid.locator('tbody [data-level]').first()).toBeVisible();
	await expect(grid.locator('[data-state][data-level]')).toHaveCount(0);
	const swatches = grid.locator('ul[role="list"] [data-level]');
	await expect(swatches).toHaveCount(5);
	const { card, steps } = await swatches.evaluateAll((nodes) => {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
		function color(value: string) {
			ctx.fillStyle = value;
			ctx.fillRect(0, 0, 1, 1);
			const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
			const luminance = rgb.reduce((sum, channel, i) => {
				const s = channel / 255;
				const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
				return sum + linear * [0.2126, 0.7152, 0.0722][i]!;
			}, 0);
			return { rgb, luminance };
		}
		const sample = document.createElement('span');
		sample.style.color = 'var(--card)';
		nodes[0].append(sample);
		const card = color(getComputedStyle(sample).color).luminance;
		sample.remove();
		const steps = nodes.map((node) => ({
			fill: color(getComputedStyle(node).backgroundColor),
			ink: color(getComputedStyle(node).color).luminance,
			height: node.getBoundingClientRect().height,
		}));
		return { card, steps };
	});
	const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
	for (const [index, { fill, ink, height }] of steps.entries()) {
		expect(height).toBeGreaterThanOrEqual(16);
		expect(contrast(fill.luminance, card)).toBeGreaterThanOrEqual(3);
		expect(contrast(fill.luminance, ink)).toBeGreaterThanOrEqual(4.5);
		if (index > 0) expect(fill.luminance).toBeLessThan(steps[index - 1].fill.luminance);
	}
	expect(steps[0].fill.rgb[2]).toBeGreaterThan(steps[0].fill.rgb[0]);
	expect(new Set(steps[2].fill.rgb).size).toBe(1);
	expect(steps[4].fill.rgb[0]).toBeGreaterThan(steps[4].fill.rgb[2]);
});
