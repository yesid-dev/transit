import { expect, type Page } from '@playwright/test';
import { openNetworkCapture } from './capture-fixture';

// Status glyphs carry information independently of their labels (WCAG 1.4.11).
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
		const luminance = ([r, g, b]: number[]) => {
			const channel = (v: number) =>
				(v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
			return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
		};
		return [...document.querySelectorAll('main [data-slot="status-mark"] > .status-glyph')].map(
			(glyph) => {
				const token = glyph.parentElement!.getAttribute('data-status')!.replace('_', '-');
				const style = getComputedStyle(glyph);
				const colour = rgba(style.color);
				let back = rgba(getComputedStyle(document.body).backgroundColor).slice(0, 3);
				let opacity = 1;
				let backgroundFound = false;
				for (let node: Element | null = glyph; node; node = node.parentElement) {
					const nodeStyle = getComputedStyle(node);
					opacity *= Number(nodeStyle.opacity);
					const [r, g, b, a] = rgba(nodeStyle.backgroundColor);
					if (!backgroundFound && a > 0.9) {
						back = [r, g, b];
						backgroundFound = true;
					}
				}
				const alpha = colour[3] * opacity;
				const paint = colour
					.slice(0, 3)
					.map((channel, i) => Math.round(channel * alpha + back[i] * (1 - alpha)));
				const [hi, lo] = [luminance(paint), luminance(back)].sort((a, b) => b - a);
				return {
					mark: glyph.textContent!.trim(),
					token,
					paint,
					back,
					ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
				};
			},
		);
	});
}

export async function openNetwork(page: Page, locale: 'en' | 'fr') {
	await openNetworkCapture(page, locale, [-360, 0, 420, null]);
	await expect(page.locator('main [data-slot="status-mark"] > .status-glyph')).toHaveCount(4);
}

export const weak = (findings: Finding[]) => findings.filter(({ ratio }) => ratio < 3);
