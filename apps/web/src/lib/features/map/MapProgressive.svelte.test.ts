import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MapProgressive from './MapProgressive.svelte';

const harness = vi.hoisted(() => {
	let reduced = false;
	const subscribers = new Set<(value: boolean) => void>();
	return {
		locale: 'en' as 'en' | 'fr',
		provider: 'stm',
		city: 'Montréal',
		posters: '/map/basemap-montreal-posters.json',
		prefersReducedMotion: {
			subscribe(subscriber: (value: boolean) => void) {
				subscriber(reduced);
				subscribers.add(subscriber);
				return () => subscribers.delete(subscriber);
			},
		},
		setReduced(next: boolean) {
			reduced = next;
			for (const subscriber of subscribers) subscriber(next);
		},
	};
});

vi.mock('#lib/v1/boot.ts', () => ({
	getV1Context: () => ({
		manifest: { provider: harness.provider, city: harness.city },
		provider: {
			posters_url: harness.posters,
			labels: { en: { city: harness.city }, fr: { city: harness.city } },
		},
	}),
}));

vi.mock('#lib/i18n/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/i18n/index.ts')>()),
	getLocale: () => harness.locale,
}));
vi.mock('@yesid/motion/stores/reducedMotion', () => ({
	prefersReducedMotion: harness.prefersReducedMotion,
}));

type HeroModule = typeof import('./__fixtures__/MapProgressiveHeroStub.svelte');

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => {
		resolve = next;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function neverImport(): Promise<never> {
	return new Promise<never>(() => {});
}

afterEach(() => {
	cleanup();
	harness.locale = 'en';
	harness.provider = 'stm';
	harness.city = 'Montréal';
	harness.posters = '/map/basemap-montreal-posters.json';
	harness.setReduced(false);
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe('MapProgressive automatic live boot', () => {
	it.each([
		['en', 'Record map', 'Loading the Record map…'],
		['fr', 'Carte du bilan', 'Chargement de la carte du bilan…'],
	] as const)('keeps the Record title during automatic loading in %s', (locale, title, loading) => {
		harness.locale = locale;
		const view = render(MapProgressive, { props: { record: true, importHero: neverImport } });
		expect(view.getByRole('heading', { level: 1 })).toHaveTextContent(title);
		expect(view.getByRole('status')).toHaveTextContent(loading);
	});
	it.each(['en', 'fr'] as const)(
		'uses the selected city image and keeps the source links in %s',
		async (locale) => {
			harness.locale = locale;
			for (const [id, city, stem] of [
				['stm', 'Montréal', 'montreal'],
				['octranspo', 'Ottawa', 'ottawa'],
			]) {
				harness.provider = id;
				harness.city = city;
				harness.posters = `/map/basemap-${stem}-posters.json`;
				const view = render(MapProgressive, { props: { importHero: neverImport } });
				const image = view.container.querySelector('picture img');
				expect(image).toHaveAttribute('src', expect.stringContaining(`/map/basemap-${stem}-`));
				expect(image).toHaveAttribute('alt', '');
				expect(view.getByRole('heading', { level: 1 })).toHaveTextContent(city);
				expect(view.getByRole('link', { name: /OpenStreetMap contributors/ })).toBeVisible();
				expect(view.getByRole('link', { name: /Protomaps/ })).toBeVisible();
				cleanup();
			}
		},
	);

	it.each(['', '/map/basemap-montreal-posters.json'])(
		'never shows a missing or foreign poster for Ottawa',
		async (posters) => {
			harness.provider = 'octranspo';
			harness.city = 'Ottawa';
			harness.posters = posters;

			const view = render(MapProgressive, { props: { importHero: neverImport } });
			expect(view.container.querySelector('picture img')).toBeNull();
			expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Live map · Ottawa');
			expect(view.getByRole('status')).toHaveTextContent('Loading the live map…');
		},
	);

	it.each([
		['en', 'Live map · Ottawa', 'Loading the live map…', 'Try live map again'],
		[
			'fr',
			'Carte en direct · Ottawa',
			'Chargement de la carte en direct…',
			'Réessayer la carte en direct',
		],
	] as const)(
		'shows one loading sentence and replaces it with recovery on failure in %s',
		async (locale, title, loading, retry) => {
			harness.locale = locale;
			harness.provider = 'octranspo';
			harness.city = 'Ottawa';

			const fixture = await import('./__fixtures__/MapProgressiveHeroStub.svelte');
			for (const posters of ['', '/map/basemap-ottawa-posters.json']) {
				harness.posters = posters;
				const view = render(MapProgressive, { props: { importHero: async () => fixture } });
				await view.findByTestId('map-progressive-hero-stub');
				const heading = view.getByRole('heading', { level: 1, name: title });
				expect(heading.parentElement?.textContent?.trim().replace(/\s+/g, ' ')).toBe(
					`${title} ${loading}`,
				);
				await fireEvent.click(view.getByTestId('progressive-stub-failure'));
				expect(view.queryByText(loading)).toBeNull();
				expect(view.getByRole('alert')).toBeVisible();
				expect(view.getByRole('button', { name: retry })).toBeEnabled();
				cleanup();
			}
		},
	);

	it('removes a failed image while the map keeps loading', async () => {
		const view = render(MapProgressive, { props: { importHero: neverImport } });
		await fireEvent.error(view.container.querySelector('picture img')!);
		expect(view.container.querySelector('picture img')).toBeNull();
		expect(view.getByRole('status')).toHaveTextContent('Loading the live map…');
	});

	it('imports immediately on mount without a CTA, intent seam, timer, idle, or frame gate', async () => {
		vi.useFakeTimers();
		const requestIdleCallback = vi.fn();
		const requestAnimationFrame = vi.fn();
		vi.stubGlobal('requestIdleCallback', requestIdleCallback);
		vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
		const intent = vi.fn();
		document.addEventListener('transit:map-intent', intent);

		try {
			const importer = vi.fn(neverImport);
			const view = render(MapProgressive, { props: { importHero: importer } });

			await tick();

			expect(importer).toHaveBeenCalledOnce();
			expect(requestIdleCallback).not.toHaveBeenCalled();
			expect(requestAnimationFrame).not.toHaveBeenCalled();
			expect(intent).not.toHaveBeenCalled();
			expect(view.getByTestId('map-progressive')).toHaveAttribute(
				'data-map-progressive-state',
				'booting',
			);
			expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Live map');
			expect(view.getByRole('status')).toHaveTextContent('Loading the live map…');
			expect(view.queryByRole('button', { name: /load live interactive map/iu })).toBeNull();
			expect(view.container.querySelector('[data-map-wake]')).toBeNull();
			expect(view.getByTestId('map-progressive')).not.toHaveAttribute('data-map-intent-time');
		} finally {
			document.removeEventListener('transit:map-intent', intent);
		}
	});

	it('keeps the automatic hero import single-flight while its chunk is pending', async () => {
		const pending = deferred<HeroModule>();
		const importer = vi.fn(() => pending.promise);
		const view = render(MapProgressive, { props: { importHero: importer } });

		await tick();
		await tick();
		expect(importer).toHaveBeenCalledOnce();
		expect(view.queryByTestId('map-progressive-hero-stub')).toBeNull();

		pending.resolve(await import('./__fixtures__/MapProgressiveHeroStub.svelte'));
		expect(await view.findByTestId('map-progressive-hero-stub')).toBeInTheDocument();
		expect(importer).toHaveBeenCalledOnce();
	});

	it('keeps the poster mounted and the live layer inert until the map and first data settle', async () => {
		const pending = deferred<HeroModule>();
		const view = render(MapProgressive, { props: { importHero: () => pending.promise } });

		await tick();
		expect(view.queryByTestId('map-progressive-hero-stub')).toBeNull();
		expect(view.getByTestId('map-progressive-poster')).toHaveAttribute('data-visible', 'true');
		expect(view.getByTestId('map-progressive-live')).toHaveAttribute('aria-hidden', 'true');
		expect(view.getByTestId('map-progressive-live')).toHaveAttribute('inert');

		pending.resolve(await import('./__fixtures__/MapProgressiveHeroStub.svelte'));
		await waitFor(() => expect(view.getByTestId('map-progressive-hero-stub')).toBeInTheDocument());
		expect(view.getByTestId('map-progressive-poster')).toHaveAttribute('data-visible', 'true');

		await fireEvent.click(view.getByTestId('progressive-stub-ready'));
		expect(view.getByTestId('map-progressive-poster')).toHaveAttribute('data-visible', 'true');
		expect(view.getByTestId('map-progressive-live')).toHaveAttribute('aria-hidden', 'true');
		expect(view.getByTestId('map-progressive-live')).toHaveAttribute('inert');

		await fireEvent.click(view.getByTestId('progressive-stub-idle-before-data'));
		expect(view.getByTestId('map-progressive')).toHaveAttribute('data-map-idle-time');
		expect(view.getByTestId('map-progressive-poster')).toHaveAttribute('data-visible', 'true');
		expect(view.getByTestId('map-progressive-live')).toHaveAttribute('inert');

		await fireEvent.click(view.getByTestId('progressive-stub-idle'));
		expect(view.getByTestId('map-progressive-poster')).toHaveAttribute('data-visible', 'false');
		expect(view.getByTestId('map-progressive-live')).not.toHaveAttribute('aria-hidden');
		expect(view.getByTestId('map-progressive-live')).not.toHaveAttribute('inert');

		await fireEvent.click(view.getByTestId('progressive-stub-idle'));
		expect(view.getByTestId('map-progressive')).toHaveAttribute(
			'data-map-progressive-state',
			'ready',
		);
	});

	it('does not steal focus when the live map reaches first idle', async () => {
		const focusOwner = document.createElement('button');
		focusOwner.textContent = 'Current focus';
		document.body.append(focusOwner);

		try {
			focusOwner.focus();

			const fixture = await import('./__fixtures__/MapProgressiveHeroStub.svelte');
			const view = render(MapProgressive, { props: { importHero: async () => fixture } });

			await view.findByTestId('map-progressive-hero-stub');
			await fireEvent.click(view.getByTestId('progressive-stub-ready'));
			await fireEvent.click(view.getByTestId('progressive-stub-idle'));
			await tick();

			expect(document.activeElement).toBe(focusOwner);
			expect(document.activeElement).not.toBe(view.getByTestId('progressive-stub-map-canvas'));
		} finally {
			focusOwner.remove();
		}
	});

	it('retries a rejected automatic import once without an activation seam or focus handoff', async () => {
		const focusOwner = document.createElement('button');
		focusOwner.textContent = 'Current focus';
		document.body.append(focusOwner);
		const secondImport = deferred<HeroModule>();

		try {
			focusOwner.focus();

			const importer = vi
				.fn<() => Promise<HeroModule>>()
				.mockRejectedValueOnce(new Error('chunk unavailable'))
				.mockImplementationOnce(() => secondImport.promise);
			const view = render(MapProgressive, { props: { importHero: importer } });
			const retry = await view.findByRole('button', { name: 'Try live map again' });
			expect(retry).toHaveAttribute('data-slot', 'button');
			expect(retry).toHaveClass('min-h-11');

			expect(view.getByRole('alert')).toHaveTextContent('Live map could not start');
			expect(view.container.querySelector('[data-map-wake]')).toBeNull();
			await Promise.all([fireEvent.click(retry), fireEvent.click(retry), fireEvent.click(retry)]);
			expect(importer).toHaveBeenCalledTimes(2);

			secondImport.resolve(await import('./__fixtures__/MapProgressiveHeroStub.svelte'));
			await view.findByTestId('map-progressive-hero-stub');
			await fireEvent.click(view.getByTestId('progressive-stub-ready'));
			await fireEvent.click(view.getByTestId('progressive-stub-idle'));
			await tick();

			expect(importer).toHaveBeenCalledTimes(2);
			expect(document.activeElement).toBe(focusOwner);
		} finally {
			focusOwner.remove();
		}
	});

	it('retries one live MapStage failure without moving focus to the canvas', async () => {
		const focusOwner = document.createElement('button');
		focusOwner.textContent = 'Current focus';
		document.body.append(focusOwner);

		try {
			const fixture = await import('./__fixtures__/MapProgressiveHeroStub.svelte');
			const view = render(MapProgressive, { props: { importHero: async () => fixture } });
			const hero = await view.findByTestId('map-progressive-hero-stub');

			await fireEvent.click(view.getByTestId('progressive-stub-failure'));
			expect(view.getByRole('alert')).toHaveTextContent('Live map could not start');
			const retry = view.getByRole('button', { name: 'Try live map again' });
			focusOwner.focus();
			await Promise.all([fireEvent.click(retry), fireEvent.click(retry), fireEvent.click(retry)]);
			await waitFor(() => expect(hero).toHaveAttribute('data-retry-count', '1'));

			await fireEvent.click(view.getByTestId('progressive-stub-ready'));
			await fireEvent.click(view.getByTestId('progressive-stub-idle'));
			await tick();

			expect(hero).toHaveAttribute('data-retry-count', '1');
			expect(document.activeElement).toBe(focusOwner);
			expect(document.activeElement).not.toBe(view.getByTestId('progressive-stub-map-canvas'));
		} finally {
			focusOwner.remove();
		}
	});

	it('keeps ready and first-idle measurement events without restoring an intent event', async () => {
		const intent = vi.fn();
		document.addEventListener('transit:map-intent', intent);

		try {
			const fixture = await import('./__fixtures__/MapProgressiveHeroStub.svelte');
			const view = render(MapProgressive, { props: { importHero: async () => fixture } });
			const root = view.getByTestId('map-progressive');
			const ready = vi.fn();
			const idle = vi.fn();
			root.addEventListener('transit:map-ready', ready);
			root.addEventListener('transit:maplibre-idle', idle);

			await view.findByTestId('map-progressive-hero-stub');
			expect(intent).not.toHaveBeenCalled();
			expect(root.dataset.mapIntentTime).toBeUndefined();

			await fireEvent.click(view.getByTestId('progressive-stub-ready'));
			expect(ready).toHaveBeenCalledOnce();
			expect(root).toHaveAttribute('data-map-progressive-state', 'booting');

			await fireEvent.click(view.getByTestId('progressive-stub-idle'));
			await fireEvent.click(view.getByTestId('progressive-stub-idle'));
			expect(idle).toHaveBeenCalledOnce();
			expect(root).toHaveAttribute('data-map-progressive-state', 'ready');
		} finally {
			document.removeEventListener('transit:map-intent', intent);
		}
	});

	it('disables the poster-to-live transition when reduced motion is requested', async () => {
		harness.setReduced(true);

		const view = render(MapProgressive, { props: { importHero: neverImport } });

		expect(view.getByTestId('map-progressive-poster')).toHaveStyle({ transition: 'none' });
		expect(view.getByTestId('map-progressive-live')).toHaveStyle({ transition: 'none' });
	});
});

describe('MapProgressive owned recovery attempt', () => {
	it('keeps the same Hero mounted while publishing one new ready/idle attempt', async () => {
		const fixture = await import('./__fixtures__/MapProgressiveHeroStub.svelte');
		const view = render(MapProgressive, { props: { importHero: async () => fixture } });
		const root = view.getByTestId('map-progressive');
		const hero = await view.findByTestId('map-progressive-hero-stub');
		const ready = vi.fn();
		const idle = vi.fn();
		root.addEventListener('transit:map-ready', ready);
		root.addEventListener('transit:maplibre-idle', idle);
		await fireEvent.click(view.getByTestId('progressive-stub-ready'));
		await fireEvent.click(view.getByTestId('progressive-stub-idle'));
		const firstAttempt = Number(root.dataset.mapAttempt);
		expect(root).toHaveAttribute('data-map-progressive-state', 'ready');

		await fireEvent.click(view.getByTestId('progressive-stub-recovering'));
		expect(root).toHaveAttribute('data-map-progressive-state', 'booting');
		expect(Number(root.dataset.mapAttempt)).toBe(firstAttempt + 1);
		expect(root.dataset.mapReadyTime).toBeUndefined();
		expect(root.dataset.mapIdleTime).toBeUndefined();
		expect(view.getByTestId('map-progressive-hero-stub')).toBe(hero);
		expect(view.getByTestId('map-progressive-live')).toHaveAttribute('inert');
		expect(view.getByTestId('map-progressive-poster')).toHaveAttribute('data-visible', 'true');
		await fireEvent.click(view.getByTestId('progressive-stub-ready'));
		await fireEvent.click(view.getByTestId('progressive-stub-idle'));
		await fireEvent.click(view.getByTestId('progressive-stub-idle'));
		expect(root).toHaveAttribute('data-map-progressive-state', 'ready');
		expect(Number(root.dataset.mapAttempt)).toBe(firstAttempt + 1);
		expect(ready).toHaveBeenCalledTimes(2);
		expect(idle).toHaveBeenCalledTimes(2);
	});

	it('counts a later explicit retry once after recovery boot fails', async () => {
		const fixture = await import('./__fixtures__/MapProgressiveHeroStub.svelte');
		const view = render(MapProgressive, { props: { importHero: async () => fixture } });
		const root = view.getByTestId('map-progressive');
		await view.findByTestId('map-progressive-hero-stub');
		await fireEvent.click(view.getByTestId('progressive-stub-ready'));
		await fireEvent.click(view.getByTestId('progressive-stub-idle'));
		const first = Number(root.dataset.mapAttempt);
		await fireEvent.click(view.getByTestId('progressive-stub-recovering'));
		expect(Number(root.dataset.mapAttempt)).toBe(first + 1);
		await fireEvent.click(view.getByTestId('progressive-stub-failure'));
		await fireEvent.click(view.getByRole('button', { name: 'Try live map again' }));
		await waitFor(() =>
			expect(view.getByTestId('map-progressive-hero-stub')).toHaveAttribute(
				'data-retry-count',
				'1',
			),
		);
		expect(Number(root.dataset.mapAttempt)).toBe(first + 2);
		await fireEvent.click(view.getByTestId('progressive-stub-ready'));
		await fireEvent.click(view.getByTestId('progressive-stub-idle'));
		expect(root).toHaveAttribute('data-map-progressive-state', 'ready');
		expect(Number(root.dataset.mapAttempt)).toBe(first + 2);
	});
});
