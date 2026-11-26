import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

for (const locale of ['en', 'fr']) {
	test(`${locale} Line recovery keeps completed controls and readings in place`, async ({
		page,
		request,
	}, info) => {
		const fr = locale === 'fr';
		const prefix = fr ? '/fr' : '';
		const id = encodeURIComponent(
			`recovery-${info.project.name}-${info.repeatEachIndex}-${locale}`,
		);
		const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
		const viewport = page.viewportSize()!;
		await page.setViewportSize({ ...viewport, width: Math.min(viewport.width, 1080) });
		await page.clock.install();
		const registration = `http://127.0.0.1:${port}/__line-schedule/register?line=${id}`;
		expect((await request.post(registration)).status()).toBe(204);
		try {
			await page.goto(
				`${prefix}/lines/${id}?provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14`,
			);
		} finally {
			await request.delete(registration);
		}
		const crowding = page.locator('#crowding');
		await expect(crowding).toContainText(fr ? 'En attente de données.' : 'Waiting for a reading.');

		const stops = page.locator('#stops h2 button');
		const delivery = page.locator('#delivery h2 button');
		await delivery.click();
		await expect(stops).toHaveAttribute('aria-expanded', 'true');
		await expect(delivery).toHaveAttribute('aria-expanded', 'false');
		const grid = page.locator('#hourly [data-slot="hour-grid"]').getByRole('region');
		const scrolled = await grid.evaluate((node) => {
			node.scrollLeft = 96;
			return node.scrollLeft;
		});
		expect(scrolled).toBeGreaterThan(0);
		const daily = page.locator('#daily');
		const control = daily.getByRole('button', { name: fr ? 'Tableau' : 'Table', exact: true });
		await control.click();
		await expect(control).toHaveAttribute('aria-pressed', 'true');
		await control.focus();
		await expect(control).toBeFocused();
		await expect(daily.getByRole('table')).toBeVisible();
		const position = (await control.boundingBox())!.y;
		const response = page.waitForResponse(
			(res) => new URL(res.url()).pathname === '/api/record-recovery',
		);

		await page.clock.fastForward(60_001);
		const recovered = await response;
		expect(recovered.ok()).toBe(true);
		expect(new URL(recovered.url()).searchParams.get('sections')).toBe('crowding');
		await expect(crowding).toContainText(fr ? /25,0\s%/u : '25.0%');
		await expect(control).toBeFocused();
		expect(Math.round(Math.abs((await control.boundingBox())!.y - position))).toBe(0);
		await expect(daily.getByRole('table')).toBeVisible();
		await expect(stops).toHaveAttribute('aria-expanded', 'true');
		await expect(delivery).toHaveAttribute('aria-expanded', 'false');
		expect(await grid.evaluate((node) => node.scrollLeft)).toBe(scrolled);
	});
}
