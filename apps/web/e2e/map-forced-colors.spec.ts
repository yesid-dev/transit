import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

type Paint = { size: number; center: number[]; plate: number[]; window: number[] };
type OverlayProbe = Window & { vehiclePaints?: Paint[] };

for (const scheme of ['light', 'dark'] as const) {
	for (const zoom of [11, 15]) {
		test(`vehicle marks retain their silhouette and internal contrast in forced ${scheme} at zoom ${zoom}`, async ({
			page,
		}, { project }) => {
			test.skip(project.name !== 'desktop', 'one canvas renderer check per scheme and scale');
			const published = '2026-06-15T12:00:00Z';
			const [lon, lat] = [-73.65, 45.53];
			await page.clock.setFixedTime(Date.parse(published) + 30_000);
			await page.emulateMedia({ colorScheme: scheme, forcedColors: 'none' });
			await page.addInitScript((theme) => {
				localStorage.setItem('theme', theme);
				const state = window as OverlayProbe;
				const clear = CanvasRenderingContext2D.prototype.clearRect;
				CanvasRenderingContext2D.prototype.clearRect = function (...args) {
					if (this.canvas.dataset.slot === 'vehicle-overlay') state.vehiclePaints = [];
					return Reflect.apply(clear, this, args);
				};
				const draw = CanvasRenderingContext2D.prototype.drawImage;
				const samples = new WeakMap<HTMLCanvasElement, Omit<Paint, 'size'>>();
				CanvasRenderingContext2D.prototype.drawImage = function (
					...args: [CanvasImageSource, number, number, ...number[]]
				) {
					const [source, , , size] = args;
					if (
						this.canvas.dataset.slot === 'vehicle-overlay' &&
						source instanceof HTMLCanvasElement
					) {
						let pixels = samples.get(source);
						if (!pixels) {
							const context = source.getContext('2d')!;
							const at = (x: number, y: number) =>
								Array.from(
									context.getImageData(
										Math.floor((x * source.width) / 26),
										Math.floor((y * source.height) / 26),
										1,
										1,
									).data,
								);
							pixels = { center: at(13, 13), plate: at(8.5, 13), window: at(13, 8) };
							samples.set(source, pixels);
						}
						state.vehiclePaints?.push({ ...pixels, size });
					}
					return Reflect.apply(draw, this, args);
				};
			}, scheme);
			await page.route('**/live/vehicles.json', (route) =>
				route.fulfill({
					json: {
						generated_utc: published,
						publish_generation_id: 'stm@forced-colors-e2e',
						vehicles: [
							{
								id: 'contrast-bus',
								lon,
								lat,
								status: 'on_time',
								delay_min: 0,
								route: '24',
								trip: 't1',
								reported_utc: '2026-06-15T11:54:00Z',
								updated_utc: '2026-06-15T11:54:00Z',
							},
						],
					},
				}),
			);
			await page.goto(`/map?provider=stm&mapview=${lon},${lat},${zoom},0,0`);
			const painted = () => page.evaluate(() => (window as OverlayProbe).vehiclePaints ?? []);
			const expected = zoom === 11 ? [20.28, 15.21] : [33.8, 20.28, 25.35];
			const sizes = async () => (await painted()).map(({ size }) => Number(size.toFixed(2)));
			await expect.poll(sizes).toEqual(expected);
			const ordinary = await painted();

			const systemColours = () =>
				page.evaluate(() =>
					['CanvasText', 'Canvas'].map((color) => {
						const probe = document.createElement('span');
						probe.style.color = color;
						document.body.append(probe);
						const actual = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
						probe.remove();
						return [...actual, 255];
					}),
				);
			async function expectForcedPaint(pair: number[][]) {
				expect(pair[0]).not.toEqual(pair[1]);
				await expect
					.poll(async () => (await painted()).map(({ center }) => center))
					.toEqual([pair[0], ...expected.slice(1).map(() => pair[1])]);
				const forced = await painted();
				expect(forced[0].window).not.toEqual(forced[0].center);
				for (const badge of forced.slice(1)) expect(badge.plate).toEqual(pair[0]);
				expect(await sizes()).toEqual(expected);
			}

			await page.emulateMedia({ forcedColors: 'active', colorScheme: scheme });
			const pair = await systemColours();
			await expectForcedPaint(pair);

			if (scheme === 'light' && zoom === 15) {
				const overlay = page.locator('[data-slot="vehicle-overlay"]');
				const generation = () =>
					overlay.evaluate(
						(element) =>
							Reflect.get(element, Symbol.for('transit.map.vehicleOverlayReceipt')).generation,
					);
				const mounted = await generation();
				await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
				const darkPair = await systemColours();
				expect(darkPair).toEqual([pair[1], pair[0]]);
				await expectForcedPaint(darkPair);
				expect(await generation()).toBe(mounted);
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
			}

			await page.emulateMedia({ forcedColors: 'none', colorScheme: scheme });
			await expect.poll(painted).toEqual(ordinary);
		});
	}
}
