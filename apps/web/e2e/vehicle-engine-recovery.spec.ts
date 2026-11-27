import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

test('Vehicle Record waits for the proxy’s 60-second Retry-After', async ({ page }, info) => {
	const id = `recovery-minute-${info.project.name}-${info.repeatEachIndex}`;
	await page.clock.install();
	const requests: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (url.pathname === '/api/record-recovery')
			requests.push(url.searchParams.get('readings') ?? '');
	});
	await page.goto(
		`/vehicle/${id}?provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-16`,
	);
	await expect(page.getByText(/^Next attempt available at/)).toBeVisible();
	await page.clock.fastForward(30_000);
	expect(requests).toEqual([]);
	await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
	const response = page.waitForResponse(
		(res) => new URL(res.url()).pathname === '/api/record-recovery',
	);
	await page.clock.fastForward(30_000);
	expect((await response).ok()).toBe(true);
	expect(requests).toEqual(['sections.reporting']);
	await expect(page.getByRole('article', { name: 'Stopped reporting' })).toContainText(
		'about 0.2 an hour',
	);
});

for (const locale of ['en', 'fr']) {
	test(`${locale} Vehicle recovery keeps the completed control in place`, async ({
		page,
	}, info) => {
		const fr = locale === 'fr';
		const prefix = fr ? '/fr' : '';
		const vehicle = encodeURIComponent(
			`recovery-${info.project.name}-${info.repeatEachIndex}-${locale}`,
		);
		const viewport = page.viewportSize()!;
		await page.clock.install();
		// Listen from the start: the page asks again about five seconds after its readings settle.
		const response = page.waitForResponse((res) => {
			const url = new URL(res.url());
			return (
				url.pathname === '/api/record-recovery' &&
				url.searchParams.get('readings') === 'sections.reporting'
			);
		});
		await page.goto(
			`${prefix}/vehicle/${vehicle}?provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-16`,
		);
		const reporting = page.getByRole('article', {
			name: fr ? 'Interruptions de signalement' : 'Stopped reporting',
		});
		await expect(reporting).toContainText(
			fr
				? 'En attente. Cette carte redemande dans quelques secondes.'
				: 'Waiting for a turn. This card asks again in a few seconds.',
		);
		const control = page.getByRole('button', {
			name: fr ? 'Afficher plus de jours' : 'Show more days',
		});
		await control.focus();
		await expect(control).toBeFocused();
		const before = (await control.boundingBox())!.y;
		await page.clock.fastForward(5_001);
		expect((await response).ok()).toBe(true);
		await expect(reporting).toContainText(
			fr
				? 'interruptions des signalements, environ 0,2 par heure'
				: 'times it stopped reporting, about 0.2 an hour',
		);
		expect(Math.round(Math.abs((await control.boundingBox())!.y - before))).toBe(0);
		await expect(control).toBeFocused();
		const notice = page.locator('[data-slot="record-patience"]');
		await expect(notice.getByRole('status')).toHaveCount(1);
		await expect(notice.getByRole('status')).toContainText(
			fr ? 'Le bilan est affiché.' : 'The record is on screen.',
		);
		// The notice is for screen readers only: it takes no room, so nothing reserves or moves.
		const box = (await notice.boundingBox())!;
		expect(box.height).toBeLessThanOrEqual(1);
		await page.evaluate(() => {
			document.documentElement.style.fontSize = '200%';
		});
		await page.setViewportSize({ ...viewport, width: viewport.width > 900 ? 768 : 320 });
		expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(1);
	});
}
