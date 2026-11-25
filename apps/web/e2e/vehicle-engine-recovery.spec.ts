import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

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
		await page.goto(
			`${prefix}/vehicle/${vehicle}?provider=stm&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-16`,
		);
		const reporting = page.getByRole('article', {
			name: fr ? 'Interruptions de signalement' : 'Stopped reporting',
		});
		await expect(reporting).toContainText(fr ? 'Lecture en attente.' : 'Waiting for a reading.');
		const control = page.getByRole('button', {
			name: fr ? 'Afficher plus de jours' : 'Show more days',
		});
		await control.focus();
		await expect(control).toBeFocused();
		const before = (await control.boundingBox())!.y;
		const response = page.waitForResponse((res) => {
			const url = new URL(res.url());
			return (
				url.pathname === '/api/record-recovery' && url.searchParams.get('sections') === 'reporting'
			);
		});
		await page.clock.fastForward(60_001);
		expect((await response).ok()).toBe(true);
		await expect(reporting).toContainText(
			fr ? '16 interruptions par 100 heures' : '16 interruptions per 100 hours',
		);
		expect(Math.round(Math.abs((await control.boundingBox())!.y - before))).toBe(0);
		await expect(control).toBeFocused();
		const notice = page.locator('[data-slot="record-patience"]');
		await expect(notice.getByRole('status')).toHaveCount(1);
		await expect(notice.getByRole('status')).toContainText(fr ? 'Réponse reçue' : 'Answered');
		await expect(notice).toHaveAttribute('style', /min-block-size: \d+(?:\.\d+)?px/);
		await page.evaluate(() => {
			document.documentElement.style.fontSize = '200%';
		});
		await page.setViewportSize({ ...viewport, width: viewport.width > 900 ? 768 : 320 });
		await expect(notice).not.toHaveAttribute('style', /min-block-size/);
	});
}
