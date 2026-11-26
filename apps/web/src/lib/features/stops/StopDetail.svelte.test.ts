import { detailCopy } from './stops.copy';
import { render as renderSvelte, screen, fireEvent, within } from '@testing-library/svelte';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StopFile, StopDeparture } from '#lib/v1/index.ts';
import type { PublicProvider } from '#lib/v1/providers.ts';
import { alertUnavailableCopy } from '#lib/components/surface/alertAvailabilityCopy.ts';
import { createSurfaceHarness } from '../../../tests/surfaceHarness';
import StopDetail from './StopDetail.svelte';

vi.mock('@testing-library/svelte', { spy: true });

const stopTimeZone = vi.hoisted(() => ({ value: undefined as string | undefined }));
const stopDetailNav = vi.hoisted(() => {
	const page = {
		url: new URL('http://localhost/stop/57191'),
		state: {},
		data: {} as { provider?: Partial<PublicProvider> },
	};
	const defaultReplaceState = (url: string | URL) => {
		Object.assign(page, { url: new URL(url, 'http://localhost') });
	};
	return {
		page,
		defaultReplaceState,
		replaceState: vi.fn(defaultReplaceState),
	};
});

vi.mock('$app/state', () => ({ page: stopDetailNav.page }));
vi.mock('$app/navigation', () => ({
	afterNavigate: () => {},
	replaceState: stopDetailNav.replaceState,
}));

const STOP_FILE = {
	generated_utc: '2026-06-15T12:00:00Z',
	id: '57191',
	name: 'Test stop',
	lat: 45.5,
	lon: -73.6,
	scheduled: [],
	routes_served: ['51', '80'],
} as unknown as StopFile;

const ALERTS = [
	{
		id: 'al-stop',
		severity: 'high',
		header_key: 'Ascenseur hors service',
		header_text: 'Ascenseur hors service',
		header_text_en: 'Elevator out of service',
		stops: ['57191'],
	},
	{
		id: 'al-route',
		severity: 'critical',
		header_key: 'Détour ligne 51',
		header_text: 'Détour ligne 51',
		header_text_en: 'Detour on line 51',
		description: '<p>La ligne <strong>51</strong> est détournée &amp; reste en service.</p>',
		description_en: '<p>Route <strong>51</strong> is diverted &amp; remains in service.</p>',
		cause: 'CONSTRUCTION',
		effect: 'DETOUR',
		routes: ['51'],
	},
	{
		id: 'al-other',
		severity: 'watch',
		header_key: 'Autre avis',
		header_text: 'Autre avis',
		header_text_en: 'Unrelated alert',
		routes: ['999'],
		stops: ['88888'],
	},
];

const DEPARTURES = [
	{ eta_utc: '2026-06-15T12:05:00Z', route: '51', delay_min: 4 },
	{ eta_utc: '2026-06-15T12:08:00Z', route: '80', delay_min: 0 },
	{ eta_utc: '2026-06-15T12:11:00Z', route: '51', delay_min: -2 },
] as StopDeparture[];

const DEPARTURES_B = [
	{ eta_utc: '2026-06-15T12:06:00Z', route: '12', delay_min: 0 },
	{ eta_utc: '2026-06-15T12:09:00Z', route: '12', delay_min: 0 },
] as StopDeparture[];

let stopFileData: StopFile = STOP_FILE;
let alertsData: { generated_utc: string; alerts: typeof ALERTS } | null = {
	generated_utc: '2026-06-15T12:00:00Z',
	alerts: ALERTS,
};

const STOP_FILE_BY_CODE = {
	generated_utc: '2026-06-15T12:00:00Z',
	id: 'STATION-1',
	name: 'Metro station',
	lat: 45.5,
	lon: -73.6,
	code: '10254',
	scheduled: [],
	routes_served: [],
} as unknown as StopFile;

const ALERTS_BY_CODE = [
	{
		id: 'al-code',
		severity: 'critical',
		header_key: 'Ascenseur de métro hors service',
		header_text: 'Ascenseur de métro hors service',
		header_text_en: 'Metro elevator out of service',
		stops: ['10254'],
	},
];

const liveStore = {
	familyStates: {
		departures: {
			phase: 'ready',
			retainedGeneration: '2026-06-15T12:00:00Z',
			health: { state: 'live', ageSeconds: 12, isStale: false, retained: true, notice: null },
		},
		alerts: {
			phase: 'ready',
			retainedGeneration: '2026-06-15T12:00:00Z',
			health: { state: 'live', ageSeconds: 12, isStale: false, retained: true, notice: null },
		},
	},
	vehicles: null,
	trips: null,
	departures: { generated_utc: '2026-06-15T12:00:00Z' },
	get alerts() {
		return alertsData;
	},
	network: null,
	index: {
		byStopId: new Map<string, StopDeparture[]>([
			['57191', DEPARTURES],
			['99999', DEPARTURES_B],
		]),
	},
	generatedUtc: '2026-06-15T12:00:00Z',
	ageSeconds: 12,
	isStale: false,
	loading: false,
	error: null,
	start: vi.fn(),
	stop: vi.fn(),
	setTripScope: vi.fn(),
	refresh: vi.fn(),
};

const emptyLiveStore = {
	...liveStore,
	familyStates: {
		departures: {
			phase: 'idle',
			retainedGeneration: null,
			health: {
				state: 'never-loaded',
				ageSeconds: null,
				isStale: false,
				retained: false,
				notice: null,
			},
		},
		alerts: {
			phase: 'idle',
			retainedGeneration: null,
			health: {
				state: 'never-loaded',
				ageSeconds: null,
				isStale: false,
				retained: false,
				notice: null,
			},
		},
	},
	departures: null,
	alerts: null,
	index: { byStopId: new Map<string, StopDeparture[]>() },
};

const silentBoardLiveStore = {
	...liveStore,
	departures: { generated_utc: '2026-06-15T12:00:00Z' },
	network: { non_responding_by_route: [{ route_id: '51', count: 3 }] },
	index: { byStopId: new Map<string, StopDeparture[]>() },
};

let useEmptyLive = false;
let useSilentBoard = false;
let currentLocale: 'en' | 'fr' = 'en';
const getStopSpy = vi.fn((_id: string) => stopFileData);
const liveHarness = vi.hoisted(() => ({ createLiveStore: vi.fn() }));
const stopSurface = createSurfaceHarness({
	url: {
		initial: '/stop/57191?tab=detail',
		origin: 'http://localhost',
		set: (url) => {
			stopDetailNav.page.url = url;
			stopDetailNav.page.state = {};
			window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
		},
	},
	locale: {
		initial: 'en' as const,
		set: (locale) => {
			currentLocale = locale;
		},
	},
	storage: [
		{
			port: sessionStorage,
			prefixes: ['persisted:stop-detail-'],
		},
	],
	resetters: [resetStopSurfaceState],
	mount: renderSvelte,
});

vi.mock('#lib/i18n/index.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/i18n/index.ts')>();
	return { ...actual, getLocale: () => currentLocale };
});

vi.mock('#lib/v1/repositories/static.ts', () => ({
	getStop: (id: string) => getStopSpy(id),
}));
vi.mock('#lib/v1/live/store.svelte.ts', () => ({
	createLiveStore: liveHarness.createLiveStore,
}));
vi.mock('#lib/v1/boot.ts', () => ({
	getV1Context: () => ({
		manifest: {
			short_name: 'STM',
			tz: stopTimeZone.value,
			display_name: 'Société de transport de Montréal',
			files: { live: { ttl_s: 30 } },
		},
		labels: {},
		lang: 'en',
	}),
}));

vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: (loader: () => unknown) => ({
		data: loader(),
		error: null,
		loading: false,
		settled: true,
		reload: vi.fn(),
	}),
}));

function resetStopSurfaceState() {
	stopTimeZone.value = undefined;
	stopDetailNav.page.data = {};
	stopDetailNav.replaceState.mockReset().mockImplementation(stopDetailNav.defaultReplaceState);
	useEmptyLive = false;
	useSilentBoard = false;
	stopFileData = STOP_FILE;
	alertsData = { generated_utc: '2026-06-15T12:00:00Z', alerts: ALERTS };
	currentLocale = 'en';
	getStopSpy.mockClear();
	liveHarness.createLiveStore
		.mockReset()
		.mockImplementation(() =>
			useSilentBoard ? silentBoardLiveStore : useEmptyLive ? emptyLiveStore : liveStore,
		);
	liveStore.index.byStopId.clear();
	liveStore.index.byStopId.set('57191', DEPARTURES);
	liveStore.index.byStopId.set('99999', DEPARTURES_B);
}

beforeEach(() => {
	// Content interactions use a returning expanded reader; boot is outside this unit harness.
	localStorage.setItem('sections-choice', 'expanded');
	document.documentElement.dataset.sectionsChoice = 'expanded';
	stopSurface.reset();
});
afterEach(() => {
	vi.useRealTimers();
	localStorage.removeItem('sections-choice');
	delete document.documentElement.dataset.sectionsChoice;
});

type StopDetailTestProps = { id: string; seed?: { id: string; name: string } };

function render(_component: typeof StopDetail, options: { props: StopDetailTestProps }) {
	const seededProps = {
		seed: { id: options.props.id, name: stopFileData.name ?? `#${options.props.id}` },
		...options.props,
	};
	const view = stopSurface.mount(StopDetail, { props: seededProps });
	return {
		...view,
		rerender: (props: StopDetailTestProps) =>
			view.rerender({
				seed: {
					id: props.id,
					name: props.id === stopFileData.id ? stopFileData.name : `#${props.id}`,
				},
				...props,
			}),
	};
}

afterAll(() => {
	expect(vi.mocked(renderSvelte).mock.calls.length).toBeLessThanOrEqual(70);
});

describe('StopDetail article contract', () => {
	it.each(['en', 'fr'] as const)(
		'explains unsupported alerts with the official %s link',
		(locale) => {
			currentLocale = locale;
			stopDetailNav.page.data.provider = {
				labels: {
					en: { city: 'Ottawa', operator: 'OC Transpo' },
					fr: { city: 'Ottawa', operator: 'OC Transpo' },
				},
				inputs: { i3_alerts: false, service_alerts: false },
				alert_links: {
					en: 'https://www.octranspo.com/en/alerts/',
					fr: 'https://www.octranspo.com/fr/alertes/',
				},
			};
			const { container } = render(StopDetail, { props: { id: '57191' } });
			expect(screen.getByText(alertUnavailableCopy[locale].body('OC Transpo'))).toBeVisible();
			expect(container.querySelector('[data-subject="alerts"]')).toBeNull();
			expect(screen.getByRole('link', { name: alertUnavailableCopy[locale].link })).toHaveAttribute(
				'href',
				stopDetailNav.page.data.provider.alert_links![locale],
			);
			expect(
				container.querySelector('[data-testid="stop-alerts-empty"], [data-testid="stop-alerts"]'),
			).toBeNull();
		},
	);

	it('the departures and alerts stamps name their subject and retain the seeded identity', async () => {
		const { container, rerender } = render(StopDetail, {
			props: { id: '57191', seed: { id: '57191', name: 'Seeded station name' } },
		});
		expect(
			container.querySelector('[data-source="alerts"] [data-subject="alerts"] time'),
		).toHaveTextContent('Live alerts');
		expect(
			container.querySelector('[data-source="departures"] [data-subject="data"] time'),
		).toHaveTextContent('Live ·');
		expect(liveHarness.createLiveStore.mock.calls[0]?.[2]).toEqual({
			families: ['departures'],
			tripScope: { kind: 'stop', id: '57191' },
		});

		expect(
			screen.getByRole('heading', { level: 1, name: 'Seeded station name' }),
		).toBeInTheDocument();
		expect(container.querySelectorAll('h1')).toHaveLength(1);
		expect(container.querySelectorAll('[data-slot="article-header"]')).toHaveLength(1);
		expect(container.querySelector('.surface-head')).toBeNull();
		expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual(['Live now']);
		await rerender({ id: '57191', seed: { id: '57191', name: '57191' } });
		expect(screen.getByRole('heading', { level: 1, name: 'Test stop' })).toBeInTheDocument();
	});
});

describe('StopDetail live article', () => {
	it('uses one disclosure frame around live departures instead of nesting a terminal card', () => {
		const { container } = render(StopDetail, { props: { id: '57191' } });
		const departuresCard = container.querySelector(
			'[data-toc="stop-detail-departures"]',
		) as HTMLElement;

		expect(departuresCard.querySelector('[data-slot="terminal-panel"]')).toBeNull();
		expect(within(departuresCard).getByRole('table', { name: /51/ })).toBeInTheDocument();
	});

	it('localizes the article identity labels without replacing their real values', () => {
		currentLocale = 'fr';
		stopSurface.setUrl('/fr/stop/57191?frameMode=live&tab=detail');
		const { container } = render(StopDetail, {
			props: { id: '57191', seed: { id: '57191', name: 'Station test' } },
		});

		expect(screen.getByRole('link', { name: '← Retour aux arrêts' })).toHaveAttribute(
			'href',
			'/fr/stops',
		);
		expect(container.querySelector('[data-slot="article-header"]')).toHaveTextContent(
			detailCopy.fr.kicker,
		);
		expect(container.querySelector('[data-slot="article-header"]')).not.toHaveTextContent(
			detailCopy.fr.info.code,
		);
		expect(
			screen.getByRole('link', { name: /Voir l’arrêt Station test sur la carte/ }),
		).toBeInTheDocument();
		expect(
			screen.getByText(detailCopy.fr.info.feedId).closest('[data-slot="metric-display"]'),
		).toHaveTextContent('57191');
		expect(screen.getAllByText('STM').length).toBeGreaterThan(0);
	});
});

describe('StopDetail map drilldown', () => {
	it('links directly to the live map filtered to this stop', () => {
		const { container } = render(StopDetail, { props: { id: '57191' } });
		expect(container.querySelector('[data-slot="article-header"]')).not.toHaveTextContent(
			detailCopy.en.info.code,
		);
		expect(
			screen.getByText(detailCopy.en.info.feedId).closest('[data-slot="metric-display"]'),
		).toHaveTextContent('57191');
		expect(screen.getAllByText('STM').length).toBeGreaterThan(0);
		expect(container.querySelectorAll('a[href="/stops"]')).toHaveLength(1);
		expect(screen.getByRole('link', { name: /View stop Test stop on map/ })).toHaveAttribute(
			'href',
			'/map?stop=57191&focus=stop%3A57191',
		);
	});
});

const predictions = () =>
	document.querySelector('[data-slot="stop-live-predictions"]') as HTMLElement;
const lineHeadings = () =>
	within(predictions())
		.getAllByRole('heading', { level: 3 })
		.map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim());

describe('StopDetail Live now — predictions grouped by line', () => {
	it.each(['en', 'fr'] as const)(
		'groups each line with its schedule destination, time, status and offset (%s)',
		(locale) => {
			currentLocale = locale;
			stopFileData = {
				...STOP_FILE,
				scheduled: [
					{ route: '51', headsign: 'Station Laurier', times: ['08:00'] },
					{ route: '51', headsign: 'Édouard-Montpetit', times: ['08:05'] },
				],
			} as unknown as StopFile;
			const t = detailCopy[locale].live;
			render(StopDetail, { props: { id: '57191' } });

			expect(lineHeadings()).toEqual(
				locale === 'en'
					? [
							'Line 51 Toward Station Laurier or Édouard-Montpetit',
							'Line 80 Destination not in this stop’s schedule',
						]
					: [
							'Ligne 51 Vers Station Laurier ou Édouard-Montpetit',
							'Ligne 80 Destination absente de l’horaire de cet arrêt',
						],
			);
			const line51 = within(predictions()).getByRole('table', { name: /51/ });
			const rows = within(line51).getAllByRole('row').slice(1);
			expect(rows.map((row) => row.querySelector('td')?.textContent?.trim())).toEqual([
				`●${t.bands.on_time}`,
				`▼${t.bands.early}`,
			]);
			expect(rows.map((row) => row.querySelector('td:last-child')?.textContent?.trim())).toEqual([
				'+4 min',
				'−2 min',
			]);
			expect(within(predictions()).getByText(t.total(3, 2))).toBeInTheDocument();
			expect(within(predictions()).getByText(t.destinationCaveat)).toBeInTheDocument();
			expect(screen.getByRole('link', { name: t.record })).toHaveAttribute(
				'href',
				'http://localhost/stop/57191?frameMode=record',
			);
		},
	);

	it('gives the rounded minute where it sits on a limit, with a shape only for one band', () => {
		liveStore.index.byStopId.set('57191', [
			{ eta_utc: '2026-06-15T12:05:00Z', route: '51', delay_min: 5 },
			{ eta_utc: '2026-06-15T12:06:00Z', route: '51', delay_min: 6 },
			{ eta_utc: '2026-06-15T12:07:00Z', route: '80', delay_min: null },
		] as StopDeparture[]);
		render(StopDetail, { props: { id: '57191' } });
		const statuses = [...predictions().querySelectorAll('tbody td:first-of-type')];
		expect(statuses.map((cell) => cell.textContent?.trim()).slice(0, 2)).toEqual([
			'About 5 min late',
			'▲Late',
		]);
		expect(statuses[0]!.querySelector('[aria-hidden="true"]')).toBeNull();
		expect(statuses[2]!.querySelector('[data-slot="absent-value"]')).not.toBeNull();
		expect(screen.queryByText(/Severe/)).toBeNull();
	});

	it('offers an order only once two lines are listed, and it reorders the lines', async () => {
		liveStore.index.byStopId.set('57191', [
			{ eta_utc: '2026-06-15T12:01:00Z', route: '80', delay_min: 0 },
			{ eta_utc: '2026-06-15T12:05:00Z', route: '7', delay_min: 0 },
		] as StopDeparture[]);
		render(StopDetail, { props: { id: '57191' } });
		expect(lineHeadings().map((name) => name?.split(' ')[1])).toEqual(['80', '7']);
		await fireEvent.change(screen.getByRole('combobox', { name: 'Order' }), {
			target: { value: 'line' },
		});
		expect(lineHeadings().map((name) => name?.split(' ')[1])).toEqual(['7', '80']);
	});

	it('shows no order control for a single line', () => {
		render(StopDetail, { props: { id: '99999' } });
		expect(predictions()).toBeInTheDocument();
		expect(screen.queryByRole('combobox', { name: 'Order' })).toBeNull();
	});
});

describe('StopDetail Live now — each absence says what it is', () => {
	it('an empty current report does not say no vehicle is coming, and points to the schedule', () => {
		useSilentBoard = true;
		render(StopDetail, { props: { id: '57191' } });
		const t = detailCopy.en.live;
		expect(screen.getByTestId('stop-live-state')).toHaveTextContent(t.none);
		expect(predictions()).toBeNull();
		expect(screen.queryByRole('combobox', { name: 'Order' })).toBeNull();
		expect(screen.getByRole('link', { name: t.schedule })).toHaveAttribute(
			'href',
			'/stop/57191?tab=schedule',
		);
	});

	it('a stop no line serves expects no predictions (fr)', () => {
		currentLocale = 'fr';
		useSilentBoard = true;
		stopFileData = { ...STOP_FILE, routes_served: [] } as unknown as StopFile;
		render(StopDetail, { props: { id: '57191' } });
		expect(screen.getByTestId('stop-live-state')).toHaveTextContent(detailCopy.fr.live.noService);
	});
});

describe('StopDetail — service alerts affecting this stop', () => {
	it('separates notices naming this stop from notices that only name its lines', () => {
		render(StopDetail, { props: { id: '57191' } });
		fireEvent.click(screen.getByRole('tab', { name: 'Live now' }));

		const direct = document.querySelector('[data-testid="stop-alerts"]') as HTMLElement;
		expect(within(direct).getByText('Notices naming this stop')).toBeInTheDocument();
		expect(within(direct).getByText('Elevator out of service')).toBeInTheDocument();
		expect(within(direct).queryByText(/Route 51/)).not.toBeInTheDocument();

		const lines = document.querySelector('[data-testid="stop-line-alerts"]') as HTMLElement;
		expect(within(lines).getByText('Notices for lines serving this stop')).toBeInTheDocument();
		expect(
			within(lines).getByText('Route 51 is diverted & remains in service.'),
		).toBeInTheDocument();
		expect(
			within(lines).getByText(
				'These notices name a line, not this stop. Check the agency before travelling.',
			),
		).toBeInTheDocument();
		expect(within(lines).getByText('Construction')).toBeInTheDocument();
		expect(within(lines).queryByText('Elevator out of service')).not.toBeInTheDocument();
		expect(screen.queryByText('Unrelated alert')).not.toBeInTheDocument();
	});

	it('localizes the notice groups + headlines in FR', () => {
		currentLocale = 'fr';
		render(StopDetail, { props: { id: '57191' } });
		fireEvent.click(screen.getByRole('tab', { name: 'En direct' }));

		const lines = document.querySelector('[data-testid="stop-line-alerts"]') as HTMLElement;
		expect(within(lines).getByText('Avis visant les lignes de cet arrêt')).toBeInTheDocument();
		expect(
			within(lines).getByText('La ligne 51 est détournée & reste en service.'),
		).toBeInTheDocument();
		expect(within(lines).queryByText('Détour ligne 51')).not.toBeInTheDocument();
		expect(within(lines).getByText('Travaux')).toBeInTheDocument();
		expect(document.querySelector('[data-toc="stop-detail-notices"]')).toHaveTextContent(
			'Avis de la société de transport · STM',
		);
	});

	it('stands the alerts section down when no live alert affects this stop', () => {
		useEmptyLive = true;
		render(StopDetail, { props: { id: '57191' } });
		fireEvent.click(screen.getByRole('tab', { name: 'Live now' }));

		expect(document.querySelector('[data-testid="stop-alerts"]')).toBeNull();
	});

	it('surfaces an alert the live feed targets by CODE when id != code (metro regression)', () => {
		stopFileData = STOP_FILE_BY_CODE;
		alertsData = { generated_utc: '2026-06-15T12:00:00Z', alerts: ALERTS_BY_CODE as typeof ALERTS };
		render(StopDetail, { props: { id: 'STATION-1' } });
		fireEvent.click(screen.getByRole('tab', { name: 'Live now' }));

		const alerts = document.querySelector('[data-testid="stop-alerts"]') as HTMLElement;
		expect(alerts).not.toBeNull();
		expect(within(alerts).getByText('Metro elevator out of service')).toBeInTheDocument();
	});
});

describe('StopDetail — per-stop state resets on navigation', () => {
	it('returns the prediction order to soonest first when the stop id changes', async () => {
		liveStore.index.byStopId.set('99999', [
			{ eta_utc: '2026-06-15T12:01:00Z', route: '80', delay_min: 0 },
			{ eta_utc: '2026-06-15T12:05:00Z', route: '7', delay_min: 0 },
		] as StopDeparture[]);
		const { rerender } = render(StopDetail, { props: { id: '57191' } });
		const order = () => screen.getByRole('combobox', { name: 'Order' }) as HTMLSelectElement;
		await fireEvent.change(order(), { target: { value: 'line' } });
		expect(order().value).toBe('line');

		await rerender({ id: '99999' });

		expect(order().value).toBe('soonest');
		expect(lineHeadings().map((name) => name?.split(' ')[1])).toEqual(['80', '7']);
	});
});

describe('StopDetail identity — notices section + honest accessibility', () => {
	it('puts agency notices in their own section between predictions and the stop facts', () => {
		const { container } = render(StopDetail, { props: { id: '57191' } });
		const sections = Array.from(container.querySelectorAll('[data-toc^="stop-detail-"]'));
		expect(sections.map((section) => section.getAttribute('data-toc'))).toEqual([
			'stop-detail-departures',
			'stop-detail-notices',
			'stop-detail-facts',
		]);
		expect(sections[1].querySelector('[data-testid="stop-alerts"]')).not.toBeNull();
		expect(sections[2].querySelector('[data-testid="stop-alerts"]')).toBeNull();
	});

	it.each([
		// Every field combination is covered in stopIdentity.test.ts; here, the two words shown.
		[{ wheelchair_boarding: 'no', wheelchair: false }, 'no', 'Not wheelchair accessible'],
		// The publisher writes wheelchair=false when the agency supplies nothing.
		[{ wheelchair: false }, 'unknown', 'Accessibility information is not available.'],
	] as const)('reads %o as %s access', (fields, state, sentence) => {
		stopFileData = { ...STOP_FILE, ...fields } as StopFile;
		const { container } = render(StopDetail, { props: { id: '57191' } });
		const access = container.querySelector('[data-slot="stop-access"]') as HTMLElement;
		expect(access).toHaveAttribute('data-access', state);
		expect(access).toHaveTextContent(sentence);
		if (state === 'unknown') {
			expect(screen.queryByText('Not wheelchair accessible')).not.toBeInTheDocument();
		}
	});
});

it.each(['en', 'fr'] as const)(
	'leads with the stop code, and shows none when none is published (%s)',
	(locale) => {
		currentLocale = locale;
		stopFileData = { ...STOP_FILE, code: '10254' };
		const t = detailCopy[locale];
		const view = render(StopDetail, { props: { id: STOP_FILE.id } });
		const header = view.container.querySelector('[data-slot="article-header"]')!;
		expect(within(header as HTMLElement).getByText(t.kicker + ' 10254')).toBeInTheDocument();
		expect(within(header as HTMLElement).getByText(t.info.code)).toBeInTheDocument();
		expect(
			screen.getByRole('link', { name: new RegExp(t.viewStopOnMap('10254')) }),
		).toBeInTheDocument();
		expect(
			screen.getByText(t.info.feedId).closest('[data-slot="metric-display"]'),
		).toHaveTextContent(STOP_FILE.id);
		expect(screen.getByRole('link', { name: t.back })).toBeInTheDocument();
	},
);
