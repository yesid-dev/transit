import { createHash } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import {
	doubleText,
	focusRing,
	minimumTargetSize,
	textDefects,
	waitForFrameClearance,
} from './layout-helpers';

export const widths = [320, 390, 768, 1024, 1440] as const;
export const budgetWidths = [390, 1440] as const;
const controls =
	'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable]';
const answer = '[data-slot="screen-answer"], [data-slot="screen-state"]';
const figure = answer + ', figure, [data-slot="chart-frame"], table';
const disclosure =
	'main details:not([open]) > summary, main button[aria-expanded="false"][aria-controls]:not([aria-haspopup]), main button[data-section-trigger][aria-expanded="false"]';

const fingerprint = (values: string[]) =>
	createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 16);

export function setWidth(page: Page, width: number) {
	return page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
}

export async function settled(page: Page) {
	await waitForFrameClearance(page);
	await page.evaluate(
		() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
	);
}

export async function openDisclosures(page: Page) {
	// A responsive variant can introduce a new trigger. Revisit the set after each
	// opening so disclosures inside newly revealed content are included.
	const closed = page.locator(disclosure).filter({ visible: true });
	while (await closed.count()) {
		const trigger = closed.first();
		const handle = await trigger.elementHandle();
		await trigger.evaluate((el: HTMLElement) => el.click());
		expect(
			await handle?.evaluate((el, selector) => el.matches(selector), disclosure),
			'disclosure opened',
		).toBe(false);
	}
}

export async function layoutMetrics(page: Page, zoomed = false) {
	const geometry = await page.evaluate(
		({ controls, minimumTargetSize, zoomed }) => {
			const root = document.documentElement;
			const targets = [...document.querySelectorAll<HTMLElement>(controls)].filter((el) => {
				if (!el.checkVisibility() || el.closest('[inert]') || el.matches(':disabled')) return false;
				if (!el.matches('a') || getComputedStyle(el).display !== 'inline') return true;
				// Inline prose links share a line with readable text.
				return ![...el.parentElement!.childNodes].some(
					(node) => node.nodeType === Node.TEXT_NODE && /\p{L}/u.test(node.textContent ?? ''),
				);
			});
			const short = targets.flatMap((el) => {
				const { width, height } = el.getBoundingClientRect();
				return width < minimumTargetSize || height < minimumTargetSize
					? [[Math.round(width), Math.round(height)]]
					: [];
			});
			let edges = 0;
			if (zoomed) {
				for (const el of document.querySelectorAll<HTMLElement>('body *:not(svg, svg *)')) {
					if (!el.checkVisibility() || el.closest('[aria-hidden="true"], [data-allow-clip]'))
						continue;
					const rect = el.getBoundingClientRect();
					if (rect.width <= 1 || rect.height <= 1) continue;
					const left = rect.left + window.scrollX;
					const right = rect.right + window.scrollX;
					if (left >= -1 && right <= root.clientWidth + 1) continue;
					// Children of nested horizontal scrollers can be reached by scrolling.
					// The scroller itself still has to fit the viewport.
					let parent = el.parentElement;
					while (parent && parent !== document.body) {
						if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowX)) break;
						parent = parent.parentElement;
					}
					if (!parent || parent === document.body) {
						edges = Math.max(edges, Math.round(-left), Math.round(right - root.clientWidth));
					}
				}
			}
			return {
				height: root.scrollHeight,
				overflow: root.scrollWidth - root.clientWidth,
				edges,
				targets: targets.length,
				shortTargets: short.length,
				targetDeficit: short.reduce(
					(sum, [w, h]) =>
						sum + Math.max(0, minimumTargetSize - w) + Math.max(0, minimumTargetSize - h),
					0,
				),
			};
		},
		{ controls, minimumTargetSize, zoomed },
	);
	const defects = await textDefects(page);
	return {
		...geometry,
		clipped: defects.filter(({ kind }) => kind !== 'broken-word').length,
		brokenWords: defects.filter(({ kind }) => kind === 'broken-word').length,
		textDefects: defects.map(({ kind, selector, text }) => [kind, selector, text].join(' ')).sort(),
	};
}

export async function contentOrder(page: Page) {
	return page.locator('main').evaluate((main, answer) => {
		const headings = [...main.querySelectorAll('h1, [role="heading"][aria-level="1"]')].filter(
			(el) => el.checkVisibility(),
		);
		const first = main.querySelector(answer);
		const content = main.querySelector('[data-slot="screen-content"]');
		return {
			titles: headings.length,
			answerFirst: !!first && first.checkVisibility() && content?.firstElementChild === first,
		};
	}, answer);
}

async function keyboardMetrics(page: Page) {
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.evaluate(() => {
		Object.assign(window, { designPassVisited: new WeakSet<Element>() });
	});
	const sequence: string[] = [];
	let withoutRing = 0;
	let outOfOrder = 0;
	let beforeFigure = 0;
	let prior: { left: number; top: number; bottom: number; region: string } | undefined;
	// Bound the walk by DOM candidates, including controls revealed on focus, such as the skip link.
	const candidates = await page.locator(controls).count();
	let exited = false;
	for (let press = 0; press <= candidates; press++) {
		await page.keyboard.press('Tab');
		const stop = await page.evaluate(
			({ figure }) => {
				const el = document.activeElement;
				if (!el || el === document.body || el === document.documentElement) return null;
				const visited = (window as Window & { designPassVisited: WeakSet<Element> })
					.designPassVisited;
				const repeated = visited.has(el);
				visited.add(el);
				const key = [
					el.localName,
					el.getAttribute('data-testid') ?? el.getAttribute('data-slot'),
					el.getAttribute('href')?.split('?')[0],
					el.getAttribute('aria-label') ??
						el.getAttribute('title') ??
						el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 100),
				].join('|');
				const first = [...document.querySelectorAll('main :is(' + figure + ')')].find((node) =>
					node.checkVisibility(),
				);
				const main = el.closest('main');
				const { left, top, bottom } = el.getBoundingClientRect();
				return {
					repeated,
					key,
					skip: el.matches('a[href="#main"]'),
					beforeFigure:
						!!main &&
						!!first &&
						!first.contains(el) &&
						!!(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING),
					region: el.closest('[data-slot="frame-nav"]') ? 'frame' : main ? 'main' : 'other',
					left,
					top: top + window.scrollY,
					bottom: bottom + window.scrollY,
				};
			},
			{ figure },
		);
		if (!stop) {
			exited = true;
			break;
		}
		expect(stop.repeated, 'Tab leaves each control and exits the page without a loop').toBe(false);
		if (sequence.length === 0) expect(stop.skip, 'first Tab focuses the skip link').toBe(true);
		sequence.push(stop.key);
		const ring = await page.locator(':focus').evaluate(focusRing);
		if (!ring.visible || ring.outline === 'none' || ring.width < 1) withoutRing++;
		if (stop.beforeFigure) beforeFigure++;
		if (
			prior?.region === stop.region &&
			stop.region !== 'other' &&
			(stop.bottom <= prior.top ||
				(Math.abs(stop.top - prior.top) <= 2 && stop.left < prior.left - 2))
		)
			outOfOrder++;
		prior = stop;
	}
	expect(exited, 'Tab exits the page after the final control').toBe(true);
	expect(sequence.length, 'page has keyboard stops').toBeGreaterThan(0);
	return {
		stops: sequence.length,
		order: fingerprint(sequence),
		withoutRing,
		outOfOrder,
		beforeFigure,
	};
}

export async function measureDesignPass(page: Page) {
	const content = await contentOrder(page);
	const widthsReport = {} as Record<
		(typeof widths)[number],
		Awaited<ReturnType<typeof layoutMetrics>>
	>;
	const keyboard = {} as Record<
		(typeof budgetWidths)[number],
		Awaited<ReturnType<typeof keyboardMetrics>>
	>;
	for (const width of widths) {
		await setWidth(page, width);
		await settled(page);
		const nav = page.getByTestId('nav-pill');
		for (const toggle of ['theme-toggle', 'language-toggle']) {
			await expect(nav.getByTestId(toggle), `${toggle} in the navbar at ${width}px`).toBeVisible();
		}
		Object.assign(widthsReport, { [width]: await layoutMetrics(page) });
		if (width === 390 || width === 1440) {
			Object.assign(keyboard, { [width]: await keyboardMetrics(page) });
			await page.evaluate(() => {
				(document.activeElement as HTMLElement)?.blur();
				window.scrollTo(0, 0);
			});
		}
	}
	const zoomReport = {} as Record<
		(typeof budgetWidths)[number],
		Awaited<ReturnType<typeof layoutMetrics>>
	>;
	await doubleText(page);
	await expect(page.locator('html')).toHaveCSS('font-size', '32px');
	for (const width of budgetWidths) {
		await setWidth(page, width);
		await settled(page);
		await openDisclosures(page);
		await page.evaluate(() => window.scrollTo(0, 0));
		await settled(page);
		Object.assign(zoomReport, { [width]: await layoutMetrics(page, true) });
	}
	return { content, widths: widthsReport, keyboard, zoom: zoomReport };
}
