import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import HomePulse from './HomePulse.svelte';
import { homePulseCopy } from './homePulse.copy';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';

const { state, createLiveStoreSpy, refreshSpy } = vi.hoisted(() => ({
	state: {
		network: null as Record<string, unknown> | null,
		healthState: 'live' as string,
		refreshFails: false,
		hotspots: null as Record<string, unknown> | null,
		hotspotsSettled: true,
		hotspotsError: null as Error | null,
		weeklyIndex: null as Record<string, unknown> | null,
		weeklySettled: true,
		weeklyError: null as Error | null,
		trend: null as Record<string, unknown> | null,
		trendSettled: true,
		trendError: null as Error | null,
		history: null as Record<string, unknown> | null,
		historySettled: true,
	},
	createLiveStoreSpy: vi.fn(),
	refreshSpy: vi.fn(),
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
			refresh: async (options: unknown) => {
				refreshSpy(options);
				if (state.refreshFails) throw new Error('fixture refresh failure');
			},
		};
	},
}));
vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: (_loader: unknown, options?: { key?: () => unknown }) => {
		const key = options?.key?.();
		const pick = <T>(values: Record<string, T>, fallback: T): T =>
			typeof key === 'string' && key in values ? values[key] : fallback;
		return {
			get data() {
				return pick<unknown>(
					{
						'home-hotspots': state.hotspots,
						'home-weekly-ranking': state.weeklyIndex,
						'home-network-trend': state.trend,
						'home-history-index': state.history,
					},
					{ routes: [{ id: '7-354', short: '7' }] },
				);
			},
			get error() {
				return pick<Error | null>(
					{
						'home-hotspots': state.hotspotsError,
						'home-weekly-ranking': state.weeklyError,
						'home-network-trend': state.trendError,
					},
					null,
				);
			},
			loading: false,
			get settled() {
				return pick(
					{
						'home-hotspots': state.hotspotsSettled,
						'home-weekly-ranking': state.weeklySettled,
						'home-network-trend': state.trendSettled,
						'home-history-index': state.historySettled,
					},
					true,
				);
			},
		};
	},
}));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getHotspots: vi.fn(),
	getPublishedReliabilityIndex: vi.fn(),
	getNetworkTrend: vi.fn(),
	getHistoricAvailability: vi.fn(),
}));
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

// Ottawa's published files of 2026-11-11: collection began October 2, closed through November 10.
const ottawaTrend = {
	generated_utc: '2026-11-11T00:00:00Z',
	weekly: [
		{ date: '2026-10-26', otp_pct: 76, observation_count: 6_741_817 },
		{ date: '2026-11-02', otp_pct: 75, observation_count: 6_910_589 },
		{ date: '2026-11-09', otp_pct: 79, observation_count: 2_476_953 },
	],
};
const ottawaHistory = {
	families: [
		{
			family: 'network',
			selection_mode: 'range',
			index_path: 'historic/history/network/index.json',
			first_available_date: '2026-10-02',
			last_available_date: '2026-11-10',
			gaps: [],
		},
	],
};

afterEach(() => {
	state.network = null;
	state.healthState = 'live';
	state.refreshFails = false;
	state.hotspots = null;
	state.hotspotsSettled = true;
	state.hotspotsError = null;
	state.weeklyIndex = null;
	state.weeklySettled = true;
	state.weeklyError = null;
	state.trend = null;
	state.trendSettled = true;
	state.trendError = null;
	state.history = null;
	state.historySettled = true;
	createLiveStoreSpy.mockClear();
	refreshSpy.mockClear();
});

/** Visible text with every kind of space as one plain space (fr-CA groups with no-break spaces). */
const text = (element: HTMLElement) => element.textContent!.replace(/\s+/g, ' ').trim();
const card = (name: string) => screen.getByRole('region', { name });
/** The ranking fixtures' week, as each list states it. */
const week410 = {
	en: 'November 4 to 10, 7 complete days',
	fr: 'Du 4 au 10 novembre, 7 jours complets',
} as const;

describe('Home record, live and ranking cards', () => {
	it.each(['en', 'fr'] as const)('keeps fresh stops when hotspots are missing (%s)', (locale) => {
		state.weeklyIndex = weeklyStopIndex;
		render(HomePulse, { props: { locale, manifest } });
		const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
		expect(within(stops).getByRole('link', { name: /Rideau/ })).toBeVisible();
		expect(stops).toHaveTextContent(week410[locale]);
	});
	it.each(['en', 'fr'] as const)(
		'keeps a fresh line when only the stop source is stale (%s)',
		(locale) => {
			state.hotspots = dayRanking;
			state.weeklyIndex = { ...weeklyStopIndex, generated_utc: '2026-11-04T00:00:00Z' };
			render(HomePulse, { props: { locale, manifest } });
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
			render(HomePulse, { props: { locale: 'en', manifest } });
			for (const name of ['Lines', 'Stops'])
				expect(within(screen.getByRole('region', { name })).getByRole('link')).toBeVisible();
		},
	);
	it.each(['en', 'fr'] as const)('labels independent line and stop windows in %s', (locale) => {
		state.hotspots = {
			...dayRanking,
			by_grain: [{ ...dayRanking.by_grain[0], date: '2026-10-28', window_end: '2026-11-03' }],
		};
		state.weeklyIndex = weeklyStopIndex;
		render(HomePulse, { props: { locale, manifest } });
		const lines = screen.getByRole('region', { name: homePulseCopy[locale].worstLines });
		const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
		expect(lines).toHaveTextContent(
			locale === 'fr'
				? 'Du 28 octobre au 3 novembre, 7 jours complets'
				: 'October 28 to November 3, 7 complete days',
		);
		expect(stops).toHaveTextContent(week410[locale]);
		expect(lines).not.toHaveTextContent(locale === 'fr' ? '10 novembre' : 'to 10');
		expect(stops).not.toHaveTextContent(locale === 'fr' ? 'octobre' : 'October');
	});
	it.each(['en', 'fr'] as const)('keeps fresh stops when hotspots are stale (%s)', (locale) => {
		state.weeklyIndex = weeklyStopIndex;
		state.hotspots = { ...dayRanking, generated_utc: '2026-11-04T00:00:00Z' };
		render(HomePulse, { props: { locale, manifest } });
		const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
		expect(within(stops).getByRole('link', { name: /Rideau/ })).toBeVisible();
		expect(stops).toHaveTextContent(week410[locale]);
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
			render(HomePulse, { props: { locale, manifest } });
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
		render(HomePulse, { props: { locale, manifest } });
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
		render(HomePulse, { props: { locale, manifest } });
		const lines = screen.getByRole('region', { name: homePulseCopy[locale].worstLines });
		expect(within(lines).queryByRole('link')).toBeNull();
		expect(within(lines).getByRole('status')).toHaveTextContent(
			homePulseCopy[locale].worstNotCurrent,
		);
	});
	it.each(['en', 'fr'] as const)('withholds absent weekly lines in %s', (locale) => {
		render(HomePulse, { props: { locale, manifest } });
		const lines = screen.getByRole('region', { name: homePulseCopy[locale].worstLines });
		expect(within(lines).queryByRole('link')).toBeNull();
		expect(within(lines).getByRole('status')).toHaveTextContent(
			homePulseCopy[locale].worstUnavailable,
		);
	});
	it.each(['en', 'fr'] as const)(
		'shows the three eligible lines with the highest shown late share, in that order (%s)',
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
			render(HomePulse, { props: { locale, manifest } });
			const links = within(
				screen.getByRole('region', { name: homePulseCopy[locale].worstLines }),
			).getAllByRole('link');
			expect(links.map((link) => link.getAttribute('href'))).toEqual(
				['646', '302', 'B'].map((id) => `${locale === 'fr' ? '/fr' : ''}/lines/${id}`),
			);
			const values = links.map((link) =>
				Number(
					link
						.querySelector('.rank-value')!
						.textContent!.replace(/[^0-9.,]/g, '')
						.replace(',', '.'),
				),
			);
			expect(values).toEqual([55.1, 54.2, 50]);
			expect(links.map((link) => text(link.querySelector('.rank-readings')!))).toEqual(
				locale === 'fr'
					? ['100 relevés', '100 relevés', '60 relevés']
					: ['100 readings', '100 readings', '60 readings'],
			);
			for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
		},
	);
	it.each([
		[
			'en',
			['Main / Mill', 'Manotick Main / Currier', 'Longfields / Kilspindie'],
			['93.8%', '85.1%', '83%'],
			['64 readings', '47 readings', '53 readings'],
		],
		[
			'fr',
			['Main / Mill', 'Manotick Main / Currier', 'Longfields / Kilspindie'],
			['93,8 %', '85,1 %', '83 %'],
			['64 relevés', '47 relevés', '53 relevés'],
		],
	] as const)(
		'orders the stops by the late share they show, not the published rank (%s)',
		(locale, names, values, readings) => {
			// Ottawa's week of November 4 to 10 (M1 capture); the publisher ranks whole on-time percents.
			const ranked = (id: string, name: string, rank: number, late: number, all: number) => ({
				id,
				name,
				state: 'ranked',
				rank,
				numerator: all - late,
				denominator: all,
				pct: Math.round((100 * (all - late)) / all),
				severe_pct: Math.round((1000 * late) / all) / 10,
				window_start: '2026-11-04',
				window_end: '2026-11-10',
			});
			state.weeklyIndex = {
				generated_utc: '2026-11-11T00:00:00Z',
				weekly_stops: [
					ranked('S2', 'MANOTICK MAIN / CURRIER', 1, 40, 47),
					ranked('S1', 'Main / Mill', 2, 60, 64),
					ranked('S3', 'Longfields / Kilspindie', 3, 44, 53),
					ranked('S4', 'Bank / Somerset', 4, 20, 40),
				],
			};
			render(HomePulse, { props: { locale, manifest } });
			const stops = screen.getByRole('region', { name: homePulseCopy[locale].worstStops });
			const rows = within(stops).getAllByRole('listitem');
			expect(rows.map((row) => text(row.querySelector('.rank-name')!))).toEqual(names);
			expect(rows.map((row) => text(row.querySelector('.rank-value')!))).toEqual(values);
			expect(rows.map((row) => text(row.querySelector('.rank-readings')!))).toEqual(readings);
			expect(stops).toHaveTextContent(week410[locale]);
		},
	);
	it.each([
		[
			'en',
			[
				'Latest complete record',
				'November 2 to 8, latest complete week',
				'75% of readings were on time.',
				'On time: 1 minute early to 5 minutes late.',
				'Based on 6,910,589 readings. These are not trips or passengers.',
				'76% the week before, October 26 to November 1.',
				'Record · data through Nov 10 · published Nov 11',
			],
			'Open the network record',
			'/network',
		],
		[
			'fr',
			[
				'Dernier bilan complet',
				'Du 2 au 8 novembre, dernière semaine complète',
				'75 % des relevés étaient à l’heure.',
				'À l’heure : d’une minute d’avance à 5 minutes de retard.',
				'Selon 6 910 589 relevés. Ce ne sont ni des trajets ni des passagers.',
				'76 % la semaine précédente, du 26 octobre au 1er novembre.',
				'Bilan · données jusqu’au 10 nov. · publié le 11 nov.',
			],
			'Ouvrir le bilan du réseau',
			'/fr/network',
		],
	] as const)(
		'states the latest complete week with its own dates, readings and stamp (%s)',
		(locale, lines, action, href) => {
			state.trend = ottawaTrend;
			state.history = ottawaHistory;
			render(HomePulse, { props: { locale, manifest } });
			const record = card(lines[0]);
			for (const line of lines) expect(text(record)).toContain(line);
			// The open week (79%, November 9 on) is not the record.
			expect(text(record)).not.toMatch(/79|9 to 15|9 au 15/);
			expect(within(record).getByRole('link', { name: action })).toHaveAttribute('href', href);
		},
	);

	it.each([
		[
			'too few readings',
			{ observation_count: 12 },
			'Not enough readings to state a share: 12 this week.',
		],
		['no published share', { otp_pct: null }, 'No on-time share is published for this week.'],
	])('keeps the week but holds back a share with %s', (_case, change, sentence) => {
		state.trend = { ...ottawaTrend, weekly: [{ ...ottawaTrend.weekly[1], ...change }] };
		state.history = ottawaHistory;
		render(HomePulse, { props: { locale: 'en', manifest } });
		const record = card('Latest complete record');
		expect(text(record)).toContain('November 2 to 8, latest complete week');
		expect(within(record).getByRole('status')).toHaveTextContent(sentence);
		expect(text(record)).not.toContain('%');
		expect(text(record)).not.toContain('Based on');
	});

	it.each([
		['en', 'Latest complete record', 'Not enough readings to state a share: 0 this week.'],
		[
			'fr',
			'Dernier bilan complet',
			'Pas assez de relevés pour établir une part : 0 cette semaine.',
		],
	] as const)('shows a negative-zero reading count as 0 (%s)', (locale, title, sentence) => {
		state.trend = { ...ottawaTrend, weekly: [{ ...ottawaTrend.weekly[1], observation_count: -0 }] };
		state.history = ottawaHistory;
		render(HomePulse, { props: { locale, manifest } });
		const record = card(title);
		expect(text(within(record).getByRole('status'))).toBe(sentence);
		expect(text(record)).not.toContain('-0');
	});

	it('tells a record that cannot load apart from one that has no complete week', () => {
		state.trendError = new Error('fixture failure');
		state.history = ottawaHistory;
		const failed = render(HomePulse, { props: { locale: 'en', manifest } });
		expect(within(card('Latest complete record')).getByRole('status')).toHaveTextContent(
			'The record could not be loaded.',
		);
		failed.unmount();
		state.trendError = null;
		state.trend = { ...ottawaTrend, weekly: [ottawaTrend.weekly[2]] };
		render(HomePulse, { props: { locale: 'en', manifest } });
		const record = card('Latest complete record');
		expect(within(record).getByRole('status')).toHaveTextContent(
			'No complete week is published yet.',
		);
		expect(text(record)).not.toMatch(/\d+ ?%/);
	});

	it.each([
		[
			'en',
			'Live now',
			['355 vehicles reporting', '18 silent trips', 'Scheduled now, but no vehicle is reporting.'],
		],
		[
			'fr',
			'En direct',
			[
				'355 véhicules se signalent',
				'18 trajets silencieux',
				'Prévus en ce moment, mais aucun véhicule ne se signale.',
			],
		],
	] as const)('shows what is live now as counts, never a share (%s)', (locale, title, lines) => {
		state.network = liveNetwork;
		render(HomePulse, { props: { locale, manifest } });
		expect(createLiveStoreSpy).toHaveBeenCalledWith(manifest, { families: ['network'] });
		const live = card(title);
		for (const line of lines) expect(text(live)).toContain(line);
		// The file publishes a 57% live share; the card does not show it, or any percentage.
		expect(text(live)).not.toContain('%');
		expect(within(live).getByRole('link', { name: homePulseCopy[locale].openMap })).toHaveAttribute(
			'href',
			locale === 'fr' ? '/fr/map' : '/map',
		);
	});

	it.each([
		['en', '1 vehicle reporting', '1 silent trip'],
		['fr', '1 véhicule se signale', '1 trajet silencieux'],
	] as const)('names one vehicle and one trip in the singular (%s)', (locale, vehicles, trips) => {
		state.network = { ...liveNetwork, vehicles_in_service: 1, non_responding: 1 };
		render(HomePulse, { props: { locale, manifest } });
		const live = card(locale === 'fr' ? 'En direct' : 'Live now');
		expect(text(live)).toContain(vehicles);
		expect(text(live)).toContain(trips);
	});

	it('says the live numbers are unavailable instead of showing zeros', () => {
		state.healthState = 'failed-no-data';
		render(HomePulse, { props: { locale: 'fr', manifest } });
		const live = card('En direct');
		expect(within(live).getByText('Chiffres en direct indisponibles')).toHaveAttribute(
			'role',
			'status',
		);
		expect(text(live)).not.toMatch(/\d/);
	});

	it.each([
		[false, 'Live data updated at 7:00 a.m.'],
		[true, 'Could not refresh. Showing data from 6:50 p.m.'],
	])(
		'refreshes the live numbers on request and says what happened (fails: %s)',
		async (fails, said) => {
			state.network = liveNetwork;
			state.refreshFails = fails;
			render(HomePulse, { props: { locale: 'en', manifest } });
			const live = card('Live now');
			await fireEvent.click(within(live).getByRole('button', { name: 'Refresh' }));
			expect(refreshSpy).toHaveBeenCalledWith({ force: true });
			await vi.waitFor(() =>
				expect(within(live).getByText(said)).toHaveAttribute('aria-live', 'polite'),
			);
		},
	);

	it('has its final shape before any data arrives, and offers the record and the map', () => {
		state.healthState = 'never-loaded';
		state.trendSettled = false;
		state.historySettled = false;
		state.hotspotsSettled = false;
		state.weeklySettled = false;
		render(HomePulse, { props: { locale: 'en', manifest } });
		for (const name of ['Latest complete record', 'Live now', 'Lines and stops to investigate'])
			expect(screen.getByRole('heading', { level: 2, name })).toBeInTheDocument();
		expect(text(card('Live now'))).toContain('vehicles reporting');
		expect(text(card('Live now'))).toContain('silent trips');
		expect(screen.getByRole('region', { name: 'Lines' })).toBeInTheDocument();
		expect(screen.getByRole('region', { name: 'Stops' })).toBeInTheDocument();
		expect(screen.queryByRole('status')).toBeNull();
		expect(text(card('Latest complete record'))).not.toMatch(/\d/);
	});

	it('offers the record and the live map, even before the data boots', () => {
		render(HomePulse, { props: { locale: 'en', manifest: null } });
		expect(
			[card('Latest complete record'), card('Live now')].map((region) =>
				within(region).getByRole('link').getAttribute('href'),
			),
		).toEqual(['/network', '/map']);
		expect(createLiveStoreSpy).not.toHaveBeenCalled();
	});

	it('tells a failed ranking load apart from a ranking that does not exist yet', () => {
		state.network = liveNetwork;
		render(HomePulse, { props: { locale: 'en', manifest } });
		const lines = screen.getByRole('region', { name: 'Lines' });
		expect(within(lines).getByRole('status')).toHaveTextContent(
			'No weekly ranking has been published yet.',
		);
	});

	it('names the worst lines by route number and links each ranking to its page', () => {
		state.network = liveNetwork;
		state.hotspots = dayRanking;
		state.weeklyIndex = weeklyStopIndex;
		render(HomePulse, {
			props: { locale: 'en', manifest },
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
		const lines = screen.getByRole('region', { name: 'Lines' });
		const line = within(lines).getByRole('link');
		expect(line).toHaveAttribute('href', '/lines/7-354');
		expect(line.querySelector('.rank-plate')).toHaveTextContent('7');
		expect(line.querySelector('.rank-name')).toHaveTextContent('Carleton <> St-Laurent');
		expect(line).not.toHaveAttribute('aria-label');
		expect(line).toHaveAccessibleName(
			'Line 7 · Carleton <> St-Laurent, 24% of readings more than 5 minutes late, 100 readings',
		);
		const stops = screen.getByRole('region', { name: 'Stops' });
		expect(within(stops).getByRole('link')).toHaveAttribute('href', '/stop/S9');
		expect(within(stops).getByRole('link')).toHaveAccessibleName(
			'Rideau / Sussex, 21.5% of readings more than 5 minutes late, 200 readings',
		);
		const rankings = card('Lines and stops to investigate');
		expect(rankings).toHaveTextContent('Share of readings more than 5 minutes late.');
		expect(rankings).toHaveTextContent('Ordered by the share shown, highest first.');
		expect(within(rankings).getByRole('link', { name: 'Open the full rankings' })).toHaveAttribute(
			'href',
			'/hotspots',
		);
		expect(lines).toHaveTextContent(week410.en);
		expect(stops).toHaveTextContent(week410.en);
	});
});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
