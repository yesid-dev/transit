import { expect, test } from '@playwright/test';

const period = 'provider=stm&frameMode=record&recordFrom=2026-11-14&recordTo=2026-11-20';

test('Alerts Record streams every cut with localized messages and evidence', async ({
	page,
	request,
}) => {
	const response = await page.goto(`/fr/alerts?${period}`);
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	const region = (name: string) => page.getByRole('region', { name, exact: true });
	await expect(page.getByRole('heading', { name: 'Avis de service', level: 1 })).toBeVisible();
	const answer = region('Le résultat');
	await expect(answer).toContainText('12,5');
	await expect(answer).toContainText('Versions d’alertes distinctes');
	await expect(answer).toContainText('Aucune capture brute');
	const rows = [
		['Jour par jour', 'Non mesuré'],
		['Par heure', '07:00'],
		['Par ligne', '24'],
		['Par arrêt', 'Arrêt 51234'],
		['Par effet', 'Détour'],
		['Par cause', 'Travaux'],
	];
	for (const [section, text] of rows) {
		await expect(region(section).getByRole('table')).toContainText(text);
	}
	const messages = region('Avis de l’agence');
	await expect(messages.getByRole('heading', { name: 'Détour sur la ligne 24' })).toBeVisible();
	await expect(messages.getByText('Use stop 51234.')).toHaveAttribute('lang', 'en');
	await expect(messages).toContainText('Périodes actives en heure locale');
	await expect(messages.getByRole('button', { name: 'Copier le lien' })).toBeVisible();
	await messages.getByText('Citer', { exact: true }).click();
	await expect(messages.getByText(/v1.*recordFrom=2026-11-14.*#messages/)).toBeVisible();
	const csv = await messages.getByRole('link', { name: /CSV/ }).getAttribute('href');
	const download = await request.get(csv!);
	expect(download.ok()).toBe(true);
	expect(download.headers()['content-disposition']).toBe(
		'attachment; filename="alerts-messages.csv"',
	);
	expect(await download.text()).toMatch(/^Mesure,Du,Au/);
});

test('Alerts Record shows the message limit and the agency link for an untracked network', async ({
	page,
	request,
}) => {
	const long = period.replace('2026-11-14', '2026-11-13');
	await page.goto(`/alerts?${long}`);
	const messages = page.getByRole('region', { name: 'Agency messages' });
	await expect(messages).toContainText(
		'Agency messages are listed for 7 days or fewer. Pick a shorter period.',
	);
	await expect(messages.getByRole('link', { name: /CSV/ })).toHaveCount(0);
	expect((await request.get(`/alerts/record.csv?${long}&section=messages`)).status()).toBe(400);
	await page.goto(`/alerts?${period.replace('provider=stm', 'provider=octranspo')}`);
	await expect(page.getByRole('heading', { name: 'Not tracked' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Check official service alerts' })).toBeVisible();
	await expect(page.getByText('Distinct alerts', { exact: true })).toHaveCount(0);
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
	await expect(page.getByRole('region', { name: 'The answer' })).toContainText('12.5');
	const messages = page.getByRole('region', { name: 'Agency messages' });
	await expect(messages.getByRole('status')).toHaveText(
		'Still working on this. You can wait or come back later.',
	);
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(
		`http://127.0.0.1:${dataPort}/__overview/release?fixture=alerts-${date}`,
	);
	expect(release.status()).toBe(204);
	await expect(messages.getByRole('heading', { name: 'Detour on line 24' })).toBeVisible();
});
