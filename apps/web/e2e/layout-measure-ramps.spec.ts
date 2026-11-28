import { expect, type Page } from '@playwright/test';
import { minimalDarkStyle } from '../src/lib/components/map/basemap';
import { deltaE00 } from './colour-distance';
import { test } from './layout-test';

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** sRGB channels and relative luminance of each CSS colour, as the page resolves it. */
function resolveColours(page: Page, values: readonly string[], scope?: string) {
	return page.evaluate(
		([values, scope]) => {
			const canvas = document.createElement('canvas');
			canvas.width = canvas.height = 1;
			const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
			const host = document.createElement('div');
			if (scope) host.className = scope;
			document.body.append(host);
			const colours = values.map((value) => {
				const sample = document.createElement('span');
				sample.style.color = value;
				host.append(sample);
				ctx.fillStyle = getComputedStyle(sample).color;
				ctx.fillRect(0, 0, 1, 1);
				const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
				const luminance = rgb.reduce((sum, channel, i) => {
					const s = channel / 255;
					const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
					return sum + linear * [0.2126, 0.7152, 0.0722][i]!;
				}, 0);
				return { rgb, luminance };
			});
			host.remove();
			return colours;
		},
		[values, scope] as const,
	);
}

test('the late-share hour grid has five contrasting, ordered swatches @layout', async ({
	page,
}) => {
	await page.goto(
		'/network?provider=stm&frameMode=record&recordFrom=2026-11-20&recordTo=2026-11-22',
	);
	const grid = page.locator('#hours [data-slot="hour-grid"]');
	const measuredCell = grid.locator('tbody [data-level]').first();
	await expect(measuredCell).toBeVisible();
	await expect(measuredCell).toHaveCSS('border-top-width', '1px');
	await expect(measuredCell).toHaveCSS('border-top-style', 'solid');
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
			edge: color(getComputedStyle(node).borderTopColor).luminance,
			border: getComputedStyle(node).borderTop,
			height: node.getBoundingClientRect().height,
		}));
		return { card, steps };
	});
	for (const [index, { fill, ink, edge, border, height }] of steps.entries()) {
		expect(height).toBeGreaterThanOrEqual(16);
		expect(border).toMatch(/^1px solid /u);
		expect(contrast(edge, card)).toBeGreaterThanOrEqual(3);
		expect(contrast(fill.luminance, ink)).toBeGreaterThanOrEqual(4.5);
		if (index > 0) {
			expect(contrast(fill.luminance, card)).toBeGreaterThan(
				contrast(steps[index - 1].fill.luminance, card),
			);
			expect(deltaE00(steps[index - 1].fill.rgb, fill.rgb)).toBeGreaterThanOrEqual(10);
		}
	}
	expect(steps[0].fill.rgb[2]).toBeGreaterThan(steps[0].fill.rgb[0]);
	expect(new Set(steps[2].fill.rgb).size).toBe(1);
	expect(steps[4].fill.rgb[0]).toBeGreaterThan(steps[4].fill.rgb[2]);
});

test('the map’s five fills separate and stand out more toward the worst @layout', async ({
	page,
}, info) => {
	await page.goto('/network?provider=stm');
	const theme = info.project.use.colorScheme === 'dark' ? 'dark' : 'light';
	const land = minimalDarkStyle(theme).layers.find(({ id }) => id === 'background');
	const landColour = String((land?.paint as Record<string, unknown>)['background-color']);
	const [card, map, ...fills] = await resolveColours(page, [
		'var(--card)',
		landColour,
		...[0, 1, 2, 3, 4].map((level) => `var(--transit-good-to-bad-${level})`),
	]);
	// The map fills, not the hour grid's: outside .good-to-bad-grid.
	const grid = await resolveColours(page, ['var(--transit-good-to-bad-0)'], 'good-to-bad-grid');
	expect(grid[0]!.rgb).not.toEqual(fills[0]!.rgb);
	for (const [index, fill] of fills.entries()) {
		if (index === 0) continue;
		const previous = fills[index - 1]!;
		expect(
			deltaE00(previous.rgb, fill.rgb),
			`step ${index - 1} to ${index}`,
		).toBeGreaterThanOrEqual(10);
		for (const ground of [card!, map!])
			expect(contrast(fill.luminance, ground.luminance), `step ${index}`).toBeGreaterThan(
				contrast(previous.luminance, ground.luminance),
			);
	}
	// Good is a blue that still shows on the map; the worst stands out most.
	expect(contrast(fills[0]!.luminance, map!.luminance)).toBeGreaterThanOrEqual(2.5);
	expect(contrast(fills[4]!.luminance, map!.luminance)).toBeGreaterThanOrEqual(8);
	expect(fills[0]!.rgb[2]).toBeGreaterThan(fills[0]!.rgb[0]!);
	expect(new Set(fills[2]!.rgb).size).toBe(1);
	expect(fills[4]!.rgb[0]).toBeGreaterThan(fills[4]!.rgb[2]!);
});
