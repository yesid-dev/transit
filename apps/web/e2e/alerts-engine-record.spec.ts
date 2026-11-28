import { csvText } from '../src/tests/csv';
import { expect, test } from '@playwright/test';
import { stmAlertId } from './alert-fixture.mjs';
import { captureUrl, refreshAlertsCapture } from './capture-fixture';
import { closeCompactFrameControls, openFrameControls } from './frame-controls';

test.use({ extraHTTPHeaders: { 'x-transit-fixture-scope': 'alerts' } });

const period = 'provider=stm&frameMode=record&recordFrom=2026-11-14&recordTo=2026-11-20';

test('Alerts Record and Live now use no legacy requests across load and refresh', async ({
	page,
}) => {
	await page.clock.install();
	const legacy: string[] = [];
	const captures: string[] = [];
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (
			/(^|\/)v1(\/|$)/.test(url.pathname) ||
			url.hostname.endsWith('.r2.dev') ||
			(url.hostname === 'data.yesid.dev' && !url.pathname.startsWith('/v2/'))
		)
			legacy.push(url.href);
		if (captureUrl.test(url.href)) captures.push(url.pathname + url.search);
	});
	await page.goto(`/alerts?${period}`);
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(page.locator('#messages [data-slot="show-more"]')).toBeVisible();
	await page.clock.fastForward(21_000);
	expect(captures).toEqual([]);

	await page.goto('/alerts?provider=stm&frameMode=live');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(page.locator('#alerts-window')).toContainText('0 notices are in effect now.');
	expect(captures).toEqual([]);
	expect((await refreshAlertsCapture(page)).ok()).toBe(true);
	expect(captures).toEqual(['/api/live?city=stm']);
	expect(legacy).toEqual([]);
});

test('Alerts Record streams a count, breakdowns and the first page of agency messages', async ({
	page,
	request,
}) => {
	const response = await page.goto(`/fr/alerts?${period}`);
	expect(response?.headers()['cache-control']).toBe('no-store, no-transform');
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await expect(page.getByRole('heading', { name: 'Avis de service', level: 1 })).toBeVisible();
	const answer = page.locator('#answer');
	await expect(answer).toContainText('213 avis étaient en vigueur à un moment donné à ces dates.');
	await expect(answer).toContainText(/213 avis\. La STM les a publiés 1\s707 fois\./);
	await expect(answer).not.toContainText('12,5');
	await expect(page.getByRole('heading', { name: 'Par effet', exact: true })).toBeVisible();
	await expect(
		page.getByText('La société de transport ne publie pas l’effet de ses avis.'),
	).toBeVisible();
	await expect(
		page.getByText(
			'Compte les avis distincts en vigueur à ces dates. Le nombre de publications comprend chaque version.',
		),
	).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Par ligne', exact: true })).toBeVisible();
	await expect(page.locator('#line').getByRole('status')).toHaveText('6 sur 185');
	await expect(page.locator('#line').getByRole('link').first()).toContainText('Beaubien');
	await expect(
		page.locator('#line').getByRole('link').filter({ hasText: 'Sherbrooke' }),
	).toBeVisible();
	await expect(page.getByText('Transit n’a collecté aucune donnée source')).toBeVisible();
	const messages = page.locator('#messages');
	await expect(messages.getByRole('heading', { name: 'Use stop 51234.' })).toHaveAttribute(
		'lang',
		'en',
	);
	await expect(messages.getByRole('heading', { name: 'Avis sans texte' })).toBeVisible();
	await expect(messages.getByText(/Votre arrêt|anonymous:|Inconnu/)).toHaveCount(0);
	await expect(messages.getByText('du 14 au 20 nov. 2026', { exact: true }).first()).toBeVisible();
	await expect(messages.getByRole('status')).toHaveText('5 sur 213 avis');
	await expect(messages).not.toContainText(/1\s707/);
	await messages.getByRole('button', { name: 'Afficher 5 de plus' }).click();
	await expect(messages.getByRole('status')).toHaveText('10 sur 213 avis');
	await expect(messages.locator('ul > li').nth(5)).toBeFocused();

	await answer.getByRole('button', { name: 'Citer', exact: true }).click();
	await expect(page.getByRole('dialog')).toContainText(/v1.*recordFrom=2026-11-14.*#answer/);
	await expect(page.getByRole('dialog')).toContainText(
		/Avis de la société de transport.*#messages/,
	);
	await expect(page.getByRole('dialog')).toContainText(/Avis\s*:\s*1\s707/);
	await page.keyboard.press('Escape');
	await answer.getByRole('button', { name: 'Télécharger' }).click();
	for (const [name, section] of [
		['Avis de service', 'messages'],
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
		expect(csvText(await download.body())).toMatch(/^Mesure,Du,Au/u);
	}

	const duplicate = stmAlertId(14);
	await page.goto(`/alerts?${period}#alert-${encodeURIComponent(duplicate)}`);
	await expect(answer).toContainText('213 notices were in effect at some point in these dates.');
	await expect(answer).toContainText('213 notices. STM published them 1,707 times.');
	const grouped = page.locator(`[id="alert-${duplicate}"]`).locator('xpath=ancestor-or-self::li');
	await expect(grouped.getByRole('heading')).toHaveText('Stop 52997 is closed during roadworks.');
	for (const number of ['34', '125', '353']) {
		await expect(grouped.getByRole('link', { name: new RegExp(`\\b${number}\\b`) })).toHaveCount(1);
	}
	// The compact rail steps aside when the footer is in view.
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await answer.scrollIntoViewIfNeeded();
	const controls = await openFrameControls(page);
	const filter = controls.getByRole('group', { name: 'Filter', exact: true });
	await expect(filter.getByRole('combobox', { name: 'Effect' })).toHaveCount(0);
	await expect(filter.getByRole('radiogroup', { name: 'Effect' })).toHaveCount(0);
	const line = filter.getByRole('combobox', { name: 'Line' });
	await line.fill('Sherbrooke');
	await line.press('ArrowDown');
	await expect(page.getByRole('option', { name: /^24.*Sherbrooke/ })).toBeVisible();
	await line.press('Enter');
	await expect(page).toHaveURL(/route=24/);
	await expect(line).toHaveValue(/24.*Sherbrooke/);
	const stop = filter.getByRole('combobox', { name: 'Stop' });
	await stop.fill('51234');
	await stop.press('ArrowDown');
	// Pick with the keyboard once the option is the active one. The kit listbox is placed in
	// document coordinates beside a fixed rail, so a pointer click's scroll-into-view moves it
	// for a frame and the click can land on the rail instead.
	const stopOption = page.getByRole('option', { name: 'Stop 51234' });
	await expect(stopOption).toBeVisible();
	await expect(stop).toHaveAttribute(
		'aria-activedescendant',
		(await stopOption.getAttribute('id'))!,
	);
	await stop.press('Enter');
	await expect(page).toHaveURL(/route=24.*stop=51234/);
	await expect(filter.getByText(/^\d+ notices?$/)).not.toHaveText('213 notices');
	await closeCompactFrameControls(page);
	await expect(messages.getByRole('status')).toHaveText(/Showing [1-9]\d* of [1-9]\d* notices?/);
	await expect(messages.getByRole('combobox')).toHaveCount(0);

	await page.reload();
	// SvelteKit restores the pre-reload scroll when it hydrates; scroll only after that,
	// or the page can return to the footer, where the compact rail steps aside.
	await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
	await answer.scrollIntoViewIfNeeded();
	await openFrameControls(page);
	await expect(stop).toHaveValue('Stop 51234');
	await expect(line).toHaveValue(/24.*Sherbrooke/);
	await filter.getByRole('button', { name: 'Clear', exact: true }).click();
	await expect(page).not.toHaveURL(/(?:route|stop)=/);
	await expect(filter.getByText('213 notices', { exact: true })).toBeVisible();
});

for (const [width, height] of [
	[1280, 720],
	[1366, 768],
] as const) {
	test(`Alerts Record shows the line and stop filters at ${width} by ${height}`, async ({
		page,
	}) => {
		await page.setViewportSize({ width, height });
		await page.goto(`/alerts?${period}`);
		const filters = page.getByRole('group', { name: 'Filter', exact: true });
		await expect(filters.getByRole('combobox', { name: 'Line', exact: true })).toBeInViewport({
			ratio: 1,
		});
		await expect(filters.getByRole('combobox', { name: 'Stop', exact: true })).toBeInViewport({
			ratio: 1,
		});
	});
}

test('Alerts Record shows the engine message limit and OC Transpo has no alert total', async ({
	page,
	request,
}) => {
	const long = period.replace('2026-11-14', '2026-11-13');
	await page.goto(`/alerts?${long}`);
	await expect(page.locator('#answer')).toContainText(
		'1,707 notices were in effect at some point in these dates.',
	);
	await expect(page.locator('#messages')).toContainText(
		'To see the notices, choose a period of 7 days or fewer.',
	);
	expect((await request.get(`/alerts/record.csv?${long}&section=messages`)).status()).toBe(400);
	await page.goto(`/alerts?${period.replace('provider=stm', 'provider=octranspo')}`);
	await expect(page.getByRole('status', { name: 'Not published' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Check the official notices' })).toBeVisible();
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
	await expect(page.locator('#answer')).toContainText(
		'notices were in effect at some point in these dates.',
	);
	await expect(page.locator('#messages [data-record-pending][aria-busy="true"]')).toHaveCount(1);
	await expect(page.locator('#messages')).toContainText('Still calculating…');
	const patience = page.locator('[data-slot="record-patience"]').getByRole('status');
	await expect(patience).toHaveCount(1);
	await expect(patience).toContainText('Still calculating the record');
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const release = await request.post(
		`http://127.0.0.1:${dataPort}/__overview/release?fixture=alerts-${date}`,
	);
	expect(release.status()).toBe(204);
	await expect(
		page.locator('#messages').getByRole('heading', { name: 'Use stop 51234.' }),
	).toBeVisible();
	await expect(patience).toContainText('The record is on screen.');
});
