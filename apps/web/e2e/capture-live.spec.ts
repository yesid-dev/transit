import { expect, test } from '@playwright/test';

test('the Transit1 live vehicle reads the capture snapshot in English and French', async ({
	page,
}) => {
	const legacyRequests: string[] = [];
	page.on('request', (request) => {
		const { pathname } = new URL(request.url());
		if (/^(?:\/data)?\/v1\//.test(pathname)) legacyRequests.push(pathname);
	});
	for (const lang of ['en', 'fr']) {
		const response = page.waitForResponse((reply) => {
			const url = new URL(reply.url());
			return url.pathname === '/api/live' && url.searchParams.get('city') === 'stm' && reply.ok();
		});
		await page.goto(`${lang === 'fr' ? '/fr' : ''}/vehicle/40061?provider=stm&frameMode=live`);
		await response;
		const main = page.getByRole('main');
		await expect(main.getByText(lang === 'fr' ? 'Peu de places' : 'Few seats')).toBeVisible();
		await expect(main.getByRole('link', { name: /T1/ })).toHaveAttribute('href', /trip\/T1/);
	}
	expect(legacyRequests).toEqual([]);
});
