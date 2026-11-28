import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dailyMessageHold } from './daily-message-hold';

const report = '/receipt?provider=stm&recordFrom=2026-11-15&recordTo=2026-11-15';

test.describe('Daily report print', () => {
	test.beforeEach(({ browserName }, info) => {
		test.skip(browserName !== 'chromium' || info.project.name !== 'desktop');
	});

	test('waits for a slow report card before printing', async ({ page, request }) => {
		const hold = dailyMessageHold(request);
		await page.setExtraHTTPHeaders(hold.headers);
		try {
			expect((await hold.start()).status()).toBe(204);
			await page.goto(report, { waitUntil: 'commit' });
			await expect(page.locator('#punctuality')).toContainText('78.9%');
			const print = page.getByRole('button', { name: 'Print', exact: true });
			await expect(print).toBeDisabled();
			await page.emulateMedia({ media: 'print' });
			await expect(page.getByText('Some sections are still loading.')).toBeVisible();
			expect((await hold.release()).status()).toBe(204);
			await expect(page.getByText('Some sections are still loading.')).toBeHidden();
			await page.emulateMedia({ media: 'screen' });
			await expect(print).toBeEnabled();
		} finally {
			await hold.release();
		}
	});

	for (const locale of ['en', 'fr'] as const) {
		test('prints ' + locale + ' at paper text sizes', async ({ page }, info) => {
			const fr = locale === 'fr';
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.addInitScript(
				(theme) => localStorage.setItem('theme', theme),
				fr ? 'dark' : 'light',
			);
			await page.goto((fr ? '/fr' : '') + report);
			await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
			const main = page.getByRole('main');
			const title = fr
				? 'Rapport du dimanche 15 novembre 2026'
				: 'Report for Sunday 15 November 2026';
			await expect(main.getByRole('heading', { level: 1 })).toHaveAccessibleName(title);
			await expect(page).toHaveTitle(new RegExp('^' + title));
			await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
				'content',
				new RegExp('^' + title),
			);
			const messages = main.locator('#messages');
			const notices = messages.getByRole('heading', { level: 3 });
			await expect(notices).toHaveCount(5);
			await expect(messages.locator('h3[lang=fr]')).toHaveCount(5);
			await expect(notices.first()).toHaveText(
				'Le service est réduit sur Sauvé en raison de travaux.',
			);
			const dates = messages.locator('[data-slot="agency-message-dates"]').first();
			await expect(dates).toHaveText(
				fr ? '15 nov. 2026, de 8 h à 18 h' : '15 Nov 2026, 08:00 to 18:00',
			);
			const preview = messages.getByText('Consultez l’avis de service', { exact: false }).first();
			await expect(preview).toBeVisible();
			const count = await notices.count();
			// Five of the six notices on these dates: the link and the foot name all six.
			await expect(messages.locator('a[href*="/alerts"]')).toHaveText(
				fr ? 'Voir 6 avis dans les avis de service' : 'See 6 notices in Service alerts',
			);
			await expect(messages.locator('footer')).toContainText(
				fr ? `${count} des 6 avis.` : `${count} of 6 notices.`,
			);
			await expect(main.locator('#punctuality')).toContainText(fr ? /78,9\s%/u : '78.9%');
			await expect(main.locator('#punctuality')).toContainText(fr ? /97,2\s%/u : '97.2%');
			// Scheduled, no live data, status unknown, ran, cancelled, missing: the five under Scheduled add up to it.
			await expect(main.locator('#delivery [data-slot="fact-row"]')).toHaveCount(6);
			const actions = main.getByRole('group', { name: fr ? 'Actions du bilan' : 'Record actions' });
			await expect(actions.getByRole('button')).toHaveCount(4);
			const print = actions.getByRole('button', { name: fr ? 'Imprimer' : 'Print', exact: true });
			await expect(print).toHaveAccessibleDescription(
				fr ? 'Imprime le rapport et ses sources.' : 'Prints the report and its sources.',
			);
			const actionTops = await actions
				.getByRole('button')
				.evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
			expect(Math.max(...actionTops) - Math.min(...actionTops)).toBeLessThan(1);
			const rankingsCard = main.getByRole('article', {
				name: fr ? 'Lignes et arrêts les moins ponctuels' : 'Lowest on-time lines and stops',
			});
			const rankingsFooter = rankingsCard.locator('footer');
			await expect(rankingsFooter).toHaveCount(1);
			const rankings = rankingsCard.getByRole('table');
			await expect(rankings).toHaveCount(2);
			for (const table of await rankings.all()) {
				await expect(table.locator('tbody tr').first()).toContainText(
					fr ? /\d passages aux arrêts/u : /\d stop arrivals/u,
				);
			}
			await expect(rankingsFooter).not.toContainText(fr ? 'passages aux arrêts' : 'stop arrivals');
			await expect(rankingsFooter).not.toContainText(fr ? 'méthode v' : 'method v');
			const about = main.getByRole('article', {
				name: fr ? 'À propos de ces chiffres' : 'About these figures',
			});
			await expect(about).toBeVisible();
			await page.evaluate(() => document.fonts.ready);
			await page.emulateMedia({ media: 'print' });
			await expect(dates).toBeVisible();
			await expect(preview).toBeHidden();
			await expect(main.locator('.daily-report')).toHaveCSS('color', 'rgb(19, 25, 35)');
			await expect(page.getByRole('banner')).toBeHidden();
			await expect(actions).toBeHidden();
			const rankingsBox = (await main.locator('#lines > [data-slot="card"]').boundingBox())!;
			const aboutBox = (await about.locator('xpath=..').boundingBox())!;
			expect(aboutBox.x).toBeGreaterThan(rankingsBox.x + rankingsBox.width);
			expect(Math.abs(aboutBox.y - rankingsBox.y)).toBeLessThan(1);
			// Paper sizes, not a shrunk screen: body 10 pt and up, every note and figure 9 pt and up.
			const sizes = await main.locator('.daily-report').evaluate((report) => {
				const points: number[] = [];
				const walker = document.createTreeWalker(report, NodeFilter.SHOW_TEXT);
				while (walker.nextNode()) {
					const parent = walker.currentNode.parentElement;
					if (!parent || !walker.currentNode.textContent?.trim()) continue;
					if (!parent.getClientRects().length) continue;
					points.push((parseFloat(getComputedStyle(parent).fontSize) * 72) / 96);
				}
				return { body: (parseFloat(getComputedStyle(report).fontSize) * 72) / 96, points };
			});
			expect(sizes.body).toBeGreaterThanOrEqual(10);
			expect(Math.min(...sizes.points)).toBeGreaterThanOrEqual(9);
			for (const format of ['Letter', 'A4'] as const) {
				const pdf = await page.pdf({
					format,
					path: info.outputPath(locale + '-' + format + '.pdf'),
				});
				// The report may run onto a second sheet rather than shrink.
				const pages = pdf.toString('latin1').match(/\/Type\s*\/Page\b/gu) ?? [];
				expect(pages.length, format).toBeGreaterThanOrEqual(1);
			}
		});
	}
});

if (process.env.TRANSIT_E2E_DAILY_ARTWORK === '1') {
	test('captures the daily report design variants', async ({ page }, info) => {
		test.skip(info.project.name !== 'desktop');
		const output = info.outputPath('pr18');
		await mkdir(output, { recursive: true });
		const variants = [
			{ name: 'stm-en-1440-light', href: report, width: 1440, theme: 'light' },
			{ name: 'stm-fr-1440-dark', href: '/fr' + report, width: 1440, theme: 'dark' },
			{
				name: 'oc-en-390-light',
				href: report.replace('stm', 'octranspo'),
				width: 390,
				theme: 'light',
			},
			{ name: 'stm-fr-390-dark', href: '/fr' + report, width: 390, theme: 'dark' },
			{
				name: 'range-1440',
				href: report.replace('recordTo=2026-11-15', 'recordTo=2026-11-21'),
				width: 1440,
				theme: 'light',
			},
			{
				name: 'engine-unreachable',
				href: report.replaceAll('2026-11-15', '2026-11-14'),
				width: 1440,
				theme: 'light',
			},
			{
				name: 'unpublished-yesterday',
				href: '/receipt?provider=stm&period=yesterday',
				width: 1440,
				theme: 'light',
			},
		];
		for (const { name, href, width, theme } of variants) {
			await page.setViewportSize({ width, height: 900 });
			await page.goto(href);
			await page.evaluate((next) => localStorage.setItem('theme', next), theme);
			await page.reload();
			const content = page.getByRole('main');
			if (name === 'unpublished-yesterday') {
				await expect(content.getByText(/is not in the record yet/u)).toHaveCount(1);
			} else if (name === 'engine-unreachable') {
				await expect(content.locator('#periods')).toContainText(
					'The record is temporarily unavailable.',
				);
			} else {
				await expect(content.locator('#stops')).toContainText('Express Saint-Joseph / Bélanger');
			}
			if (name === 'oc-en-390-light') {
				await expect(
					content.locator('#messages [data-record-state="not_published"]'),
				).toBeVisible();
				await expect(content.locator('#messages')).toContainText(
					'Not published: OC Transpo does not publish its service alerts as open data. It posts them on its website.',
				);
			}
			if (name === 'range-1440') {
				await expect(
					content.locator('#messages [data-slot="agency-message-dates"]').first(),
				).toHaveText('15 to 21 Nov 2026');
			}
			await page.evaluate(() => document.fonts.ready);
			await page.screenshot({
				path: join(output, name + '.png'),
				fullPage: true,
				animations: 'disabled',
			});
			console.log(name, await page.evaluate(() => document.documentElement.scrollHeight));
		}
	});
}
