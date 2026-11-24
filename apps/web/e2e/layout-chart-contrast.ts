import { expect, type Page } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import { captureFleet, captureUrl } from './capture-fixture';

// Status colours on chart marks are non-text graphics: each needs 3:1 against the surface it
// sits on (WCAG 1.4.11). On time is the page ink in each theme, so a softened on-time bar or a
// forced-colours Canvas of the other lightness can lose it.
export type Finding = {
	mark: string;
	token: string;
	paint: number[];
	back: number[];
	ratio: number;
};

export function statusMarkContrast(page: Page) {
	return page.evaluate(() => {
		const canvas = document.createElement('canvas');
		canvas.width = canvas.height = 1;
		const context = canvas.getContext('2d', { willReadFrequently: true })!;
		const rgba = (colour: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = '#000';
			context.fillStyle = colour;
			context.fillRect(0, 0, 1, 1);
			const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
			return [r, g, b, a / 255];
		};
		// Resolve each status token where the mark paints it: inside its own SVG, whose fill and
		// stroke the browser does not force.
		const tokenMaps = new Map<SVGSVGElement, Map<string, string>>();
		const tokensFor = (svg: SVGSVGElement) => {
			let tokens = tokenMaps.get(svg);
			if (tokens) return tokens;
			tokens = new Map();
			for (const name of ['early', 'on-time', 'late', 'unknown']) {
				const probe = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
				probe.style.fill = `var(--dataviz-status-${name})`;
				svg.append(probe);
				tokens.set(rgba(getComputedStyle(probe).fill).join(), name);
				probe.remove();
			}
			tokenMaps.set(svg, tokens);
			return tokens;
		};
		const luminance = ([r, g, b]: number[]) => {
			const channel = (v: number) =>
				(v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
			return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
		};
		const ratio = (a: number[], b: number[]) => {
			const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
			return (hi + 0.05) / (lo + 0.05);
		};
		const surface = (element: Element) => {
			for (let node: Element | null = element.closest('svg'); node; node = node.parentElement) {
				const [r, g, b, a] = rgba(getComputedStyle(node).backgroundColor);
				if (a > 0.9) return [r, g, b];
			}
			return rgba(getComputedStyle(document.body).backgroundColor).slice(0, 3);
		};
		const findings: {
			mark: string;
			token: string;
			paint: number[];
			back: number[];
			ratio: number;
		}[] = [];
		const marks = document.querySelectorAll<SVGGraphicsElement>(
			'main svg :is(rect, path, circle, line, polyline, polygon)',
		);
		for (const mark of marks) {
			const box = mark.getBoundingClientRect();
			if (!box.width && !box.height) continue;
			const style = getComputedStyle(mark);
			if (style.display === 'none' || style.visibility === 'hidden') continue;
			let opacity = 1;
			for (
				let node: Element | null = mark;
				node && node.tagName !== 'svg';
				node = node.parentElement
			)
				opacity *= Number(getComputedStyle(node).opacity);
			const back = surface(mark);
			const tokens = tokensFor(mark.ownerSVGElement ?? (mark as unknown as SVGSVGElement));
			for (const [paint, alpha] of [
				[style.fill, Number(style.fillOpacity)],
				[parseFloat(style.strokeWidth) > 0 ? style.stroke : 'none', Number(style.strokeOpacity)],
			] as const) {
				if (paint === 'none' || paint.startsWith('url(')) continue;
				const colour = rgba(paint);
				const token = tokens.get(colour.join());
				if (!token) continue;
				const a = colour[3] * alpha * opacity;
				const painted = colour.slice(0, 3).map((c, i) => Math.round(c * a + back[i] * (1 - a)));
				findings.push({
					mark: `${mark.tagName.toLowerCase()}.${String(mark.className.baseVal).split(' ')[0]}`,
					token,
					paint: painted,
					back,
					ratio: Math.round(ratio(painted, back) * 100) / 100,
				});
			}
		}
		return findings;
	});
}

export async function openNetwork(page: Page, locale: 'en' | 'fr') {
	await page.clock.setFixedTime(Date.parse('2026-08-29T12:00:30Z'));
	await page.route('**/v1/**', async (route) => {
		const url = new URL(route.request().url());
		url.pathname = `/__layout/fresh${url.pathname}`;
		await route.fulfill({ response: await route.fetch({ url: url.href }) });
	});
	// Every status band, so the status mix and the delay histogram draw each colour.
	const delays = [
		[20, -360],
		[200, 0],
		[40, 180],
		[30, 420],
		[31, null],
	] as const;
	await page.route(captureUrl, (route) =>
		route.fulfill({
			json: captureFleet(
				Date.parse('2026-08-29T12:00:00Z'),
				'stm',
				delays.flatMap(([n, delay]) => Array.from({ length: n }, () => delay)),
			),
		}),
	);
	await page.goto(`${localizeHref('/network', locale)}?provider=stm`, { waitUntil: 'networkidle' });
	// Charts measure their frame before drawing, so bring each section into view.
	for (const section of await page.locator('[data-network-section]').all())
		await section.scrollIntoViewIfNeeded();
	await expect(page.locator('rect.dv-histmark-ontime').first()).toBeAttached();
	await expect(
		page.locator('[data-network-section="network-status-mix"] rect.dv-share-seg'),
	).toHaveCount(4);
}

export const weak = (findings: Finding[]) => findings.filter(({ ratio }) => ratio < 3);
