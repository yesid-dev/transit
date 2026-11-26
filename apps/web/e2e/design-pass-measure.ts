import { createHash } from 'node:crypto';
import { expect, type CDPSession, type Page } from '@playwright/test';
import {
	doubleText,
	focusRing,
	minimumTargetSize,
	textDefects,
	waitForFrameClearance,
} from './layout-helpers';
import { focusOutOfOrder, type FocusPosition } from './design-pass-order';

export const widths = [320, 390, 768, 1024, 1440] as const;
export const budgetWidths = [390, 1440] as const;
const controls =
	'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable]';
const answer = '[data-slot="screen-answer"], [data-slot="screen-state"]';
const figure = answer + ', figure, [data-slot="chart-frame"], table';
const disclosure =
	'main details:not([open]) > summary, main button[aria-expanded="false"][aria-controls]:not([aria-haspopup]), main button[data-section-trigger][aria-expanded="false"]';
const dateInput = 'input[type="date"]';
// Chromium exposes month, day, year and the picker button as separate stops.
const dateSegments = 4;

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
			let edgeCount = 0;
			if (zoomed) {
				for (const el of document.querySelectorAll('body *:not(svg *)')) {
					if (!el.checkVisibility() || el.closest('[aria-hidden="true"], [data-allow-clip]'))
						continue;
					// The skip link intentionally lives off canvas until the first Tab.
					if (el.closest('a.skip-link:not(:focus)')) continue;
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
						edgeCount++;
						edges = Math.max(edges, Math.round(-left), Math.round(right - root.clientWidth));
					}
				}
			}
			return {
				height: root.scrollHeight,
				overflow: root.scrollWidth - root.clientWidth,
				edges,
				edgeCount,
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
		const firstContent = (element: Element) =>
			[...element.children].find(
				(child) => !child.matches('[data-slot="page-section-boundary"], [data-screen-intro]'),
			);
		const firstChild = content && firstContent(content);
		const firstReading = firstChild?.hasAttribute('data-page-section-edges')
			? firstContent(firstChild)
			: firstChild;
		return {
			titles: headings.length,
			answerFirst: !!first && first.checkVisibility() && firstReading === first,
		};
	}, answer);
}

async function keyboardMetrics(page: Page, countShadowRings: boolean) {
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.evaluate(
		({ controls, countShadowRings }) => {
			const shadows = new WeakMap<Element, string>();
			if (countShadowRings) {
				for (const control of document.querySelectorAll(controls)) {
					shadows.set(control, getComputedStyle(control).boxShadow);
				}
			}
			Object.assign(window, {
				designPassVisited: new WeakSet<Element>(),
				designPassShadows: shadows,
			});
		},
		{ controls, countShadowRings },
	);
	const sequence: string[] = [];
	const accessibleStops: string[] = [];
	let withoutRing = 0;
	let outOfOrder = 0;
	let beforeFigure = 0;
	let cdp: CDPSession | undefined;
	const dateStops = new Set<string>();
	let prior: FocusPosition | undefined;
	// Bound the walk by DOM candidates, including controls revealed on focus, such as the skip link.
	const candidates =
		(await page.locator(controls).count()) +
		(await page.locator(dateInput).count()) * (dateSegments - 1);
	let exited = false;
	try {
		for (let press = 0; press <= candidates; press++) {
			await page.keyboard.press('Tab');
			const stop = await page.evaluate(
				async ({ figure, dateInput }) => {
					const el = document.activeElement;
					if (!el || el === document.body || el === document.documentElement) return null;
					if (el.matches('[data-testid="toc-pill"] > button')) {
						// Tab can scroll the page. Wait for intersection delivery, then
						// sample on the next frame so the section tracker has rendered.
						await new Promise<void>((resolve) => {
							const observer = new IntersectionObserver(() => {
								observer.disconnect();
								requestAnimationFrame(() => resolve());
							});
							observer.observe(el);
						});
					}
					const visited = Reflect.get(window, 'designPassVisited') as WeakSet<Element>;
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
					const groupSelector = '[data-slot="record-card"], [data-slot="record-ranking"]';
					const groups = [...(main?.querySelectorAll(groupSelector) ?? [])];
					const group = el.closest(groupSelector);
					const parent = group?.parentElement?.closest(groupSelector);
					const bounds = group?.getBoundingClientRect();
					const { left, top, bottom } = el.getBoundingClientRect();
					return {
						repeated,
						nativeDate: el.matches(dateInput),
						key,
						skip: el.matches('a[href="#main"]'),
						beforeFigure:
							!!main &&
							!!first &&
							!first.contains(el) &&
							!!(el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING),
						region: el.closest('[data-slot="frame-nav"]') ? 'frame' : main ? 'main' : 'other',
						group: group ? groups.indexOf(group) : -1,
						groupParent: parent ? groups.indexOf(parent) : undefined,
						groupLeft: bounds?.left ?? left,
						groupTop: (bounds?.top ?? top) + window.scrollY,
						left,
						top: top + window.scrollY,
						bottom: bottom + window.scrollY,
					};
				},
				{ figure, dateInput },
			);
			if (!stop) {
				exited = true;
				break;
			}
			if (sequence.length === 0) expect(stop.skip, 'first Tab focuses the skip link').toBe(true);
			let accessibleStop: string;
			if (stop.nativeDate) {
				// The DOM reports the host input for every segment. Read the focused
				// accessibility node to distinguish real progress from a trapped Tab.
				if (!cdp) {
					cdp = await page.context().newCDPSession(page);
					await cdp.send('Accessibility.enable');
				}
				const { nodes } = await cdp.send('Accessibility.getFullAXTree');
				const focused = nodes.find(
					(node) =>
						node.role?.value !== 'RootWebArea' &&
						node.properties?.some(
							(property) => property.name === 'focused' && property.value.value === true,
						),
				);
				if (!focused) throw new Error(`No focused date segment for ${stop.key}`);
				expect(dateStops.has(focused.nodeId), `Tab must advance past ${stop.key}`).toBe(false);
				dateStops.add(focused.nodeId);
				sequence.push(`${stop.key}|${focused.role?.value}|${focused.name?.value}`);
				accessibleStop = `${focused.role?.value} ${JSON.stringify(focused.name?.value ?? '')}`;
			} else {
				expect(stop.repeated, `Tab must advance past ${stop.key}`).toBe(false);
				sequence.push(stop.key);
				const snapshot = await page.locator(':focus').ariaSnapshot();
				accessibleStop = snapshot.split('\n')[0]?.replace(/^- /, '') || '(no accessibility node)';
			}
			accessibleStops.push(accessibleStop);
			const ring = await page.evaluate(focusRing, undefined);
			const hasOutline = ring.outline !== 'none' && ring.width >= 1;
			const hasShadow =
				ring.visible &&
				!hasOutline &&
				countShadowRings &&
				(await page.evaluate(async () => {
					const focused = document.activeElement!;
					await Promise.allSettled(
						focused
							.getAnimations()
							.filter(
								(animation) =>
									animation instanceof CSSTransition &&
									animation.transitionProperty === 'box-shadow',
							)
							.map((animation) => animation.finished),
					);
					const resting = Reflect.get(window, 'designPassShadows') as WeakMap<Element, string>;
					const current = getComputedStyle(focused).boxShadow;
					// A centered, unblurred spread is a ring. Require a change from the resting shadow.
					const spread = /\b0px 0px 0px ([\d.]+)px\b/u.exec(current)?.[1];
					return resting.has(focused) && current !== resting.get(focused) && Number(spread) >= 1;
				}));
			if (!ring.visible || (!hasOutline && !hasShadow)) withoutRing++;
			if (stop.beforeFigure) beforeFigure++;
			if (prior && focusOutOfOrder(prior, stop)) outOfOrder++;
			prior = stop;
		}
	} finally {
		await cdp?.detach();
	}
	expect(exited, 'Tab exits the page after the final control').toBe(true);
	expect(sequence.length, 'page has keyboard stops').toBeGreaterThan(0);
	return {
		metrics: {
			stops: sequence.length,
			order: fingerprint(sequence),
			withoutRing,
			outOfOrder,
			beforeFigure,
		},
		accessibleStops,
		keys: sequence,
	};
}

export async function measureDesignPass(page: Page, { countShadowRings = false } = {}) {
	const content = await contentOrder(page);
	const widthsReport = {} as Record<
		(typeof widths)[number],
		Awaited<ReturnType<typeof layoutMetrics>>
	>;
	const keyboard = {} as Record<
		(typeof budgetWidths)[number],
		Awaited<ReturnType<typeof keyboardMetrics>>['metrics']
	>;
	const focusSequences = {} as Record<(typeof budgetWidths)[number], string[]>;
	const focusKeys = {} as Record<(typeof budgetWidths)[number], string[]>;
	for (const width of widths) {
		await setWidth(page, width);
		await settled(page);
		const nav = page.getByTestId('nav-pill');
		for (const toggle of ['theme-toggle', 'language-toggle']) {
			await expect(nav.getByTestId(toggle), `${toggle} in the navbar at ${width}px`).toBeVisible();
		}
		Object.assign(widthsReport, { [width]: await layoutMetrics(page) });
		if (width === 390 || width === 1440) {
			const { metrics, accessibleStops, keys } = await keyboardMetrics(page, countShadowRings);
			keyboard[width] = metrics;
			focusSequences[width] = accessibleStops;
			focusKeys[width] = keys;
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
	return {
		report: { content, widths: widthsReport, keyboard, zoom: zoomReport },
		focusSequences,
		focusKeys,
	};
}
