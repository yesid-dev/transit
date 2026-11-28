import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

// Closing audit G3-M6: a ranking's network reference arrives apart from the ranking. Drawing the
// rows first and the verdict under each range later pushed every row down; a short ranking then
// pulled the cards under it into view. Nothing may move while either loads.
test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';

// The full list's reference is from another method, so it shows no verdict; the short list's does.
for (const [name, dates, rows, verdict] of [
	['a full list', 'recordFrom=2026-10-28&recordTo=2026-11-03', 20, false],
	['a short list', 'recordFrom=2026-10-27&recordTo=2026-11-02', 1, true],
] as const) {
	test(`${name} does not move while its reference arrives`, async ({ page, request }) => {
		const hold = `ranking-reference-${randomUUID()}:measure`;
		expect(
			(await request.post(`http://127.0.0.1:${port}/__overview/hold?fixture=${hold}`)).status(),
		).toBe(204);
		try {
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.setExtraHTTPHeaders({ 'x-transit-fixture-hold': hold });
			await page.addInitScript(() => {
				const shifts: number[] = [];
				Object.assign(window, { rankingShifts: shifts });
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries() as (PerformanceEntry & {
						value: number;
						hadRecentInput: boolean;
					})[])
						if (!entry.hadRecentInput) shifts.push(entry.value);
				}).observe({ type: 'layout-shift', buffered: true });
			});
			// The page streams: its document stays open while the reference is held.
			await page.goto(`/rankings?provider=stm&${dates}`, { waitUntil: 'commit' });
			// The ranking has answered; its table waits for the reference, and so do the cards under it.
			await expect(page.locator('[data-slot="screen-answer"]')).toContainText('%');
			await expect(page.locator('#ranking [data-record-pending]')).toBeVisible();
			await expect(page.locator('.ranking-below').first()).toBeHidden();
			expect(
				(
					await request.post(`http://127.0.0.1:${port}/__overview/release?fixture=${hold}`)
				).status(),
			).toBe(204);
			await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
			const table = page.getByRole('table', { name: 'Lines' });
			await expect(table.locator('tbody tr')).toHaveCount(rows);
			if (verdict) await expect(page.locator('#ranking')).toContainText('the network');
			await expect(page.locator('.ranking-below').first()).toBeVisible();
			await page.evaluate(
				() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
			);
			const total = await page.evaluate(() =>
				(window as unknown as { rankingShifts: number[] }).rankingShifts.reduce((a, b) => a + b, 0),
			);
			expect(total).toBeLessThanOrEqual(0.01);
		} finally {
			await request.post(`http://127.0.0.1:${port}/__overview/release?fixture=${hold}`);
		}
	});
}
