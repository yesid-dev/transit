import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test('overlapping Finder reads keep their own schedule fixtures', async ({ request }) => {
	const dataPort = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const controls = `http://127.0.0.1:${dataPort}/__overview`;
	const scheduleHold = `schedule:${randomUUID()}`;
	const hold = new URLSearchParams({ fixture: scheduleHold });
	const lines =
		'/fr/lines/__data.json?provider=stm&frameMode=record&recordFrom=2026-11-04&recordTo=2026-11-10&x-sveltekit-invalidated=11';
	// The ordinary timetable has a station name containing this text.
	const namedLine = JSON.stringify('Édouard-Montpetit');
	expect((await request.post(`${controls}/hold?${hold}`)).status()).toBe(204);

	try {
		const [ordinary, named] = await Promise.all([
			request.get(lines, {
				headers: {
					'x-transit-fixture-scope': 'schedule-isolation',
					'x-transit-fixture-schedule-hold': scheduleHold,
				},
			}),
			(async () => {
				await expect
					.poll(async () => (await (await request.get(`${controls}/hold?${hold}`)).json()).waiting)
					.toBe(1);
				return request.get(lines, { headers: { 'x-transit-fixture-scope': 'lines-named' } });
			})(),
		]);
		expect(ordinary.status()).toBe(200);
		expect(named.status()).toBe(200);
		expect(await ordinary.text()).not.toContain(namedLine);
		expect(await named.text()).toContain(namedLine);
	} finally {
		await request.post(`${controls}/release?${hold}`);
	}
});
