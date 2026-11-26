import { expect } from '@playwright/test';
import { join } from 'node:path';
import { streamingLayoutTest as test } from './layout-test';
import { captureUrl } from './capture-fixture';
import { designPassCases, type Screen } from './design-pass-cases';
import { settled } from './design-pass-measure';
import { localizeHref } from '../src/lib/i18n/routing';

type ShiftRect = { x: number; y: number; width: number; height: number };
type Shift = {
	at: number;
	value: number;
	sources: { node: string; previous: ShiftRect; current: ShiftRect }[];
};
type ShiftEntry = PerformanceEntry & {
	hadRecentInput: boolean;
	value: number;
	sources: {
		node: Node | null;
		previousRect: DOMRectReadOnly;
		currentRect: DOMRectReadOnly;
	}[];
};
type ShiftWindow = Window & { steadyShifts: Shift[] };

const time = Date.parse('2026-11-23T16:00:00Z');
const widths = [390, 768, 1024, 1440];
const targets = new Set<Screen>([
	'overview',
	'overview-live',
	'network-health',
	'network-health-live',
	'lines',
	'line-record',
	'line-live',
	'stop-record',
	'daily',
	'data-health',
	'data-health-live',
	'alerts',
	'alerts-live',
	'how-we-measure',
	'download',
	'vehicle-record',
	'vehicle-live',
]);
const artwork = new Set<Screen>([
	'overview',
	'network-health',
	'line-record',
	'alerts',
	'vehicle-record',
]);
const captureRefresh = new Set<Screen>([
	'network-health-live',
	'line-live',
	'data-health-live',
	'alerts-live',
	'vehicle-live',
]);
const recordAnswers = new Set<Screen>([
	'overview',
	'network-health',
	'lines',
	'line-record',
	'stop-record',
	'daily',
	'data-health',
	'alerts',
	'vehicle-record',
]);

let recordVariant = 0;
for (const { screen, href } of designPassCases.filter(
	(item) => item.provider === 'stm' && item.locale === 'en' && targets.has(item.screen),
)) {
	for (const city of ['stm', 'octranspo'] as const)
		for (const locale of ['en', 'fr'] as const)
			for (const width of widths) {
				const held = recordAnswers.has(screen) && !(screen === 'alerts' && city === 'octranspo');
				const index = held ? recordVariant++ : 0;
				test(`steady ${screen} ${city} ${locale} ${width}px @layout`, async ({
					page,
					request,
				}, info) => {
					const path = new URL(href, 'http://fixture');
					if (screen === 'alerts' || screen === 'network-health')
						path.searchParams.set('frameMode', 'record');
					if (screen === 'vehicle-record' && city === 'octranspo') path.pathname = '/vehicle/1';
					const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
					// Give each request an isolated fixture window, distinct from the other layout specs.
					const october = new Date('2026-10-13T00:00:00Z').getTime();
					const day = (offset: number) =>
						new Date(october + offset * 86_400_000).toISOString().slice(0, 10);
					const position = widths.indexOf(width);
					let from = day(index % 24);
					let to = day((index % 24) + Math.floor(index / 24));
					if (screen === 'overview') {
						const first = locale === 'fr' ? 8 : 1;
						const november = (day: number) => `2026-11-${String(day).padStart(2, '0')}`;
						from = november(first);
						to = november(first + 6 + position);
					} else if (screen === 'daily') {
						const first = locale === 'fr' ? 18 : 17;
						from = `2026-11-${first}`;
						to = `2026-11-${first + position}`;
					} else if (screen === 'data-health') {
						from = '2026-10-26';
						to = `2026-11-${(locale === 'fr' ? 19 : 15) + position}`;
					}
					const fixture = `steady:${city}:${from}:${to}`;
					const fixtureUrl = (action: 'hold' | 'release') =>
						`http://127.0.0.1:${port}/__overview/${action}?fixture=${encodeURIComponent(fixture)}`;
					const hold = (action: 'hold' | 'release') => request.post(fixtureUrl(action));
					if (held) {
						path.searchParams.set('recordFrom', from);
						path.searchParams.set('recordTo', to);
					}
					await page.setViewportSize({ width, height: 900 });
					await page.clock.install({ time: captureRefresh.has(screen) ? Date.now() : time });
					await page.setExtraHTTPHeaders(
						screen === 'alerts' ? { 'x-transit-fixture-scope': 'alerts' } : {},
					);
					await page.addInitScript(
						(theme) => localStorage.setItem('theme', theme),
						locale === 'fr' ? 'dark' : 'light',
					);
					await page.addInitScript(() => {
						const shifts: Shift[] = [];
						const rect = ({ x, y, width, height }: DOMRectReadOnly): ShiftRect => ({
							x: Math.round(x),
							y: Math.round(y),
							width: Math.round(width),
							height: Math.round(height),
						});
						(window as ShiftWindow).steadyShifts = shifts;
						new PerformanceObserver((list) => {
							for (const entry of list.getEntries() as ShiftEntry[]) {
								if (entry.hadRecentInput) continue;
								shifts.push({
									at: Math.round(entry.startTime),
									value: entry.value,
									sources: entry.sources.flatMap(({ node, previousRect, currentRect }) => {
										const element = node instanceof Element ? node : node?.parentElement;
										if (!element) return [];
										const section = element.closest('[id], [data-slot]');
										const label = section?.id
											? `${element.tagName} #${section.id}`
											: `${element.tagName} [${section?.getAttribute('data-slot') ?? ''}]`;
										return [
											{ node: label, previous: rect(previousRect), current: rect(currentRect) },
										];
									}),
								});
							}
						}).observe({ type: 'layout-shift', buffered: true });
					});
					if (held) expect((await hold('hold')).ok()).toBe(true);
					try {
						path.searchParams.delete('provider');
						const response = await page.goto(
							localizeHref(path.pathname + path.search, locale, city),
							{
								waitUntil: 'commit',
							},
						);
						expect(response?.ok()).toBe(true);
						await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
						if (held) {
							await expect
								.poll(async () => (await (await request.get(fixtureUrl('hold'))).json()).waiting)
								.toBeGreaterThan(0);
						}
						await page.evaluate(() => document.fonts.ready);
						await settled(page);
						if (held) {
							const footerTop = await page
								.getByTestId('footer')
								.evaluate((footer) => footer.getBoundingClientRect().top);
							expect
								.soft(footerTop, 'footer stays below the first viewport while waiting')
								.toBeGreaterThanOrEqual(900);
							const following =
								screen === 'alerts' && width === 1440
									? '#line'
									: screen === 'network-health' && width === 390
										? '#delay'
										: null;
							if (following) {
								const top = await page
									.locator(following)
									.evaluate((node) => node.getBoundingClientRect().top);
								expect
									.soft(
										top,
										`${following} stays below the first viewport while the preceding reading loads`,
									)
									.toBeGreaterThanOrEqual(900);
							}
						}
						const evidence = process.env.TRANSIT_STEADY_EVIDENCE;
						if (
							evidence &&
							held &&
							artwork.has(screen) &&
							city === 'stm' &&
							(width === 390 || width === 1440)
						) {
							await page.screenshot({
								path: join(evidence, `${screen}-${locale}-${width}-waiting.png`),
								animations: 'disabled',
							});
						}
					} finally {
						if (held) expect((await hold('release')).ok()).toBe(true);
					}
					await page.waitForLoadState('domcontentloaded');
					await expect(page.locator('html[data-hydrated]')).toBeAttached();
					await expect(page.locator('main [data-record-pending]')).toHaveCount(0);
					await expect(page.getByRole('contentinfo').getByRole('link').first()).toBeVisible();
					await settled(page);
					const scores = async (phase: string) => {
						const entries = await page.evaluate(() =>
							(window as ShiftWindow).steadyShifts.splice(0),
						);
						const score = entries.reduce((sum, entry) => sum + entry.value, 0);
						await info.attach(`layout-shifts-${phase}`, {
							body: JSON.stringify({ score, entries }),
							contentType: 'application/json',
						});
						expect
							.soft(score, `${phase} shifts: ${JSON.stringify(entries)}`)
							.toBeLessThanOrEqual(0.1);
					};
					await scores('first-screen');
					if (captureRefresh.has(screen) && !(screen === 'alerts-live' && city === 'octranspo')) {
						const refreshed = page.waitForResponse((reply) => captureUrl.test(reply.url()));
						await page.clock.fastForward(30_000);
						expect((await refreshed).ok()).toBe(true);
						await settled(page);
						await scores('refresh');
					}
				});
			}
}

test('steady footer is keyboard reachable after ten seconds while the engine is still held @layout', async ({
	page,
	request,
}) => {
	const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const fixture = encodeURIComponent('steady:stm:2026-10-13:2026-11-01');
	const host = `http://127.0.0.1:${port}/__overview`;
	const hold = `${host}/hold?fixture=${fixture}`;
	expect((await request.post(hold)).ok()).toBe(true);
	try {
		await page.setViewportSize({ width: 390, height: 900 });
		await page.setExtraHTTPHeaders({ 'x-transit-fixture-scope': 'alerts' });
		await page.goto('/alerts?provider=stm&recordFrom=2026-10-13&recordTo=2026-11-01', {
			waitUntil: 'commit',
		});
		await expect
			.poll(async () => (await (await request.get(hold)).json()).waiting)
			.toBeGreaterThan(0);
		const footer = page.getByRole('contentinfo');
		await expect(footer).toHaveCount(0);
		const endTime = await page.getByTestId('footer').evaluate((element) => {
			const [animation] = element.parentElement!.getAnimations();
			return animation?.effect?.getComputedTiming().endTime;
		});
		expect(endTime).toBe(10_000);
		const link = footer.getByRole('link').first();
		await expect(link).toBeVisible({ timeout: 12_000 });
		expect((await (await request.get(hold)).json()).waiting).toBeGreaterThan(0);
		await link.focus();
		await expect(link).toBeFocused();
	} finally {
		expect((await request.post(`${host}/release?fixture=${fixture}`)).ok()).toBe(true);
	}
});
