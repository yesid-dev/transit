import { expect, test } from '@playwright/test';

test.use({ bypassCSP: true });

type Paint = { size: number; center: number[]; plate: number[]; window: number[] };
type OverlayProbe = Window & { vehiclePaints?: Paint[] };
type FrameProbe = Window & { vehicleFrames?: number[][][] };

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

test('an on-time bus body repaints with the on-time status colour in the first frame after a theme change', async ({
	page,
}, { project }) => {
	test.skip(project.name !== 'desktop', 'one canvas renderer check');
	// On time is the page ink in each theme (near white on dark, near black on light), so a
	// body left from the other theme would vanish into the basemap. The theme change alone
	// must repaint: no feed frame arrives and the camera does not move before the sample.
	const published = '2026-06-15T12:00:00Z';
	const [lon, lat] = [-73.65, 45.53];
	await page.clock.setFixedTime(Date.parse(published) + 30_000);
	await page.emulateMedia({ colorScheme: 'dark', forcedColors: 'none' });
	await page.addInitScript(() => {
		localStorage.setItem('theme', 'dark');
		const state = window as FrameProbe;
		state.vehicleFrames = [];
		const clear = CanvasRenderingContext2D.prototype.clearRect;
		CanvasRenderingContext2D.prototype.clearRect = function (...args) {
			if (this.canvas.dataset.slot === 'vehicle-overlay') state.vehicleFrames!.push([]);
			return Reflect.apply(clear, this, args);
		};
		const draw = CanvasRenderingContext2D.prototype.drawImage;
		CanvasRenderingContext2D.prototype.drawImage = function (
			...args: [CanvasImageSource, number, number, ...number[]]
		) {
			const [source] = args;
			if (this.canvas.dataset.slot === 'vehicle-overlay' && source instanceof HTMLCanvasElement) {
				const centre = Array.from(
					source
						.getContext('2d')!
						.getImageData(Math.floor(source.width / 2), Math.floor(source.height / 2), 1, 1).data,
				);
				state.vehicleFrames!.at(-1)?.push(centre);
			}
			return Reflect.apply(draw, this, args);
		};
	});
	// Serve the feed once, then hold every later poll so no feed frame can repaint the bus.
	let feedRequests = 0;
	await page.route('**/live/vehicles.json', (route) => {
		if (++feedRequests > 1) return;
		return route.fulfill({
			json: {
				generated_utc: published,
				publish_generation_id: 'stm@on-time-rebake-e2e',
				vehicles: [
					{
						id: 'on-time-bus',
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
		});
	});
	await page.goto(`/map?provider=stm&mapview=${lon},${lat},11,0,0`);
	const onTime = () =>
		page.evaluate(() => {
			const probe = document.createElement('span');
			probe.style.color = 'var(--dataviz-status-on-time)';
			document.body.append(probe);
			const rgb = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
			probe.remove();
			return [...rgb.slice(0, 3), 255];
		});
	const frames = () => page.evaluate(() => (window as FrameProbe).vehicleFrames ?? []);
	const overlay = page.locator('[data-slot="vehicle-overlay"]');
	const receipt = () =>
		overlay.evaluate((element) => {
			const { transform } = Reflect.get(element, Symbol.for('transit.map.vehicleOverlayReceipt'));
			return { transform };
		});

	const dark = await onTime();
	await expect.poll(async () => (await frames()).at(-1)?.[0] ?? null).toEqual(dark);
	const before = await receipt();
	const settled = (await frames()).length;

	await page.getByTestId('theme-toggle').click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	const light = await onTime();
	expect(light).not.toEqual(dark);
	await expect.poll(async () => (await frames()).length).toBeGreaterThan(settled);
	// The first frame after the toggle is the sample: it must already carry the light palette.
	expect((await frames())[settled]?.[0]).toEqual(light);
	const after = await receipt();
	expect(after.transform).toBe(before.transform);
});
