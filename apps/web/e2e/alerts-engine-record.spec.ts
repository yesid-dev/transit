import { expect, test } from '@playwright/test';

const period = 'provider=stm&frameMode=record&recordFrom=2026-11-14&recordTo=2026-11-20';

test('Alerts Record streams a count, breakdowns and the first page of agency messages', async ({
	page,
	request,
}) => {
	const response = await page.goto(`/fr/alerts?${period}`);
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(page.getByRole('heading', { name: 'Avis de service', level: 1 })).toBeVisible();
	const answer = page.locator('#answer');
	await expect(answer).toContainText('avis ont été en vigueur');
	await expect(answer).not.toContainText('12,5');
	await expect(page.locator('#effect')).toContainText('Détour');
	await expect(page.locator('#line').getByRole('link').first()).toBeVisible();
	await expect(page.getByText('Aucune capture brute')).toBeVisible();
	const messages = page.locator('#messages');
	await expect(messages.getByText('Use stop 51234.')).toHaveAttribute('lang', 'en');
	await expect(messages.getByRole('status')).toHaveText('12 sur 426');
	await messages.getByRole('button', { name: 'Afficher 12 de plus' }).click();
	await expect(messages.getByRole('status')).toHaveText('24 sur 426');
	await expect(page.locator('#alert-a13')).toBeFocused();

	await answer.getByRole('button', { name: 'Citer', exact: true }).click();
	await expect(page.getByRole('dialog')).toContainText(/v1.*recordFrom=2026-11-14.*#answer/);
	await expect(page.getByRole('dialog')).toContainText(/Avis de l’agence.*#messages/);
	await page.keyboard.press('Escape');
	await answer.getByRole('button', { name: 'Télécharger' }).click();
	for (const [name, section] of [
		['Avis de l’agence', 'messages'],
		['Par heure', 'hour'],
		['Jour par jour', 'day'],
	]) {
		const csv = await page
			.getByRole('dialog')
			.getByRole('link', { name, exact: true })
			.getAttribute('href');
		const download = await request.get(csv!);
		expect(download.ok()).toBe(true);
		expect(download.headers()['content-disposition']).toBe(
			`attachment; filename="alerts-${section}.csv"`,
		);
		expect(await download.text()).toMatch(/^Mesure,Du,Au/);
	}

	await page.goto(`/alerts?${period}#alert-a426`);
	await expect(page.locator('#alert-a426')).toBeVisible();
	await expect(page.getByText(/Votre arrêt/)).toHaveAttribute('lang', 'fr');
	await page.getByRole('combobox', { name: 'Line' }).selectOption('24');
	await page.getByRole('button', { name: 'Filter alerts' }).click();
	await expect(page).toHaveURL(/route=24/);
	await expect(page.getByRole('combobox', { name: 'Line' })).toHaveValue('24');
});

test('Alerts Record shows the engine message limit and OC Transpo has no alert total', async ({
	page,
	request,
}) => {
	const long = period.replace('2026-11-14', '2026-11-13');
	await page.goto(`/alerts?${long}`);
	await expect(page.locator('#messages')).toContainText(
		'Agency messages are listed for 7 days or fewer. Pick a shorter period.',
	);
	expect((await request.get(`/alerts/record.csv?${long}&section=messages`)).status()).toBe(400);
	await page.goto(`/alerts?${period.replace('provider=stm', 'provider=octranspo')}`);
	await expect(page.getByRole('status', { name: 'Not tracked' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Check official service alerts' })).toBeVisible();
	await expect(page.locator('[data-slot="answer-lead"]')).toHaveCount(0);
});

test('Alerts Record shows an answer while agency messages are still calculating', async ({
	page,
	request,
}, testInfo) => {
	const projectDays = {
		phone: 10,
		tablet: 11,
		desktop: 12,
		'reduced-motion': 13,
		light: 14,
		dark: 15,
	};
	const date = `2026-11-${projectDays[testInfo.project.name as keyof typeof projectDays]}`;
	await page.goto(`/alerts?provider=stm&frameMode=record&recordFrom=${date}&recordTo=${date}`, {
		waitUntil: 'commit',
	});
	await expect(page.locator('#answer')).toContainText('alerts were in effect');
	await expect(page.locator('#messages')).toContainText('Calculating…');
	const patience = page.locator('[data-slot="record-patience"]').getByRole('status');
	await expect(patience).toHaveCount(1);
	await expect(patience).toContainText('These records take longer');
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(
		`http://127.0.0.1:${dataPort}/__overview/release?fixture=alerts-${date}`,
	);
	expect(release.status()).toBe(204);
	await expect(
		page.locator('#messages').getByRole('heading', { name: 'Detour on Sherbrooke' }).first(),
	).toBeVisible();
	await expect(patience).toContainText('Answered');
});
