import { render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePulse from './HomePulse.svelte';
import { homePulseCopy } from './homePulse.copy';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';

const { state, createLiveStoreSpy } = vi.hoisted(() => ({
	state: {
		network: null as Record<string, unknown> | null,
		healthState: 'live' as string,
		hotspots: null as Record<string, unknown> | null,
		hotspotsSettled: true,
		hotspotsError: null as Error | null,
		weeklyIndex: null as Record<string, unknown> | null,
		weeklySettled: true,
		weeklyError: null as Error | null,
	},
	createLiveStoreSpy: vi.fn(),
}));

vi.mock('#lib/nav/index.ts', async () => {
	const { routeFor } = await vi.importActual<typeof import('#lib/nav/intent.svelte.ts')>(
		'#lib/nav/intent.svelte.ts',
	);
	return { routeFor };
});
vi.mock('#lib/v1/live/store.svelte.ts', () => ({
	LIVE_FAMILIES: ['vehicles', 'trips', 'departures', 'alerts', 'network'],
	createLiveStore: (manifest: unknown, _reader: unknown, options: unknown) => {
		createLiveStoreSpy(manifest, options);
		return {
			get network() {
				return state.network;
			},
			get familyStates() {
				return {
					network: {
						active: true,
						retainedGeneration: null,
						health: {
							state: state.healthState,
							retained: state.network != null,
							ageSeconds: 12,
							isStale: false,
							notice: null,
						},
					},
				};
			},
			start: vi.fn(),
			stop: vi.fn(),
		};
	},
}));
vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: (_loader: unknown, options?: { key?: () => unknown }) => {
		const key = options?.key?.();
		return {
			get data() {
				if (key === 'home-hotspots') return state.hotspots;
				if (key === 'home-weekly-ranking') return state.weeklyIndex;
				return {
					routes: [{ id: '7-354', short: '7' }],
				};
			},
			get error() {
				return key === 'home-hotspots'
					? state.hotspotsError
					: key === 'home-weekly-ranking'
						? state.weeklyError
						: null;
			},
			loading: false,
			get settled() {
				return key === 'home-hotspots'
					? state.hotspotsSettled
					: key === 'home-weekly-ranking'
						? state.weeklySettled
						: true;
			},
		};
	},
}));
vi.mock('#lib/v1/repositories/historic.ts', () => ({ getHotspots: vi.fn() }));
vi.mock('#lib/v1/repositories/static.ts', () => ({ getRoutesIndex: vi.fn() }));

const manifest = { provider: 'fixture', tz: 'America/Toronto' } as never;
const liveNetwork = {
	generated_utc: '2026-11-12T23:50:24Z',
	vehicles_in_service: 355,
	on_time_pct: 57,
	status_dist: { on_time: 69, late: 78, severe: 42, early: 71, unknown: 95 },
	non_responding: 18,
	feed_freshness_s: 20,
};
const dayRanking = {
	generated_utc: '2026-11-11T00:00:00Z',
	by_grain: [
		{
			grain: 'week',
			date: '2026-11-04',
			window_end: '2026-11-10',
			entries: [
				{
					id: '7-354',
					type: 'route',
					rank: 1,
					name: 'Carleton <> St-Laurent',
					severe_pct: 24,
					observation_count: 100,
				},
				{ id: 'S9', type: 'stop', rank: 2, name: 'RIDEAU / SUSSEX', severe_pct: 21.5 },
			],
		},
	],
};

const weeklyStopIndex = {
	generated_utc: '2026-11-11T00:00:00Z',
	weekly_stops: [
		{
			id: 'S9',
			name: 'Rideau / Sussex',
			state: 'ranked',
			rank: 1,
			numerator: 157,
			denominator: 200,
			pct: 79,
			severe_pct: 21.5,
			window_start: '2026-11-04',
			window_end: '2026-11-10',
		},
	],
};

afterEach(() => {
	state.network = null;
	state.healthState = 'live';
	state.hotspots = null;
	state.hotspotsSettled = true;
	state.hotspotsError = null;
	state.weeklyIndex = null;
	state.weeklySettled = true;
	state.weeklyError = null;
	createLiveStoreSpy.mockClear();
});

describe('Home accountability strip', () => {
	it.each(['en', 'fr'] as const)('keeps fresh stops when hotspots are missing (%s)', (locale) => {
		state.weeklyIndex = weeklyStopIndex;
		render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
		const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
		expect(within(stops).getByRole('link', { name: /Rideau/ })).toBeVisible();
		expect(stops).toHaveTextContent(
			locale === 'fr' ? 'Données jusqu’au 10 nov.' : 'Data through Nov 10',
		);
	});
	it.each(['en', 'fr'] as const)(
		'keeps a fresh line when only the stop source is stale (%s)',
		(locale) => {
			state.hotspots = dayRanking;
			state.weeklyIndex = { ...weeklyStopIndex, generated_utc: '2026-11-04T00:00:00Z' };
			render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
			expect(
				within(screen.getByRole('region', { name: homePulseCopy[locale].worstLines })).getByRole(
					'link',
				),
			).toBeVisible();
			const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
			expect(within(stops).queryByRole('link')).toBeNull();
			expect(within(stops).getByRole('status')).toHaveTextContent(
				homePulseCopy[locale].worstNotCurrent,
			);
		},
	);
	it.each(['2026-11-18T07:30:00Z', '2026-11-18T08:01:00Z'])(
		'keeps both rendered rankings during normal weekly completion (%s)',
		(at) => {
			vi.setSystemTime(new Date(at));
			state.hotspots = dayRanking;
			state.weeklyIndex = weeklyStopIndex;
			render(HomePulse, { props: { locale: 'en', city: 'Ottawa', manifest } });
			for (const name of ['Most delayed lines', 'Most delayed stops'])
				expect(within(screen.getByRole('region', { name })).getByRole('link')).toBeVisible();
		},
	);
	it.each(['en', 'fr'] as const)('labels independent line and stop windows in %s', (locale) => {
		state.hotspots = {
			...dayRanking,
			by_grain: [{ ...dayRanking.by_grain[0], date: '2026-10-28', window_end: '2026-11-03' }],
		};
		state.weeklyIndex = weeklyStopIndex;
		render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
		const lines = screen.getByRole('region', { name: homePulseCopy[locale].worstLines });
		const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
		expect(lines).toHaveTextContent(
			locale === 'fr' ? 'Données jusqu’au 3 nov.' : 'Data through Nov 3',
		);
		expect(stops).toHaveTextContent(
			locale === 'fr' ? 'Données jusqu’au 10 nov.' : 'Data through Nov 10',
		);
		expect(lines).not.toHaveTextContent(locale === 'fr' ? '10 nov.' : 'Nov 10');
		expect(stops).not.toHaveTextContent(locale === 'fr' ? '3 nov.' : 'Nov 3');
	});
	it.each(['en', 'fr'] as const)('keeps fresh stops when hotspots are stale (%s)', (locale) => {
		state.weeklyIndex = weeklyStopIndex;
		state.hotspots = { ...dayRanking, generated_utc: '2026-11-04T00:00:00Z' };
		render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
		const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
		expect(within(stops).getByRole('link', { name: /Rideau/ })).toBeVisible();
		expect(stops).toHaveTextContent(
			locale === 'fr' ? 'Données jusqu’au 10 nov.' : 'Data through Nov 10',
		);
		const lines = screen.getByRole('region', { name: homePulseCopy[locale].worstLines });
		expect(within(lines).getByRole('status')).toHaveTextContent(
			locale === 'fr'
				? 'Aucun classement hebdomadaire à jour n’est disponible.'
				: 'No current weekly ranking is available.',
		);
	});
	it.each(['en', 'fr'] as const)(
		'settles the stop source independently of pending lines (%s)',
		(locale) => {
			state.hotspotsSettled = false;
			state.weeklyIndex = weeklyStopIndex;
			render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
			const lines = screen.getByRole('region', { name: homePulseCopy[locale].worstLines });
			const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
			expect(lines.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'true');
			expect(stops.querySelector('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
			expect(within(stops).getByRole('link', { name: /Rideau/ })).toBeVisible();
		},
	);
	it.each(['en', 'fr'] as const)('keeps lines when only the stop source fails (%s)', (locale) => {
		state.hotspots = dayRanking;
		state.weeklyError = new Error('fixture failure');
		render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
		expect(
			within(screen.getByRole('region', { name: homePulseCopy[locale].worstLines })).getByRole(
				'link',
			),
		).toBeVisible();
		expect(
			within(screen.getByRole('region', { name: homePulseCopy[locale].worstStops })).getByRole(
				'status',
			),
		).toHaveTextContent(homePulseCopy[locale].worstError);
	});
	it.each(['en', 'fr'] as const)('withholds stale weekly lines in %s', (locale) => {
		state.hotspots = { ...dayRanking, generated_utc: '2026-11-04T00:00:00Z' };
		render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
		const lines = screen.getByRole('region', { name: homePulseCopy[locale].worstLines });
		expect(within(lines).queryByRole('link')).toBeNull();
		expect(within(lines).getByRole('status')).toHaveTextContent(
			homePulseCopy[locale].worstNotCurrent,
		);
	});
	it.each(['en', 'fr'] as const)('withholds absent weekly lines in %s', (locale) => {
		render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
		const lines = screen.getByRole('region', { name: homePulseCopy[locale].worstLines });
		expect(within(lines).queryByRole('link')).toBeNull();
		expect(within(lines).getByRole('status')).toHaveTextContent(
			homePulseCopy[locale].worstUnavailable,
		);
	});
	it.each(['en', 'fr'] as const)(
		'orders the five eligible lines by their shown late share (%s)',
		(locale) => {
			state.hotspots = {
				...dayRanking,
				by_grain: [
					{
						...dayRanking.by_grain[0],
						entries: [
							...Array.from({ length: 5 }, (_, i) => ({
								id: `thin${i}`,
								type: 'route',
								rank: i + 1,
								severe_pct: 100,
								observation_count: 29,
							})),
							...[
								['302', 54.2, 100],
								['646', 55.1, 100],
								['A', 50, 30],
								['B', 50, 60],
								['C', 50, 60],
								['last', 1, 100],
							].map(([id, severe_pct, observation_count], i) => ({
								id,
								type: 'route',
								rank: i + 6,
								severe_pct,
								observation_count,
							})),
						],
					},
				],
			};
			render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
			const links = within(
				screen.getByRole('region', { name: homePulseCopy[locale].worstLines }),
			).getAllByRole('link');
			expect(links.map((link) => link.getAttribute('href'))).toEqual(
				['646', '302', 'B', 'C', 'A'].map((id) => `${locale === 'fr' ? '/fr' : ''}/lines/${id}`),
			);
			const values = links.map((link) =>
				Number(
					link
						.querySelector('.pulse-rank-rate')!
						.textContent!.replace(/[^0-9.,]/g, '')
						.replace(',', '.'),
				),
			);
			expect(values).toEqual([55.1, 54.2, 50, 50, 50]);
			for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
		},
	);
	it('always offers the map and network health, even before data boots', () => {
		render(HomePulse, { props: { locale: 'en', city: 'Ottawa', manifest: null } });
		expect(screen.getByRole('heading', { name: 'Right now in Ottawa' })).toBeInTheDocument();
		const links = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
		expect(links).toEqual(['/map', '/network']);
		expect(createLiveStoreSpy).not.toHaveBeenCalled();
	});

	it('shows live counts with the denominator behind the late count', () => {
		state.network = liveNetwork;
		render(HomePulse, { props: { locale: 'en', city: 'Ottawa', manifest } });
		expect(createLiveStoreSpy).toHaveBeenCalledWith(manifest, { families: ['network'] });
		const late = screen.getByText('More than 5 min late').closest('div') as HTMLElement;
		expect(late).toHaveTextContent('42');
		expect(late).toHaveTextContent('of 260');
		expect(late).toHaveTextContent('buses with a delay reading');
		expect(screen.getByText('Buses in service').closest('div')).toHaveTextContent('355');
		expect(screen.getByText('Trips without a signal').closest('div')).toHaveTextContent('18');
		expect(screen.getByText('More than 1 min early').closest('div')).toHaveTextContent('71');
		expect(screen.getByText('On time').closest('div')).toHaveTextContent(
			'1 min early to 5 min late',
		);
	});

	it('has its final shape before any data arrives, so nothing below it moves', () => {
		state.healthState = 'never-loaded';
		state.hotspotsSettled = false;
		state.weeklySettled = false;
		render(HomePulse, { props: { locale: 'en', city: 'Ottawa', manifest } });
		expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual([
			'Buses in service',
			'On time',
			'More than 5 min late',
			'More than 1 min early',
			'Trips without a signal',
		]);
		expect(screen.getByRole('region', { name: 'Most delayed lines' })).toBeInTheDocument();
		expect(screen.getByRole('region', { name: 'Most delayed stops' })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /All hotspots/ })).toBeInTheDocument();
		expect(screen.queryByRole('status')).toBeNull();
		// The count the late figure is out of has its line before the number exists.
		const late = screen.getByText('More than 5 min late').closest('div') as HTMLElement;
		expect(late.querySelector('.pulse-of')?.textContent).toBe('');
	});

	it('explains a figure no reading stands behind instead of printing a number', () => {
		state.network = {
			...liveNetwork,
			on_time_pct: null,
			status_dist: { on_time: 0, late: 0, severe: 0, early: 0, unknown: 355 },
		};
		render(HomePulse, { props: { locale: 'en', city: 'Ottawa', manifest } });
		for (const label of ['On time', 'More than 5 min late', 'More than 1 min early']) {
			const tile = screen.getByText(label).closest('div') as HTMLElement;
			expect(
				within(tile).getByRole('button', { name: 'No data, not enough readings yet' }),
			).toBeInTheDocument();
			expect(tile).not.toHaveTextContent(/\d(?! min)/);
		}
		expect(screen.getByText('Buses in service').closest('div')).toHaveTextContent('355');
	});

	it.each([
		['en', 'On time', 'Not enough readings', '10 of 328'],
		['fr', 'À l’heure', 'Pas assez de relevés', '10 bus sur 328'],
	] as const)(
		'holds back an on-time share that too few buses stand behind (%s)',
		(locale, label, held, count) => {
			// Ottawa, as reported: 10 of 328 buses in service had a delay reading.
			state.network = {
				...liveNetwork,
				vehicles_in_service: 328,
				on_time_pct: 10,
				status_dist: { on_time: 1, late: 0, severe: 7, early: 2, unknown: 318 },
			};
			render(HomePulse, { props: { locale, city: 'Ottawa', manifest } });
			const tile = screen.getByText(label).closest('div') as HTMLElement;
			expect(tile).toHaveTextContent(held);
			expect(tile).toHaveTextContent(count);
			expect(tile).not.toHaveTextContent('%');
		},
	);

	it('says the live numbers are unavailable instead of showing zeros', () => {
		state.healthState = 'failed-no-data';
		render(HomePulse, { props: { locale: 'fr', city: 'Montréal', manifest } });
		expect(screen.getByText(/Chiffres en direct indisponibles/)).toHaveAttribute('role', 'status');
		for (const label of ['Bus en service', 'À l’heure', 'Plus de 5 min de retard'])
			expect(screen.getByText(label).closest('div')).not.toHaveTextContent(/\d(?! min)/);
	});

	it('tells a failed ranking load apart from a ranking that does not exist yet', () => {
		state.network = liveNetwork;
		render(HomePulse, { props: { locale: 'en', city: 'Ottawa', manifest } });
		const lines = screen.getByRole('region', { name: 'Most delayed lines' });
		expect(within(lines).getByRole('status')).toHaveTextContent(
			'No weekly ranking has been published yet.',
		);
	});

	it('names the worst lines by route number and links each ranking to its page', () => {
		state.network = liveNetwork;
		state.hotspots = dayRanking;
		state.weeklyIndex = weeklyStopIndex;
		render(HomePulse, {
			props: { locale: 'en', city: 'Ottawa', manifest },
			context: new Map([
				[
					Symbol.for('transit.line-directory'),
					() =>
						createLineDirectory([{ id: '7-354', short: '7', type: 3 }], {
							line: (id) => `Line ${id}`,
						}),
				],
			]),
		});
		const lines = screen.getByRole('region', { name: 'Most delayed lines' });
		const line = within(lines).getByRole('link');
		expect(line).toHaveAttribute('href', '/lines/7-354');
		expect(within(line).getByTitle('7 · Carleton <> St-Laurent')).toHaveTextContent(
			'7 · Carleton <> St-Laurent',
		);
		expect(line).not.toHaveAttribute('aria-label');
		expect(line).toHaveAccessibleName(
			expect.stringContaining('24% of readings more than 5 min late'),
		);
		expect(within(line).getByText('7 · Carleton <> St-Laurent')).toBeInTheDocument();
		expect(line).toHaveTextContent('Carleton <> St-Laurent');
		expect(line).toHaveTextContent('24% of readings more than 5 min late');
		const stops = screen.getByRole('region', { name: 'Most delayed stops' });
		expect(within(stops).getByRole('link')).toHaveAttribute('href', '/stop/S9');
		expect(within(stops).getByRole('link')).toHaveTextContent('Rideau / Sussex');
		expect(screen.getByRole('link', { name: /All hotspots/ })).toHaveAttribute('href', '/hotspots');
		expect(screen.getByText(/republished weekly/)).toBeInTheDocument();
		expect(within(lines).getByText(/^Data through/)).toHaveTextContent('10');
		expect(within(stops).getByText(/^Data through/)).toHaveTextContent('10');
	});
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
