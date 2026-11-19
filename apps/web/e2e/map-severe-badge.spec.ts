import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

type Draw = { x: number; y: number; size: number };
type DrawProbe = Window & { vehicleDraws?: Draw[] };

// Late and severe share a body colour, so at the default overview zoom only the severe ◆
// tells them apart. The badge must sit under the severe bus and never under the late one.
for (const [scheme, forcedColors] of [
	['light', 'none'],
	['dark', 'none'],
	['dark', 'active'],
] as const) {
	test(`a severe bus shows its ◆ at zoom 12 and a late bus does not (${scheme}, forced colours ${forcedColors})`, async ({
		page,
	}, { project }) => {
		test.skip(project.name !== 'desktop', 'one canvas renderer check per scheme');
		const published = '2026-06-15T12:00:00Z';
		const [lon, lat] = [-73.65, 45.53];
		await page.clock.setFixedTime(Date.parse(published) + 30_000);
		await page.emulateMedia({ colorScheme: scheme, forcedColors });
		await page.addInitScript((theme) => {
			localStorage.setItem('theme', theme);
			const state = window as DrawProbe;
			const clear = CanvasRenderingContext2D.prototype.clearRect;
			CanvasRenderingContext2D.prototype.clearRect = function (...args) {
				if (this.canvas.dataset.slot === 'vehicle-overlay') state.vehicleDraws = [];
				return Reflect.apply(clear, this, args);
			};
			const draw = CanvasRenderingContext2D.prototype.drawImage;
			CanvasRenderingContext2D.prototype.drawImage = function (
				...args: [CanvasImageSource, number, number, number, number]
			) {
				const [source, x, y, size] = args;
				if (this.canvas.dataset.slot === 'vehicle-overlay' && source instanceof HTMLCanvasElement)
					state.vehicleDraws?.push({ x: x + size / 2, y: y + size / 2, size });
				return Reflect.apply(draw, this, args);
			};
		}, scheme);
		const bus = (id: string, offset: number, status: string, delay: number) => ({
			id,
			lon: lon + offset,
			lat,
			status,
			delay_min: delay,
			route: '24',
			trip: id,
			reported_utc: '2026-06-15T11:59:30Z',
			updated_utc: '2026-06-15T11:59:30Z',
		});
		await page.route('**/live/vehicles.json', (route) =>
			route.fulfill({
				json: {
					generated_utc: published,
					publish_generation_id: 'stm@severe-badge-e2e',
					vehicles: [bus('late-bus', -0.01, 'late', 3), bus('severe-bus', 0.01, 'severe', 9)],
				},
			}),
		);
		await page.goto(`/map?provider=stm&mapview=${lon},${lat},12,0,0`);
		const draws = () => page.evaluate(() => (window as DrawProbe).vehicleDraws ?? []);
		await expect.poll(async () => (await draws()).length).toBe(3);
		const [first, second, badge] = await draws();
		// Bodies paint first, then the one badge: 0.6 of the body, 30 units below its bus.
		expect(first.size).toBeCloseTo(second.size, 3);
		expect(badge.size).toBeCloseTo(first.size * 0.6, 3);
		const [late, severe] = [first, second].sort((a, b) => a.x - b.x);
		expect(badge.x).toBeCloseTo(severe.x, 3);
		expect(badge.x).not.toBeCloseTo(late.x, 0);
		expect(badge.y).toBeCloseTo(severe.y + (first.size / 26) * 30, 3);
	});
}
