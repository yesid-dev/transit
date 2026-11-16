import { fireEvent, render as renderComponent, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { routeNameFallback } from '#lib/site/absence.ts';
import { getRoute } from '#lib/v1/repositories/static.ts';
import type { TripsFile } from '#lib/v1/index.ts';
import { RouteFileSchema } from '#lib/v1/schemas/index.ts';
import TripDetail from './TripDetail.svelte';
import { tripCopy } from './trips.copy';
async function render(...args: Parameters<typeof renderComponent<typeof TripDetail>>) {
	const view = renderComponent(...args);
	if (tripsData) await screen.findByRole('heading', { level: 1 });
	return view;
}
const TRIPS_FILE = {
	generated_utc: '2026-06-15T12:00:00Z',
	trips: {
		t161: {
			status: 'late',
			route: '161',
			delay_min: 4,
			stops: [
				{ stop: 'sA', eta_utc: '2026-06-15T12:05:00Z', delay_min: 4 },
				{ stop: 'sB', eta_utc: '2026-06-15T12:12:00Z', delay_min: null },
			],
		},
		tEmpty: {
			status: 'on_time',
			route: '24',
			delay_min: 0,
			stops: [],
		},
		tBlank: {
			status: 'unknown',
			route: null,
			delay_min: null,
			stops: [],
		},
	},
} as unknown as TripsFile;
let tripsData: TripsFile | null = TRIPS_FILE;
let stopNames: { id: string; name: string }[] = [];
let reportStale = false;
let reportNotice: 'stale' | 'refresh-unavailable' | null = null;
vi.mock('#lib/v1/live/store.svelte.ts', () => ({
	LIVE_FAMILIES: ['vehicles', 'trips', 'departures', 'alerts', 'network'],
	createLiveStore: () => ({
		get trips() {
			return tripsData;
		},
		get generatedUtc() {
			return tripsData?.generated_utc ?? null;
		},
		ageSeconds: 300,
		get isStale() {
			return reportStale;
		},
		get familyStates() {
			return {
				trips: {
					active: true,
					retainedGeneration: tripsData?.generated_utc ?? null,
					phase: 'ready',
					health: {
						state:
							reportNotice === 'refresh-unavailable'
								? 'retrying'
								: reportNotice
									? 'retained-stale'
									: 'live',
						ageSeconds: 300,
						isStale: reportStale,
						retained: true,
						notice: reportNotice,
					},
				},
			};
		},
		error: null,
		loading: false,
		start: vi.fn(),
		stop: vi.fn(),
		refresh: vi.fn(),
	}),
}));
vi.mock('#lib/v1/repositories/static.ts', () => ({ getStopsIndex: vi.fn(), getRoute: vi.fn() }));
const tripManifest = vi.hoisted(() => ({
	provider: 'stm',
	tz: 'America/Vancouver',
	short_name: 'STM',
	display_name: 'STM',
	dataset_version: 'test',
}));
vi.mock('#lib/v1/boot.ts', () => ({
	getV1Context: () => ({
		manifest: tripManifest,
	}),
}));
vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: () => ({
		get data() {
			return { stops: stopNames };
		},
		error: null,
		loading: false,
		settled: true,
		reload: vi.fn(),
	}),
}));
const clockStub = vi.hoisted(() => ({
	get now() {
		return Date.parse('2026-06-15T12:05:00Z');
	},
	get serverNow() {
		return Date.parse('2026-06-15T12:05:00Z');
	},
	subscribe: () => () => {},
}));
vi.mock('@yesid/ui/state', async (importOriginal) => ({
	...(await importOriginal<typeof import('@yesid/ui/state')>()),
	clock: clockStub,
}));

beforeEach(() => {
	tripsData = TRIPS_FILE;
	tripManifest.provider = 'stm';
	tripManifest.tz = 'America/Vancouver';
	vi.mocked(getRoute).mockResolvedValue(null);
	stopNames = [];
	reportStale = false;
	reportNotice = null;
});

describe.each(['en', 'fr'] as const)('trip report opening in %s', (locale) => {
	it('shows no direction when more than one published variant matches', async () => {
		const variant = {
			dir: 0,
			headsign: 'Ambiguous terminal',
			stops: [
				{ id: 'sA', seq: 1 },
				{ id: 'sB', seq: 2 },
			],
		};
		vi.mocked(getRoute).mockResolvedValue(
			RouteFileSchema.parse({
				id: '161',
				generated_utc: TRIPS_FILE.generated_utc,
				directions: [variant, { ...variant, dir: 1 }],
			}),
		);
		await render(TripDetail, {
			props: { id: 't161' },
			context: new Map([[Symbol.for('@yesid/ui/locale'), () => locale]]),
		});
		await Promise.resolve();
		await tick();
		expect(document.querySelector('.trip-direction')).toBeNull();
		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
			tripCopy[locale].reportTitle,
		);
	});

	it('labels an all-predictions export while six rows show, and explains the changing live link', async () => {
		const stops = Array.from({ length: 8 }, (_, i) => ({
			...TRIPS_FILE.trips.t161.stops![0],
			stop: `all-${i}`,
		}));
		tripsData = { ...TRIPS_FILE, trips: { bulk: { ...TRIPS_FILE.trips.t161, stops } } };
		await render(TripDetail, {
			props: { id: 'bulk' },
			context: new Map([[Symbol.for('@yesid/ui/locale'), () => locale]]),
		});
		expect(screen.getAllByRole('rowheader')).toHaveLength(6);
		const download = screen.getByRole('link', {
			name:
				locale === 'en'
					? 'Download all predictions (CSV)'
					: 'Télécharger toutes les prévisions (CSV)',
		});
		expect(download.getAttribute('download')).toMatch(/-all-predictions\.csv$/);
		expect(decodeURIComponent(download.getAttribute('href')!).split('\r\n')).toHaveLength(9);
		expect(
			screen.getByText(
				locale === 'en'
					? 'This view changes as new reports arrive.'
					: 'Cette vue change à mesure que de nouveaux rapports arrivent.',
			),
		).toBeInTheDocument();
	});
	it('dates the loaded report and each prediction in the published network zone', async () => {
		const { container } = await render(TripDetail, {
			props: { id: 't161' },
			context: new Map([[Symbol.for('@yesid/ui/locale'), () => locale]]),
		});
		const time = container.querySelector('[data-slot="trip-report-time"] p time')!;
		expect(time).toHaveAttribute('datetime', '2026-06-15T12:00:00Z');
		expect(time).toHaveTextContent(locale === 'en' ? '5:00:00' : '5 h 00');
		expect(time).toHaveTextContent(locale === 'en' ? 'PDT' : 'HAP');
		expect(container.querySelector('.trip-stop-eta')).toHaveTextContent(
			locale === 'en' ? '5:05 a.m.' : '5 h 05',
		);
	});
	it('copies an explicit provider and locale on the latest trip link, with a selectable fallback', async () => {
		tripManifest.provider = 'octranspo';
		const writeText = vi.fn(async () => {
			throw new Error('clipboard unavailable');
		});
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		try {
			await render(TripDetail, {
				props: { id: 't161' },
				context: new Map([[Symbol.for('@yesid/ui/locale'), () => locale]]),
			});
			await fireEvent.click(
				screen.getByRole('button', {
					name: locale === 'en' ? 'Copy live link' : 'Copier le lien en direct',
				}),
			);
			const text = screen.getByRole('textbox');
			expect(text).toHaveValue(
				`https://transit.yesid.dev${locale === 'fr' ? '/fr' : ''}/trip/t161?provider=octranspo`,
			);
			expect(text).toHaveFocus();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('shows a known report while optional line lookup is pending, with its caveat before rows', () => {
		vi.mocked(getRoute).mockReturnValue(new Promise(() => {}));
		const { container } = renderComponent(TripDetail, {
			props: { id: 't161' },
			context: new Map([[Symbol.for('@yesid/ui/locale'), () => locale]]),
		});
		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
			locale === 'en' ? 'Trip prediction report' : 'Rapport de prévisions du trajet',
		);
		expect(container).toHaveTextContent(
			locale === 'en'
				? 'These are predictions, not observed arrivals.'
				: 'Ce sont des prévisions, pas des arrivées observées.',
		);
		expect(screen.getByRole('table')).toBeInTheDocument();
		expect(container.querySelector('.trip-verdict')).toHaveTextContent('4 min');
	});
});

describe.each(['en', 'fr'] as const)('TripDetail summary in %s', (locale) => {
	const context = new Map([[Symbol.for('@yesid/ui/locale'), () => locale]]);
	it('shows the trip identifier once when no line is reported', async () => {
		const { container } = await render(TripDetail, { props: { id: 'tBlank' }, context });
		expect(
			screen.getByRole('heading', { level: 1, name: tripCopy[locale].reportTitle }),
		).toBeInTheDocument();
		const visible = container.cloneNode(true) as HTMLElement;
		visible.querySelectorAll('.sr-only,[aria-hidden="true"]').forEach((node) => node.remove());
		expect(visible.textContent?.match(/tBlank/g)).toHaveLength(1);
	});
	it('keeps a prediction caveat without inventing its source', async () => {
		const { container } = await render(TripDetail, { props: { id: 't161' }, context });
		expect(container.querySelector('.trip-prediction-caveat')).toHaveTextContent(
			locale === 'fr'
				? 'Les prédictions couvrent jusqu’à une heure au moment de la préparation du rapport. Elles peuvent changer.'
				: 'Predictions cover up to one hour when the report is prepared. They may change.',
		);
	});
	it('states on time once when the reported delay is exactly zero', async () => {
		const { container } = await render(TripDetail, { props: { id: 'tEmpty' }, context });
		const verdict = container.querySelector('.trip-verdict')!;
		expect(
			within(verdict as HTMLElement).getAllByText(tripCopy[locale].status.on_time),
		).toHaveLength(1);
		expect(verdict.querySelector('.trip-verdict-delay')).toHaveTextContent('0 min');
		expect(container.textContent).not.toMatch(/\/v1|never invented|jamais inventé/);
	});

	it.each([
		['on_time', 1, '+1 min'],
		['late', 0, '0 min'],
		['early', -2, '−2 min'],
		['severe', 4, '+4 min'],
		['unknown', 0, '0 min'],
		['on_time', null, null],
		['unknown', null, null],
		['late', -0, '0 min'],
		['late', Number.NaN, null],
		['late', Infinity, null],
	] as const)(
		'uses published %s with neutral measurement %s',
		async (status, delay, measurement) => {
			tripsData = {
				...TRIPS_FILE,
				trips: { probe: { status, delay_min: delay, route: '24', stops: [] } },
			} as TripsFile;
			const { container } = await render(TripDetail, { props: { id: 'probe' }, context });
			const verdict = container.querySelector('.trip-verdict') as HTMLElement;
			const badge = verdict.querySelector('[data-slot="status-badge"]')!;
			if (status === 'unknown' && delay == null) {
				expect(
					verdict.textContent?.match(new RegExp(tripCopy[locale].status.unknown, 'g')),
				).toHaveLength(1);
				const probe = document.createElement('button');
				probe.innerHTML = verdict.innerHTML;
				document.body.append(probe);
				try {
					expect(probe).toHaveAccessibleName(
						locale === 'en'
							? 'Unknown, not reported in the live feed'
							: 'Inconnu, non signalé dans le flux en direct',
					);
				} finally {
					probe.remove();
				}
			}

			expect(badge).toHaveAttribute('data-status', status);
			if (status === 'unknown' && delay == null) {
				expect(badge).toHaveAttribute('aria-hidden', 'true');
				expect(badge).toHaveTextContent('○');
				expect(badge?.getAttribute('style')).toContain('--dataviz-status-unknown');
			} else expect(badge).toHaveTextContent(tripCopy[locale].status[status]);
			expect(badge.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
			const reading = verdict.querySelector('.trip-verdict-delay')!;
			expect(reading).not.toHaveAttribute('data-tone');
			if (measurement) expect(reading).toHaveTextContent(measurement);
			else expect(reading.querySelector('[data-slot="absent-value"]')).toBeInTheDocument();
			expect(reading.textContent).not.toMatch(/late|early|On time|retard|avance|heure/);
		},
	);
});

describe('trip report predictions and identity', () => {
	it('bounds eight reported rows, preserves their order, and resets Show all on a trip change', async () => {
		const stops = Array.from({ length: 8 }, (_, i) => ({
			...TRIPS_FILE.trips.t161.stops![0],
			stop: `p${i}`,
		}));
		tripsData = {
			...TRIPS_FILE,
			trips: {
				a: { ...TRIPS_FILE.trips.t161, stops },
				b: {
					...TRIPS_FILE.trips.t161,
					stops: stops.map((stop) => ({ ...stop, stop: 'b' + stop.stop })),
				},
			},
		};
		const view = await render(TripDetail, { props: { id: 'a' } });
		expect(screen.getByText('8 predictions reported')).toBeInTheDocument();
		expect(screen.getAllByRole('rowheader')).toHaveLength(6);
		const button = screen.getByRole('button', { name: 'Show all 8 predictions' });
		await fireEvent.click(button);
		expect(button).toHaveAttribute('aria-expanded', 'true');
		expect(
			screen.getAllByRole('rowheader').map((row) => row.querySelector('a')?.getAttribute('href')),
		).toEqual(Array.from({ length: 8 }, (_, i) => `/stop/p${i}?provider=stm`));
		await view.rerender({ id: 'b' });
		expect(screen.getAllByRole('rowheader')).toHaveLength(6);
		expect(screen.getAllByRole('rowheader')[0]).toHaveTextContent('bp0');
		expect(screen.getByRole('button', { name: 'Show all 8 predictions' })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
	});
	it('ignores late optional lookup results from the previous trip identity', async () => {
		let oldFinish!: (value: Awaited<ReturnType<typeof getRoute>>) => void;
		vi.mocked(getRoute).mockImplementation((id) =>
			id === 'old'
				? new Promise((resolve) => {
						oldFinish = resolve;
					})
				: Promise.resolve(
						RouteFileSchema.parse({
							id: 'new',
							generated_utc: TRIPS_FILE.generated_utc,
							long: 'New public line',
							directions: [],
						}),
					),
		);
		tripsData = {
			...TRIPS_FILE,
			trips: {
				a: { ...TRIPS_FILE.trips.t161, route: 'old' },
				b: { ...TRIPS_FILE.trips.t161, route: 'new' },
			},
		};
		const view = await render(TripDetail, { props: { id: 'a' } });
		const header = screen.getByRole('heading', { level: 1 });
		await view.rerender({ id: 'b' });
		await screen.findAllByText('Line New public line');
		oldFinish(
			RouteFileSchema.parse({
				id: 'old',
				generated_utc: TRIPS_FILE.generated_utc,
				long: 'Wrong old identity',
				directions: [],
			}),
		);
		await Promise.resolve();
		await tick();
		expect(screen.queryByText(/Wrong old identity/)).toBeNull();
		expect(screen.getByRole('heading', { level: 1 })).toBe(header);
		for (const link of screen.getAllByRole('link', { name: 'See the line record' }))
			expect(link).toHaveAttribute('href', '/lines/new?provider=stm');
	});
	it('does not average prediction offsets into the reported delay', async () => {
		tripsData = {
			...TRIPS_FILE,
			trips: {
				t161: {
					...TRIPS_FILE.trips.t161,
					stops: TRIPS_FILE.trips.t161.stops!.map((stop) => ({ ...stop, delay_min: 100 })),
				},
			},
		};
		await render(TripDetail, { props: { id: 't161' } });
		expect(document.querySelector('.trip-verdict-delay')).toHaveTextContent('+4 min');
		expect(screen.getAllByRole('row')[1]).toHaveTextContent('+100 min');
	});
});

describe('TripDetail: a broadcasting trip', () => {
	it('renders the trip heading, route link, status and current delay', async () => {
		await render(TripDetail, { props: { id: 't161' } });

		expect(
			screen.getByRole('heading', { level: 1, name: 'Trip prediction report' }),
		).toBeInTheDocument();
		for (const link of screen.getAllByRole('link', { name: 'See the line record' }))
			expect(link).toHaveAttribute('href', '/lines/161?provider=stm');
		expect(screen.getByText('Late')).toBeInTheDocument();
		expect(document.querySelector('.trip-verdict-delay')).toHaveTextContent('+4 min');
	});

	it('shows the trip identifier once without breadcrumbs', async () => {
		const { container } = await render(TripDetail, { props: { id: 't161' } });
		expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument();
		const visible = container.cloneNode(true) as HTMLElement;
		visible.querySelectorAll('.sr-only,[aria-hidden="true"]').forEach((node) => node.remove());
		expect(visible.textContent?.match(/t161/g)).toHaveLength(1);
	});

	it('anchors the FreshnessStamp age to the SERVER clock (serverNow), not Date.now()', async () => {
		await render(TripDetail, { props: { id: 't161' } });
		const chip = document.querySelector('[data-slot="freshness-stamp"]') as HTMLElement;
		expect(chip).not.toBeNull();
		expect(within(chip).getByText('Live · updated 5 minutes ago')).toBeInTheDocument();
		expect(chip.querySelector('time')).toHaveAttribute('datetime', '2026-06-15T12:00:00Z');
	});

	it('frames each reported ETA as a prediction with an honest delay basis', async () => {
		await render(TripDetail, { props: { id: 't161' } });

		const stops = screen.getByRole('table', { name: 'Reported predictions' });
		expect(within(stops).getByRole('link', { name: /^View stop Stop sA/ })).toHaveAttribute(
			'href',
			'/stop/sA?provider=stm',
		);
		expect(within(stops).getAllByRole('rowheader')).toHaveLength(2);
		expect(
			within(stops)
				.getAllByRole('columnheader')
				.map((cell) => cell.textContent),
		).toEqual(['Stop', 'Predicted time', 'Reported offset']);
	});

	it('shows the delay basis when present and the styled honest-absence chip when null, never 0', async () => {
		await render(TripDetail, { props: { id: 't161' } });

		const stops = screen.getByRole('table', { name: 'Reported predictions' });
		expect(within(stops).getByText('+4 min')).toBeInTheDocument();
		const absent = within(stops).getByText('not reported in the live feed');
		expect(absent.closest('[data-slot="absent-value"]')).not.toBeNull();
		expect(within(stops).queryByText('0 min late')).not.toBeInTheDocument();
	});

	it('renders the styled honest-absence chip when a broadcasting trip omits route + delay', async () => {
		await render(TripDetail, { props: { id: 'tBlank' } });
		expect(
			screen.getByRole('heading', { level: 1, name: 'Trip prediction report' }),
		).toBeInTheDocument();
		const chips = within(document.querySelector('.trip-summary') as HTMLElement).getAllByText(
			'not reported in the live feed',
		);
		expect(chips.length).toBe(2);
		for (const chip of chips) {
			expect(chip.closest('[data-slot="absent-value"]')).not.toBeNull();
		}
		expect(screen.queryByText('No line reported')).not.toBeInTheDocument();
	});

	it('renders an honest note when a broadcasting trip reports no predictions', async () => {
		await render(TripDetail, { props: { id: 'tEmpty' } });

		const empty = screen.getByTestId('trip-no-stops');
		expect(empty).toBeInTheDocument();
		expect(empty).toHaveAttribute('data-slot', 'state-notice');
		expect(empty).toHaveAttribute('data-presentation', 'silo');
		expect(
			decodeURIComponent(
				screen.getByRole('link', { name: 'Download all predictions (CSV)' }).getAttribute('href')!,
			).split('\r\n'),
		).toHaveLength(1);
		expect(
			screen.queryByRole('list', { name: 'Reported predictions for this trip' }),
		).not.toBeInTheDocument();
	});
});

describe('TripDetail: stand-down honesty', () => {
	it('stands down when the trip id is absent from the retained report', async () => {
		await render(TripDetail, { props: { id: 'tGhost' } });

		expect(screen.getByTestId('trip-standdown')).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: 'Trip not in this report' })).toBeInTheDocument();
		expect(screen.queryByRole('heading', { name: 'Trip tGhost' })).not.toBeInTheDocument();
	});

	it.each(['stale', 'refresh-unavailable'] as const)(
		'does not call a %s retained report current',
		async (notice) => {
			reportNotice = notice;
			reportStale = notice === 'stale';
			await render(TripDetail, { props: { id: 'missing' } });
			expect(screen.getByTestId('trip-standdown')).toHaveTextContent(
				'This trip is not in the report shown. Find its line or search again.',
			);
			expect(screen.getByTestId('trip-standdown')).not.toHaveTextContent('current report');
			expect(screen.getByRole('link', { name: 'Find its line' })).toHaveAttribute(
				'href',
				'/lines?provider=stm',
			);
			expect(screen.getByRole('link', { name: 'Search again' })).toHaveAttribute(
				'href',
				'/search?provider=stm',
			);
		},
	);

	it('stands down when no report has loaded', async () => {
		tripsData = null;
		await render(TripDetail, { props: { id: 't161' } });
		expect(screen.queryByRole('heading', { name: 'Trip t161' })).not.toBeInTheDocument();
		expect(screen.queryByTestId('trip-standdown')).not.toBeInTheDocument();
	});
});

describe.each(['en', 'fr'] as const)('TripDetail report scope in %s', (locale) => {
	const context = new Map([[Symbol.for('@yesid/ui/locale'), () => locale]]);
	it('keeps the full long stop name available in either language', async () => {
		const name =
			'Station Université de Montréal / Boulevard Édouard-Montpetit et chemin de la Côte-des-Neiges';
		stopNames = [{ id: 'sA', name }];
		await render(TripDetail, { props: { id: 't161' }, context });
		const link = screen.getByRole('link', { name: new RegExp(name) });
		expect(link).toHaveAccessibleName(expect.stringContaining(name));
		expect(within(link).getByTitle(name)).toHaveTextContent(name);
	});
	it('counts prediction rows without claiming a last reported stop', async () => {
		const { container } = await render(TripDetail, { props: { id: 't161' }, context });
		const stop = screen.getByRole('link', { name: /sA/ });
		expect(stop).toHaveAccessibleName(
			`${locale === 'en' ? 'View stop' : 'Voir l’arrêt'} ${locale === 'en' ? 'Stop sA (name unavailable)' : 'Arrêt sA (nom indisponible)'}`,
		);
		const row = stop.closest('tr') as HTMLElement;
		expect(
			within(row).getByRole('cell', { name: locale === 'en' ? '5:05 a.m.' : '5 h 05' }),
		).toBeInTheDocument();
		expect(row).toHaveTextContent('+4 min');
		expect(container.querySelector('.trip-last-stop-name')).not.toBeInTheDocument();
		expect(container.querySelectorAll('.trip-stop-link')).toHaveLength(2);
		expect(container.querySelector('.trip-prediction-count')).toHaveTextContent(
			locale === 'fr' ? '2 prévisions communiquées' : '2 predictions reported',
		);
		expect(container.textContent).not.toMatch(/Last reported stop|Dernier arrêt communiqué/);
		expect(container.textContent).not.toMatch(/Destination|stops remaining|arrêts restants/);
	});
	it('explains the prediction rows, not average delay, in their help', async () => {
		await render(TripDetail, { props: { id: 't161' }, context });
		const section = screen.getByRole('region', { name: tripCopy[locale].reportedPredictions });
		await fireEvent.click(
			within(section).getByRole('button', {
				name: new RegExp(tripCopy[locale].reportedPredictions),
			}),
		);

		expect(within(section).getByRole('dialog')).toHaveTextContent(
			locale === 'en'
				? 'Each row is the agency’s latest prediction for this trip at one stop. Predictions are not observed arrivals.'
				: 'Chaque rangée est la plus récente prévision de l’agence pour ce trajet à un arrêt. Les prévisions ne sont pas des arrivées observées.',
		);
	});
	it.each([false, true])(
		'retains report-specific absence and timestamp when stale=%s',
		async (stale) => {
			reportStale = stale;
			reportNotice = stale ? 'stale' : null;
			await render(TripDetail, { props: { id: 'tGhost' }, context });
			const stamp = document.querySelector('[data-slot="freshness-stamp"]')!;
			expect(stamp).toHaveAttribute('data-variant', 'live');
			expect(document.querySelector('.freshness-stamp-stale')).toBeNull();
			expect(stamp.querySelector('time')).toHaveAttribute('datetime', TRIPS_FILE.generated_utc);
			expect(screen.queryByTestId('trip-report-notice') !== null).toBe(stale);
		},
	);
	it('warns on failed refresh without classifying a recent retained report as stale', async () => {
		reportNotice = 'refresh-unavailable';
		await render(TripDetail, { props: { id: 't161' }, context });
		const stamp = document.querySelector('[data-slot="freshness-stamp"]')!;
		expect(stamp).toHaveAttribute('data-variant', 'live');
		expect(stamp).toHaveAttribute('data-stale', 'false');
		expect(document.querySelector('[data-slot="article-keywords"]')).toBeNull();
		expect(screen.getByTestId('trip-report-notice')).toHaveTextContent(
			locale === 'fr' ? 'Actualisation indisponible' : 'Refresh unavailable',
		);
		expect(document.querySelectorAll('.trip-stop-link')).toHaveLength(2);
	});
});

describe.each(['en', 'fr'] as const)('missing trip fields follow health (%s)', (locale) => {
	for (const notice of ['stale', 'refresh-unavailable'] as const)
		it(notice, async () => {
			reportNotice = notice;
			reportStale = notice === 'stale';
			const { container } = await render(TripDetail, {
				props: { id: 'tBlank' },
				context: new Map([[Symbol.for('@yesid/ui/locale'), () => locale]]),
			});
			const missing = container.querySelector('[data-slot="absent-value"]');
			expect(missing).toHaveAccessibleName(
				expect.stringContaining(
					locale === 'en'
						? notice === 'stale'
							? 'Report behind'
							: 'Refresh unavailable'
						: notice === 'stale'
							? 'Rapport en retard'
							: 'Indisponible',
				),
			);
		});
});

describe.each(['en', 'fr'] as const)('trip line title in %s', (locale) => {
	it.each(['24', '1-373', '80'])(
		'titles a trip by its line and links back to it (%s)',
		async (route) => {
			const directory = createLineDirectory(
				[
					{ id: '24', short: '24' },
					{ id: '1-373', short: '1' },
				],
				{ line: (id) => routeNameFallback(id, locale) },
			);
			const name = directory.spoken(directory.number(route));
			tripsData = { ...TRIPS_FILE, trips: { probe: { ...TRIPS_FILE.trips.t161, route } } };
			vi.mocked(getRoute).mockResolvedValue({
				directions: [
					{
						dir: 0,
						headsign: 'Terminal',
						stops: [
							{ id: 'sA', seq: 1 },
							{ id: 'sB', seq: 2 },
						],
					},
				],
			} as Awaited<ReturnType<typeof getRoute>>);
			const { container, unmount } = await render(TripDetail, {
				props: { id: 'probe' },
				context: new Map<symbol, unknown>([
					[Symbol.for('@yesid/ui/locale'), () => locale],
					[Symbol.for('transit.line-directory'), () => directory],
				]),
			});
			expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
				tripCopy[locale].reportTitle,
			);
			await screen.findAllByText(tripCopy[locale].toward('Terminal'));
			const publicIdentity = route === '80' ? tripCopy[locale].lineId(route) : name;
			expect(screen.getAllByText(publicIdentity, { exact: true })).toHaveLength(2);
			for (const link of screen.getAllByRole('link', { name: tripCopy[locale].lineRecord }))
				expect(link).toHaveAttribute(
					'href',
					(locale === 'fr' ? '/fr' : '') + '/lines/' + route + '?provider=stm',
				);
			const meta = screen.getByText(tripCopy[locale].heading('probe'), { exact: true });
			expect(meta.closest('[data-slot="article-header"]')).toBeInTheDocument();
			expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent('probe');
			expect(container.textContent).not.toMatch(/Departure|Départ/);
			unmount();
			vi.mocked(getRoute).mockResolvedValue(null);
			await render(TripDetail, {
				props: { id: 'probe' },
				context: new Map<symbol, unknown>([
					[Symbol.for('@yesid/ui/locale'), () => locale],
					[Symbol.for('transit.line-directory'), () => directory],
				]),
			});
			expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
				tripCopy[locale].reportTitle,
			);
			expect(screen.queryByText(tripCopy[locale].toward('Terminal'))).toBeNull();
		},
	);
});
