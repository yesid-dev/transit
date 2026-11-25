import { expect, test } from '@playwright/test';
import { captureFixture, captureUrl, captureVehicle } from './capture-fixture';

test.use({ bypassCSP: true });

type Draw = { x: number; y: number; size: number };
type DrawProbe = Window & { vehicleDraws?: Draw[] };

// At overview zoom, status badges stay hidden in each theme.
for (const [scheme, forcedColors] of [
	['light', 'none'],
	['dark', 'none'],
	['dark', 'active'],
] as const) {
	test(`vehicle bodies render without status badges at zoom 12 (${scheme}, forced colours ${forcedColors})`, async ({
		page,
		browserName,
	}, { project }) => {
		test.skip(project.name !== 'desktop', 'one canvas renderer check per scheme');
		test.skip(
			forcedColors === 'active' && browserName !== 'chromium',
			'forced colours emulation is available in Chromium',
		);
		const published = '2026-06-15T12:00:00Z';
		const [lon, lat] = [-73.65, 45.53];
		await page.clock.setFixedTime(Date.parse(published) + 30_000);
		await page.emulateMedia({
			colorScheme: scheme,
			forcedColors: forcedColors === 'active' ? forcedColors : undefined,
		});
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
		const at = Date.parse(published);
		const vehicle = (id: string, offset: number, delay: number) =>
			captureVehicle(at, {
				id,
				vehicle_id: id,
				trip_id: id,
				longitude: lon + offset,
				latitude: lat,
				delay,
				occupancy: null,
				observed_at: '2026-06-15T11:59:30Z',
			});
		await page.route(captureUrl, (route) =>
			route.fulfill({
				json: captureFixture(at, {
					vehicle_positions: [
						vehicle('on-time-vehicle', -0.01, 180),
						vehicle('late-vehicle', 0.01, 540),
					],
				}),
			}),
		);
		await page.goto(`/map?provider=stm&mapview=${lon},${lat},12,0,0`);
		const draws = () => page.evaluate(() => (window as DrawProbe).vehicleDraws ?? []);
		await expect.poll(async () => (await draws()).length).toBe(2);
		const [first, second] = await draws();
		expect(first.size).toBeCloseTo(second.size, 3);
		expect(Math.abs(first.x - second.x)).toBeGreaterThan(first.size);
	});
}
