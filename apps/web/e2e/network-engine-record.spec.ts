import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

test.beforeEach(({ browserName }, info) => {
	test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
});

test('the French Network record shows engine readings and preserves the Live view', async ({
	page,
	request,
}) => {
	await page.setViewportSize({ width: 390, height: 900 });
	await page.goto(
		'/fr/network?provider=stm&frameMode=record&recordFrom=2026-11-20&recordTo=2026-11-22',
	);
	const main = page.getByRole('main');
	await expect(main.getByRole('heading', { name: 'Santé du réseau' })).toBeVisible();
	const polls = main.getByRole('region', { name: 'Vérifications réussies des flux' });
	const tripUpdates = polls.getByRole('row').filter({ hasText: 'Mises à jour des trajets' });
	await expect(tripUpdates).toContainText(/80\s*%/);
	await expect(tripUpdates).toContainText('20 / 25');
	await expect(polls).toContainText('Trop peu de données pour conclure');
	await expect(polls).toContainText('Au moins 20 observations');
	await polls.getByText('Jours non mesurés (1)', { exact: true }).click();
	await expect(polls.getByText(/Aucune capture brute/)).toBeVisible();
	await expect(main.getByRole('region', { name: 'Âge des flux à la collecte' })).toContainText(
		'Plus de 10 min',
	);
	await expect(
		main.getByRole('region', { name: 'Temps entre les mises à jour des flux' }),
	).toContainText('0,4 min');
	const fields = main.getByRole('region', { name: 'Détails dans les signalements des véhicules' });
	await expect(fields.getByRole('row').filter({ hasText: 'Occupation' })).toContainText(
		'champ non publié',
	);
	await expect(
		main.getByRole('region', { name: 'Couverture des trajets en direct' }),
	).toContainText('30 / 40');
	await expect(
		main.getByRole('region', { name: 'Précision des prévisions d’arrivée' }),
	).toContainText('Au moins 30 arrivées observées');
	await expect(polls.getByRole('button', { name: 'Copier le lien' })).toBeVisible();
	await polls.getByText('Citer', { exact: true }).click();
	await expect(polls.getByText(/Méthode v2, nettoyage v9\..*#poll_success/)).toBeVisible();
	const href = await polls.getByRole('link', { name: /CSV/ }).getAttribute('href');
	const csv = await request.get(href!);
	expect(csv.headers()['content-disposition']).toContain('network-poll-success.csv');
	expect(await csv.text()).toBe('Mesure,Valeur\npoll_success,2026-11-20\n');
	expect(await main.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(390);

	await main.getByRole('link', { name: 'Voir la santé du réseau en direct' }).click();
	await expect(page).toHaveURL(/frameMode=live/);
	await expect(main.locator('#net-live')).toBeVisible();
	await page.setViewportSize({ width: 1440, height: 900 });
	const view = page.getByRole('radiogroup', { name: 'Vue', exact: true });
	const live = view.getByRole('radio', { name: 'En direct', exact: true });
	await expect(live).toBeChecked();
	await live.press('ArrowRight');
	await expect(page).toHaveURL(/frameMode=record.*recordFrom=2026-11-20/);
	await expect(tripUpdates).toContainText('20 / 25');
});

test('a slow Network measure does not hold back the other sections', async ({ page, request }) => {
	const response = await page.goto(
		'/network?provider=octranspo&recordFrom=2026-11-19&recordTo=2026-11-20',
		{ waitUntil: 'commit' },
	);
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	const polls = page.getByRole('region', { name: 'Feed check success' });
	await expect(polls).toContainText('20 / 25');
	const predictions = page.getByRole('region', { name: 'Arrival prediction accuracy' });
	await expect(predictions.getByRole('status')).toHaveText(
		'Still working on this. You can wait or come back later.',
	);
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(
		`http://127.0.0.1:${dataPort}/__overview/release?fixture=network`,
	);
	expect(release.status()).toBe(204);
	await expect(predictions).toContainText('Too few to judge');
	await expect(predictions).toContainText('90%');
});
