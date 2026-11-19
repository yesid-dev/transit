import { stampCopy } from '#lib/v1/stamp.copy.ts';
import { formatDateKey } from '#lib/utils/time.ts';
import { detailCopy } from './stops.copy';
import {
	render as renderSvelte,
	screen,
	fireEvent,
	waitFor,
	within,
} from '@testing-library/svelte';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StopFile, StopReliability, StopDeparture } from '#lib/v1/index.ts';
import type { IdentitySeed } from '#lib/v1/serverContext.ts';
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

function habitsMatrix(): (number | null)[][] {
	const grid: (number | null)[][] = Array.from({ length: 7 }, () =>
		Array.from({ length: 24 }, () => null),
	);
	grid[1][8] = 0.9;
	return grid;
}

const RELIABILITY = {
	generated_utc: '2026-06-15T12:00:00Z',
	id: '57191',
	name: 'Test stop',
	periods: [
		{ grain: 'day', otp_pct: 82, avg_delay_min: 3.2, p50_min: 2.4, p90_min: 11.6, severe_pct: 6 },
		{ grain: 'week', otp_pct: 79, avg_delay_min: 3.8, p50_min: null, p90_min: null, severe_pct: 8 },
	],
	habits: { scale: 'severe_relative', matrix: habitsMatrix() },
	by_route: [
		{ route: '24', avg_delay_min: 4.1 },
		{ route: '80', avg_delay_min: 12.5 },
		{ route: '99', avg_delay_min: null },
	],
	day_of_week: [
		{ day_of_week_iso: 1, avg_delay_min: 2.4, severe_pct: 5.0, observation_count: 140 },
		{ day_of_week_iso: 3, avg_delay_min: 3.1, severe_pct: 18.2, observation_count: 2 },
		{ day_of_week_iso: 5, avg_delay_min: 9.4, severe_pct: 14.9, observation_count: 96 },
		{ day_of_week_iso: 7, avg_delay_min: null, severe_pct: null, observation_count: 0 },
	],
	occupancy_mix: { empty: 0.05, many_seats: 0.15, few_seats: 0.25, standing: 0.45, full: 0.1 },
} as StopReliability;

const RELIABILITY_WITH_TOD = {
	...RELIABILITY,
	periods: [
		...RELIABILITY.periods!,
		{ grain: 'am_peak', otp_pct: 88, avg_delay_min: 2.1, severe_pct: 5 },
		{ grain: 'midday', otp_pct: 91, avg_delay_min: 1.4, severe_pct: 3 },
		{ grain: 'pm_peak', otp_pct: 74, avg_delay_min: 5.6, severe_pct: 12 },
		{ grain: 'evening', otp_pct: 90, avg_delay_min: 1.8, severe_pct: 4 },
		{ grain: 'night', otp_pct: null, avg_delay_min: null, severe_pct: null },
		{ grain: 'weekday', otp_pct: 80, avg_delay_min: 3.4, severe_pct: 7 },
		{ grain: 'weekend', otp_pct: 86, avg_delay_min: 2.2, severe_pct: 4 },
	],
} as StopReliability;

const FIELD_EMPTY_RELIABILITY = {
	generated_utc: RELIABILITY.generated_utc,
	id: '57191',
	name: 'Test stop',
	periods: [],
	habits: null,
	by_route: [],
	day_of_week: [],
	occupancy_mix: null,
	daily: [],
} as StopReliability;

const HABITS_ONLY_RELIABILITY = {
	...FIELD_EMPTY_RELIABILITY,
	habits: { scale: 'severe_relative', matrix: habitsMatrix() },
} as StopReliability;

const STOP_HISTORY_INDEX = {
	generated_utc: '2026-07-13T12:00:00Z',
	family: 'stops',
	selection_mode: 'range',
	entity_id: '57191',
	collection_generation_id: 'a'.repeat(64),
	first_available_date: '2026-01-31',
	last_available_date: '2026-02-01',
	gaps: [],
	partitions: [
		{
			path: `historic/history/stops/3537313931/generations/${'b'.repeat(64)}/2026-01.json`,
			coverage_start: '2026-01-31',
			coverage_end: '2026-01-31',
			count: 1,
			sha256: 'b'.repeat(64),
			byte_size: 100,
		},
		{
			path: `historic/history/stops/3537313931/generations/${'c'.repeat(64)}/2026-02.json`,
			coverage_start: '2026-02-01',
			coverage_end: '2026-02-01',
			count: 1,
			sha256: 'c'.repeat(64),
			byte_size: 100,
		},
	],
	metrics: [],
};

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
let reliabilityData: StopReliability | null = RELIABILITY;
let provenanceData: { generated_utc: string; gaps: string[] } = {
	generated_utc: '2026-06-15T12:00:00Z',
	gaps: [],
};
let currentLocale: 'en' | 'fr' = 'en';
// The published weekly index the home page's "Most delayed stops" reads; null = none published.
let weeklyIndexData: unknown = null;
const getStopSpy = vi.fn((_id: string) => stopFileData);
const getStopReliabilitySpy = vi.fn((_id: string) => reliabilityData);
const stopHistoryHarness = vi.hoisted(() => ({
	getStopHistoryDirectory: vi.fn(),
	getStopHistoryIndex: vi.fn(),
	loadStopHistoryRange: vi.fn(),
	createLiveStore: vi.fn(),
}));
const reliabilityReloadSpy = vi.fn();
let reliabilityResourceState: {
	data: StopReliability | null;
	error: Error | null;
	loading: boolean;
	settled: boolean;
} | null = null;
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
			keys: ['persisted:stop-reliability-controls', 'persisted:stop-reliability-toc'],
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
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getStopReliability: (id: string) => getStopReliabilitySpy(id),
	getPublishedReliabilityIndex: () => weeklyIndexData,
	getStopHistoryDirectory: stopHistoryHarness.getStopHistoryDirectory,
	getStopHistoryIndex: stopHistoryHarness.getStopHistoryIndex,
	loadStopHistoryRange: stopHistoryHarness.loadStopHistoryRange,
}));
vi.mock('#lib/v1/repositories/provenance.ts', () => ({ getProvenance: () => provenanceData }));
vi.mock('#lib/v1/repositories/dataHealth.ts', () => ({ getDataHealth: async () => null }));
// The notice's rule lives in the stamp module (recordStamp.svelte.test.ts); here only its placement.
const recordHealth = vi.hoisted(() => ({
	verdict: null as string | null,
	reads: undefined as (() => boolean) | undefined,
}));
vi.mock('#lib/v1/recordStamp.svelte.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/v1/recordStamp.svelte.ts')>();
	return {
		...actual,
		createRecordStamp: (...args: Parameters<typeof actual.createRecordStamp>) => {
			recordHealth.reads = args[3];
			return Object.assign(Object.create(actual.createRecordStamp(...args)), {
				notice: (lang: 'en' | 'fr') =>
					recordHealth.verdict === 'warn' ? stampCopy[lang].warning : null,
			});
		},
	};
});
vi.mock('#lib/v1/live/store.svelte.ts', () => ({
	createLiveStore: stopHistoryHarness.createLiveStore,
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
	createResource: (loader: () => unknown) => {
		const data = loader();
		if (data === reliabilityData && reliabilityResourceState != null) {
			return {
				get data() {
					return reliabilityResourceState?.data ?? null;
				},
				get error() {
					return reliabilityResourceState?.error ?? null;
				},
				get loading() {
					return reliabilityResourceState?.loading ?? false;
				},
				get settled() {
					return reliabilityResourceState?.settled ?? true;
				},
				reload: reliabilityReloadSpy,
			};
		}
		return {
			data,
			error: null,
			loading: false,
			settled: true,
			reload: vi.fn(),
		};
	},
}));

function resetStopSurfaceState() {
	stopTimeZone.value = undefined;
	stopDetailNav.page.data = {};
	stopDetailNav.replaceState.mockReset().mockImplementation(stopDetailNav.defaultReplaceState);
	useEmptyLive = false;
	useSilentBoard = false;
	reliabilityData = RELIABILITY;
	stopFileData = STOP_FILE;
	alertsData = { generated_utc: '2026-06-15T12:00:00Z', alerts: ALERTS };
	provenanceData = { generated_utc: '2026-06-15T12:00:00Z', gaps: [] };
	currentLocale = 'en';
	weeklyIndexData = null;
	getStopSpy.mockClear();
	getStopReliabilitySpy.mockClear();
	stopHistoryHarness.getStopHistoryDirectory.mockReset();
	stopHistoryHarness.getStopHistoryIndex.mockReset();
	stopHistoryHarness.getStopHistoryIndex.mockResolvedValue(null);
	stopHistoryHarness.loadStopHistoryRange.mockReset();
	stopHistoryHarness.createLiveStore
		.mockReset()
		.mockImplementation(() =>
			useSilentBoard ? silentBoardLiveStore : useEmptyLive ? emptyLiveStore : liveStore,
		);
	reliabilityResourceState = null;
	reliabilityReloadSpy.mockClear();
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

type StopDetailTestProps = { id: string; seed?: IdentitySeed };

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

function articleCardFor(body: Element | null): HTMLElement {
	const card = body?.closest('[data-slot="card"]');
	if (!(card instanceof HTMLElement))
		throw new Error('Expected article card around presenter body');
	return card;
}

function weeklyRow(id: string, readings: number, late: number) {
	return {
		state: 'ranked',
		id,
		rank: 1,
		numerator: readings - late,
		denominator: readings,
		pct: Math.round((100 * (readings - late)) / readings),
		severe_pct: Math.round((1000 * late) / readings) / 10,
		window_start: '2026-11-04',
		window_end: '2026-11-10',
	};
}

function weeklyIndex(rows: unknown[]) {
	return {
		generated_utc: '2026-11-11T07:30:00Z',
		published_utc: '2026-11-11T07:30:00Z',
		next_publish_utc: '2026-11-18T07:00:00Z',
		weekly_stops: rows,
	};
}

function renderReliability(locale: 'en' | 'fr' = currentLocale) {
	currentLocale = locale;
	const view = render(StopDetail, { props: { id: '57191' } });
	fireEvent.click(screen.getByRole('tab', { name: locale === 'fr' ? 'Bilan' : 'Record' }));
	return view;
}

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
		expect(stopHistoryHarness.createLiveStore.mock.calls[0]?.[2]).toEqual({
			families: ['departures'],
		});

		expect(
			screen.getByRole('heading', { level: 1, name: 'Seeded station name' }),
		).toBeInTheDocument();
		expect(container.querySelectorAll('h1')).toHaveLength(1);
		expect(container.querySelectorAll('[data-slot="article-header"]')).toHaveLength(1);
		expect(container.querySelector('.surface-head')).toBeNull();
		expect(screen.getAllByRole('tab').map((tab) => tab.textContent?.trim())).toEqual([
			'Record',
			'Live now',
			'Schedule',
		]);
		await rerender({ id: '57191', seed: { id: '57191', name: '57191' } });
		expect(screen.getByRole('heading', { level: 1, name: 'Test stop' })).toBeInTheDocument();
	});

	it('keeps one stop summary: identity on every view, the record answer and notice strip on the Record', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-13T15:00:00Z'));
		weeklyIndexData = weeklyIndex([weeklyRow('57191', 210, 120)]);
		const { container } = render(StopDetail, { props: { id: '57191' } });
		// The summary leads each view's own pane as a full-width block, never a centered banner.
		const activePane = () =>
			container.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"]')!;
		const identities = () => activePane().querySelectorAll('[data-slot="stop-identity"]');
		const answer = () => container.querySelector<HTMLElement>('[data-slot="stop-record-answer"]');
		const leadsPane = () =>
			activePane().querySelector('[data-slot="stop-summary"]')?.parentElement ===
			activePane().firstElementChild;

		// Live now holds the full notices, so its summary carries no strip and no answer.
		expect(identities()).toHaveLength(1);
		expect(leadsPane()).toBe(true);
		expect(container.querySelector('[data-slot="detail-shell-summary"]')).toBeNull();
		expect(answer()).toBeNull();
		expect(container.querySelector('[data-slot="stop-current-notice"]')).toBeNull();

		await fireEvent.click(screen.getByRole('tab', { name: 'Record' }));
		expect(identities()).toHaveLength(1);
		expect(leadsPane()).toBe(true);
		const strip = container.querySelector('[data-slot="stop-current-notice"]') as HTMLElement;
		expect(strip).toHaveAttribute('data-scope', 'stop');
		expect(within(strip).getByText('2 current agency notices · STM')).toBeInTheDocument();
		expect(within(strip).getByText('Elevator out of service')).toBeInTheDocument();
		expect(
			within(strip).getByText(
				'It names this stop. This current notice does not explain the historic result.',
			),
		).toBeInTheDocument();
		expect(within(strip).getByRole('link', { name: 'Read the 2 notices' })).toHaveAttribute(
			'href',
			'/stop/57191?tab=detail#stop-detail-notices',
		);
		// The answer leads the record, ahead of the reliability sections.
		const pane = container.querySelector('[data-slot="reliability-pane"]') as HTMLElement;
		expect(answer()!.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	it.each(['en', 'fr'] as const)(
		'leads the record with the published weekly figure the home page ranks (%s)',
		async (locale) => {
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(new Date('2026-11-13T15:00:00Z'));
			weeklyIndexData = weeklyIndex([weeklyRow('11000', 90, 9), weeklyRow('57191', 210, 120)]);
			stopFileData = { ...STOP_FILE, code: '52409' };
			const { container } = renderReliability(locale);
			const answer = container.querySelector('[data-slot="stop-record-answer"]') as HTMLElement;
			const expected = {
				en: {
					measure: 'Readings more than 5 minutes late',
					period: 'November 4 to 10, 2026 · 7 complete days',
					line: '57.1% of readings indicated a delay of more than 5 minutes.',
					readings: '210 readings; 120 more than 5 minutes late.',
					actions: ['Copy link', 'Download CSV', 'Cite this record'],
				},
				fr: {
					measure: 'Relevés à plus de 5 minutes de retard',
					period: 'Du 4 au 10 novembre 2026 · 7 jours complets',
					line: '57,1\u00a0% des relevés indiquaient plus de 5 minutes de retard.',
					readings: '210 relevés; 120 à plus de 5 minutes de retard.',
					actions: ['Copier le lien', 'Télécharger le CSV', 'Citer ce bilan'],
				},
			}[locale];
			expect(answer).toHaveAttribute('data-state', 'measured');
			expect(within(answer).getByText(expected.measure)).toBeInTheDocument();
			expect(within(answer).getByText(expected.period)).toBeInTheDocument();
			expect(answer.querySelector('.stop-record__line')?.textContent?.trim()).toBe(expected.line);
			expect(within(answer).getByText(expected.readings)).toBeInTheDocument();
			const actions = within(answer).getByRole('group', {
				name: locale === 'fr' ? 'Actions sur ce bilan' : 'Record actions',
			});
			const controls = Array.from(actions.querySelectorAll<HTMLElement>('a, button'));
			expect(controls.map((control) => control.textContent?.trim())).toEqual(expected.actions);
			expect(controls[1]).toHaveAttribute(
				'download',
				'transit-stm-stop-52409-2026-11-04-to-2026-11-10.csv',
			);
			expect(decodeURIComponent(controls[1].getAttribute('href') ?? '')).toContain(
				'STM,57191,52409,Test stop,readings_more_than_5_min_late,2026-11-04,2026-11-10,210,120,57.1',
			);

			const writeText = vi.fn().mockResolvedValue(undefined);
			Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
			try {
				await fireEvent.click(controls[0]);
				await waitFor(() =>
					expect(
						within(answer).getByText(locale === 'fr' ? 'Lien copié.' : 'Link copied.'),
					).toBeInTheDocument(),
				);
				const record = `http://localhost${locale === 'fr' ? '/fr' : ''}/stop/57191`;
				expect(writeText).toHaveBeenLastCalledWith(record);
				await fireEvent.click(controls[2]);
				await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
				expect(writeText.mock.calls[1][0]).toBe(
					locale === 'fr'
						? `Transit (site non officiel). STM, arrêt 52409 « Test stop » : 57,1\u00a0% des relevés à plus de 5 minutes de retard, du 4 au 10 novembre 2026. ${record}`
						: `Transit (unofficial website). STM, stop 52409 “Test stop”: 57.1% of readings more than 5 minutes late, November 4 to 10, 2026. ${record}`,
				);
			} finally {
				Reflect.deleteProperty(navigator, 'clipboard');
			}
		},
	);

	it('keeps the record answer honest when no weekly record is published and the stop file is empty', () => {
		reliabilityData = null;
		const { container } = renderReliability('en');
		const answer = container.querySelector('[data-slot="stop-record-answer"]') as HTMLElement;
		expect(answer).toHaveAttribute('data-state', 'unpublished');
		expect(answer.querySelector('[data-slot="stop-record-status"]')).toHaveTextContent(
			'No weekly record has been published yet.',
		);
		// The figure line keeps its room, hidden from sight and from screen readers.
		expect(answer.querySelector('.stop-record__line')).toHaveAttribute('aria-hidden', 'true');
		expect(within(answer).queryByRole('link', { name: 'Download CSV' })).toBeNull();
		expect(within(answer).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
	});

	it('shows one date-only record and follows its year rule for the schedule date', async () => {
		recordHealth.verdict = 'warn';
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
		stopTimeZone.value = 'America/Toronto';
		const locale = 'en';
		stopDetailNav.page.url = new URL('http://localhost/stop/57191?tab=reliability');
		const { container } = render(StopDetail, { props: { id: '57191' } });
		const date = RELIABILITY.generated_utc.slice(0, 10);
		const expected = stampCopy[locale].record(null, formatDateKey(date, locale, false), 'window');
		const header = container.querySelector('[data-slot="article-header"]') as HTMLElement;
		expect(within(header).getByText(expected)).toHaveAttribute('datetime', date);
		expect(container.querySelector('[data-source="historic"] time')).toBeNull();
		const notice = () => within(header).queryByRole('link', { name: stampCopy[locale].warning });
		await waitFor(() => expect(notice()).toHaveAttribute('href', '/status'));
		expect(recordHealth.reads?.()).toBe(true);
		await fireEvent.click(screen.getByRole('tab', { name: detailCopy[locale].tabs.schedule }));
		expect(notice()).toBeNull();
		expect(recordHealth.reads?.()).toBe(false);
		recordHealth.verdict = null;
		for (const [now, includeYear] of [
			['2026-11-13T12:00:00Z', false],
			['2027-11-13T12:00:00Z', true],
		] as const) {
			vi.setSystemTime(new Date(now));
			await fireEvent.click(screen.getByRole('tab', { name: detailCopy[locale].tabs.detail }));
			await fireEvent.click(screen.getByRole('tab', { name: detailCopy[locale].tabs.schedule }));
			expect(
				within(header).getByText(
					detailCopy[locale].schedule.loadedOn(
						formatDateKey(STOP_FILE.generated_utc.slice(0, 10), locale, includeYear),
					),
				),
			).toHaveAttribute('datetime', STOP_FILE.generated_utc.slice(0, 10));
		}
	});

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
		stopSurface.setUrl('/stop/57191');
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
		const tabs = screen.getAllByRole('tab');
		expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Bilan', 'En direct', 'Horaire']);
		expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
		expect(container.querySelector('[data-toc="stop-detail-departures"]')).toBeNull();
		expect(
			within(container.querySelector('[data-slot="article-header"]') as HTMLElement).getByText(
				stampCopy.fr.record(
					null,
					formatDateKey(RELIABILITY.generated_utc.slice(0, 10), 'fr', true),
					'window',
				),
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole('link', { name: /Voir l’arrêt Station test sur la carte/ }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole('tab', { name: detailCopy.fr.tabs.detail }));
		expect(
			screen.getByText(detailCopy.fr.info.feedId).closest('[data-slot="metric-display"]'),
		).toHaveTextContent('57191');
		expect(screen.getAllByText('STM').length).toBeGreaterThan(0);
	});

	it.each(['next', 'info', 'unknown'])(
		'normalizes the legacy/unknown %s tab to a clean record URL without dropping range filters',
		async (legacy) => {
			stopDetailNav.page.url = new URL(
				`http://localhost/stop/57191?tab=${legacy}&from=2026-01-31&to=2026-02-01&line=51`,
			);
			render(StopDetail, { props: { id: '57191' } });
			expect(screen.getAllByRole('tab')[0]).toHaveAttribute('aria-selected', 'true');

			await waitFor(() => expect(stopDetailNav.replaceState).toHaveBeenCalled());
			const normalized = stopDetailNav.replaceState.mock.calls
				.map(([url]) => new URL(url as string | URL, 'http://localhost'))
				.find(
					(url) =>
						!url.searchParams.has('tab') &&
						url.searchParams.get('from') === '2026-01-31' &&
						url.searchParams.get('to') === '2026-02-01' &&
						url.searchParams.get('line') === '51',
				);
			expect(normalized).toBeDefined();
		},
	);

	it('does not let the inactive record pane undo the selected tab while shallow state lags', async () => {
		const initial = new URL('http://localhost/stop/57191?from=2026-01-31&to=2026-02-01&line=51');
		stopDetailNav.page.url = initial;
		window.history.replaceState({}, '', `${initial.pathname}${initial.search}`);
		stopDetailNav.replaceState.mockImplementation(() => undefined);

		try {
			render(StopDetail, { props: { id: '57191' } });
			expect(screen.getByRole('tab', { name: 'Record' })).toHaveAttribute('aria-selected', 'true');
			await fireEvent.click(screen.getByRole('tab', { name: 'Live now' }));
			await Promise.resolve();

			const finalWrite = new URL(
				stopDetailNav.replaceState.mock.calls.at(-1)?.[0] as string | URL,
				window.location.origin,
			);
			expect(finalWrite.searchParams.get('tab')).toBe('detail');
			expect(finalWrite.searchParams.get('from')).toBe('2026-01-31');
			expect(finalWrite.searchParams.get('to')).toBe('2026-02-01');
			expect(finalWrite.searchParams.get('line')).toBe('51');
		} finally {
			stopDetailNav.replaceState.mockImplementation((url: string | URL) => {
				stopDetailNav.page.url = new URL(url, 'http://localhost');
			});
			window.history.replaceState({}, '', '/');
		}
	});

	it('keeps the explicit Detail URL and preserves mounted panes while new panes use the bulk choice', async () => {
		stopFileData = {
			...STOP_FILE,
			scheduled: [{ route: '51', headsign: 'Nord', times: ['08:00'] }],
		} as unknown as StopFile;
		const { container } = render(StopDetail, { props: { id: '57191' } });

		expect(stopDetailNav.page.url.searchParams.get('tab')).toBe('detail');
		const tabs = container.querySelector<HTMLElement>('[data-slot="entity-detail-tabs"]');
		expect(container.querySelector('[data-slot="detail-shell-toolbar"]')).toContainElement(
			tabs as HTMLElement,
		);
		const detailCards = Array.from(
			container.querySelectorAll<HTMLElement>('[data-toc^="stop-detail-"]'),
		);
		expect(detailCards).toHaveLength(3);
		for (const card of detailCards) {
			expect(card.querySelector('[data-section-trigger]')).toHaveAttribute('aria-expanded', 'true');
		}
		const focus = screen.getByTestId('sections-toggle');
		await fireEvent.click(focus);
		await waitFor(() => {
			for (const card of detailCards) {
				expect(card.querySelector('[data-section-trigger]')).toHaveAttribute(
					'aria-expanded',
					'false',
				);
			}
		});

		await fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
		expect(container.querySelector('[data-slot="detail-shell-toolbar"]')).toContainElement(tabs);
		const scheduleCard = container.querySelector(
			'[data-toc="stop-schedule-service"]',
		) as HTMLElement;
		expect(scheduleCard.querySelector('[data-section-trigger]')).toHaveAttribute(
			'aria-expanded',
			'false',
		);

		await fireEvent.click(screen.getByRole('tab', { name: 'Live now' }));
		for (const card of detailCards) {
			expect(card.querySelector('[data-section-trigger]')).toHaveAttribute(
				'aria-expanded',
				'false',
			);
		}

		await fireEvent.click(screen.getByRole('tab', { name: 'Record' }));
		expect(container.querySelector('[data-slot="detail-shell-toolbar"]')).toContainElement(tabs);
		expect(container.querySelector('[data-slot="reliability-pane"]')).not.toBeNull();
	});

	it('uses the shared connected section stack for Detail and Schedule cards', async () => {
		stopFileData = {
			...STOP_FILE,
			scheduled: [{ route: '51', headsign: 'Nord', times: ['08:00'] }],
		} as unknown as StopFile;
		const { container } = render(StopDetail, { props: { id: '57191' } });
		const detailStack = container.querySelector(
			'[data-slot="article-section-stack"]',
		) as HTMLElement;
		const detailCards = Array.from(detailStack?.children ?? []);

		expect(detailStack).not.toBeNull();
		expect(detailCards).toHaveLength(3);
		for (const card of detailCards) {
			expect(card.matches('[data-slot="card"].section-card[data-toc^="stop-detail-"]')).toBe(true);
			expect(card.querySelector('[data-section-trigger]')).not.toBeNull();
		}

		await fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
		const scheduleStack = container.querySelector(
			'[data-slot="article-section-stack"][data-section-sequence="stop-schedule"]',
		) as HTMLElement;
		const scheduleCards = Array.from(scheduleStack?.children ?? []);

		expect(scheduleCards).toHaveLength(1);
		expect(
			scheduleCards[0]?.matches(
				'[data-slot="card"].section-card[data-toc="stop-schedule-service"]',
			),
		).toBe(true);
		expect(scheduleCards[0]?.querySelector('[data-section-trigger]')).not.toBeNull();
	});

	it('renders article navigation that follows the active Detail and Schedule sections', async () => {
		const { container } = render(StopDetail, { props: { id: '57191' } });
		const rail = container.querySelector('[data-slot="detail-shell-left"]') as HTMLElement;

		expect(within(rail).getByRole('button', { name: 'On this page' })).toBeInTheDocument();
		expect(
			within(rail).getByRole('button', { name: 'Predictions at this stop' }),
		).toBeInTheDocument();
		expect(within(rail).getByRole('button', { name: 'Stop information' })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
		expect(
			within(rail).getByRole('button', { name: 'Sample weekday schedule' }),
		).toBeInTheDocument();
	});

	it('preserves a manual facts-card choice across a tab round-trip', async () => {
		const { container } = render(StopDetail, { props: { id: '57191' } });
		const headerContent = container.querySelector('.header__content') as HTMLElement;
		const actionRow = container.querySelector('[data-slot="article-header-actions"]');
		const controlRow = container.querySelector('[data-slot="article-header-controls"]');
		const factsCard = container.querySelector('[data-toc="stop-detail-facts"]') as HTMLElement;
		const trigger = within(factsCard).getByRole('button', { name: /Stop information/ });

		expect(actionRow).not.toBeNull();
		expect(actionRow?.querySelector('a')).not.toBeNull();
		expect(controlRow).toContainElement(screen.getByTestId('sections-controls'));
		// yesid.design 0.45.0: actions and controls share one row group, the header's last child.
		const acts = controlRow?.closest('[data-slot="article-header-acts"]');
		expect(acts?.parentElement).toBe(headerContent);
		expect(acts).toContainElement(actionRow as HTMLElement);
		expect(Array.from(acts!.children).at(-1)).toBe(controlRow);
		expect(Array.from(headerContent.children).at(-1)).toBe(acts);

		await fireEvent.click(trigger);
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
		expect(screen.getByTestId('sections-toggle')).toBeVisible();
		await fireEvent.click(screen.getByRole('tab', { name: 'Live now' }));
		expect(trigger).toHaveAttribute('aria-expanded', 'false');
	});

	it('applies the bulk choice when the stop id changes in place', async () => {
		const view = render(StopDetail, { props: { id: '57191' } });
		const firstCard = view.container.querySelector('[data-toc="stop-detail-facts"]') as HTMLElement;

		await fireEvent.click(within(firstCard).getByRole('button', { name: /Stop information/ }));
		expect(within(firstCard).getByRole('button', { name: /Stop information/ })).toHaveAttribute(
			'aria-expanded',
			'false',
		);
		await view.rerender({ id: 'NEW', seed: { id: 'NEW', name: 'New stop' } });

		const nextCard = view.container.querySelector('[data-toc="stop-detail-facts"]') as HTMLElement;
		expect(nextCard).not.toBe(firstCard);
		expect(within(nextCard).getByRole('button', { name: /Stop information/ })).toHaveAttribute(
			'aria-expanded',
			'true',
		);
	});
});

describe('StopDetail retained-history ownership', () => {
	it('keeps the default singleton surface intact and loads no retained partition', async () => {
		const view = render(StopDetail, { props: { id: '57191' } });

		expect(getStopSpy).toHaveBeenCalledWith('57191');
		expect(getStopReliabilitySpy).toHaveBeenCalledWith('57191');
		await fireEvent.click(screen.getByRole('tab', { name: 'Record' }));
		const pane = view.container.querySelector('[data-slot="reliability-pane"]') as HTMLElement;
		expect(pane).not.toBeNull();
		expect(within(pane).getByText('Week')).toBeInTheDocument();
		expect(within(pane).getByText('79%')).toBeInTheDocument();
		expect(stopHistoryHarness.loadStopHistoryRange).not.toHaveBeenCalled();

		await waitFor(() => expect(stopHistoryHarness.getStopHistoryIndex).toHaveBeenCalledOnce());
		expect(stopHistoryHarness.getStopHistoryDirectory).not.toHaveBeenCalled();
	});

	it('keeps discovery on the raw awkward stop id and aborts stale ownership on id changes', async () => {
		stopHistoryHarness.getStopHistoryIndex.mockImplementation(() => new Promise(() => undefined));
		const view = render(StopDetail, { props: { id: 'A/B ?#' } });

		await waitFor(() => expect(stopHistoryHarness.getStopHistoryIndex).toHaveBeenCalledOnce());
		const firstCall = stopHistoryHarness.getStopHistoryIndex.mock.calls[0];
		const firstContext = firstCall?.[1] as { signal: AbortSignal } | undefined;
		expect(firstCall?.[0]).toBe('A/B ?#');
		expect(firstContext?.signal.aborted).toBe(false);
		expect(stopHistoryHarness.getStopHistoryDirectory).not.toHaveBeenCalled();
		expect(stopHistoryHarness.loadStopHistoryRange).not.toHaveBeenCalled();

		await view.rerender({ id: 'NEXT/STOP' });
		await waitFor(() => expect(stopHistoryHarness.getStopHistoryIndex).toHaveBeenCalledTimes(2));
		expect(firstContext?.signal.aborted).toBe(true);
		expect(stopHistoryHarness.getStopHistoryIndex.mock.calls[1]?.[0]).toBe('NEXT/STOP');

		const secondContext = stopHistoryHarness.getStopHistoryIndex.mock.calls[1]?.[1] as
			| { signal: AbortSignal }
			| undefined;
		view.unmount();
		expect(secondContext?.signal.aborted).toBe(true);
	});

	it('keeps retained query parameters out of line links', async () => {
		stopDetailNav.page.url = new URL(
			'http://localhost/stop/57191?tab=reliability&grain=day&from=2026-01-31&to=2026-02-01',
		);
		const view = render(StopDetail, { props: { id: '57191' } });

		await waitFor(() =>
			expect(view.container.querySelector('[data-slot="stop-by-route"]')).not.toBeNull(),
		);
		const lineLinks = view.container.querySelectorAll<HTMLAnchorElement>('a[href^="/lines/"]');
		expect(lineLinks.length).toBeGreaterThan(0);
		for (const link of lineLinks) {
			const url = new URL(link.href);
			expect(url.search).toBe('');
			expect(url.hash).toBe('');
		}
	});
});

describe('StopDetail retained-history singleton boundary', () => {
	it('keeps a habits-only current singleton visible without an explicit retained range', async () => {
		reliabilityData = HABITS_ONLY_RELIABILITY;
		const view = render(StopDetail, { props: { id: '57191' } });

		await fireEvent.click(screen.getByRole('tab', { name: 'Record' }));
		const habits = view.container.querySelector('[data-slot="stop-habits"]');
		expect(habits).not.toBeNull();
		expect(
			within(articleCardFor(habits)).getByRole('button', {
				name: 'Relative severe-delay score by hour',
			}),
		).toBeInTheDocument();
		expect(stopHistoryHarness.loadStopHistoryRange).not.toHaveBeenCalled();
	});

	it('preserves current habits while an explicit retained range loads', async () => {
		reliabilityData = HABITS_ONLY_RELIABILITY;
		stopDetailNav.page.url = new URL(
			'http://localhost/stop/57191?tab=reliability&from=2026-01-31&to=2026-02-01',
		);
		stopHistoryHarness.getStopHistoryIndex.mockResolvedValue(STOP_HISTORY_INDEX);
		stopHistoryHarness.loadStopHistoryRange.mockImplementation(() => new Promise(() => undefined));
		const view = render(StopDetail, { props: { id: '57191' } });

		await waitFor(() => expect(stopHistoryHarness.loadStopHistoryRange).toHaveBeenCalledOnce());
		const habits = view.container.querySelector('[data-slot="stop-habits"]');
		expect(habits).not.toBeNull();
		expect(
			within(articleCardFor(habits)).getByRole('button', {
				name: 'Relative severe-delay score by hour',
			}),
		).toBeInTheDocument();
	});

	it.each([
		['settled null', null],
		['settled field-empty', FIELD_EMPTY_RELIABILITY],
	] as const)(
		'keeps the existing ResourceBoundary empty for a default %s singleton',
		async (_, value) => {
			reliabilityData = value;
			const view = render(StopDetail, { props: { id: '57191' } });

			await fireEvent.click(screen.getByRole('tab', { name: 'Record' }));
			await waitFor(() =>
				expect(
					view.container.querySelector('[data-slot="edge-state"][data-variant="empty"]'),
				).not.toBeNull(),
			);
			expect(view.container.querySelector('.stop-reliability')).toBeNull();
			expect(stopHistoryHarness.loadStopHistoryRange).not.toHaveBeenCalled();
		},
	);

	it.each([
		['null', null],
		['field-empty', FIELD_EMPTY_RELIABILITY],
	] as const)(
		'mounts StopReliabilitySurface for an explicit retained range over a %s singleton',
		async (_, value) => {
			reliabilityData = value;
			stopDetailNav.page.url = new URL(
				'http://localhost/stop/57191?tab=reliability&from=2026-01-31&to=2026-02-01',
			);
			stopHistoryHarness.getStopHistoryIndex.mockResolvedValue(STOP_HISTORY_INDEX);
			stopHistoryHarness.loadStopHistoryRange.mockImplementation(
				() => new Promise(() => undefined),
			);
			const view = render(StopDetail, { props: { id: '57191' } });

			await waitFor(() => expect(stopHistoryHarness.getStopHistoryIndex).toHaveBeenCalledOnce());
			await waitFor(() => expect(stopHistoryHarness.loadStopHistoryRange).toHaveBeenCalledOnce());
			expect(view.container.querySelector('.stop-reliability')).not.toBeNull();
		},
	);

	it('does not let retained discovery bypass a pending singleton boundary', async () => {
		reliabilityData = null;
		reliabilityResourceState = { data: null, error: null, loading: true, settled: false };
		stopDetailNav.page.url = new URL(
			'http://localhost/stop/57191?tab=reliability&from=2026-01-31&to=2026-02-01',
		);
		stopHistoryHarness.getStopHistoryIndex.mockResolvedValue(STOP_HISTORY_INDEX);
		stopHistoryHarness.loadStopHistoryRange.mockImplementation(() => new Promise(() => undefined));
		const view = render(StopDetail, { props: { id: '57191' } });

		await waitFor(() => expect(stopHistoryHarness.getStopHistoryIndex).toHaveBeenCalledOnce());
		await waitFor(() => expect(stopHistoryHarness.loadStopHistoryRange).toHaveBeenCalledOnce());
		expect(view.container.querySelector('[data-variant="skeleton"]')).not.toBeNull();
		expect(view.container.querySelector('.stop-reliability')).toBeNull();
	});

	it('does not let retained discovery bypass a singleton error or its retry action', async () => {
		reliabilityData = null;
		reliabilityResourceState = {
			data: null,
			error: new Error('singleton unavailable'),
			loading: false,
			settled: true,
		};
		stopDetailNav.page.url = new URL(
			'http://localhost/stop/57191?tab=reliability&from=2026-01-31&to=2026-02-01',
		);
		stopHistoryHarness.getStopHistoryIndex.mockResolvedValue(STOP_HISTORY_INDEX);
		stopHistoryHarness.loadStopHistoryRange.mockImplementation(() => new Promise(() => undefined));
		const view = render(StopDetail, { props: { id: '57191' } });

		await waitFor(() => expect(stopHistoryHarness.getStopHistoryIndex).toHaveBeenCalledOnce());
		await waitFor(() => expect(stopHistoryHarness.loadStopHistoryRange).toHaveBeenCalledOnce());
		const error = await screen.findByRole('alert');
		expect(error).toHaveTextContent('Data unavailable');
		expect(view.container.querySelector('.stop-reliability')).toBeNull();

		await fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
		expect(reliabilityReloadSpy).toHaveBeenCalledOnce();
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

describe('StopDetail reliability — grain picker', () => {
	it.each([
		['en', 'Week'],
		['fr', 'Semaine'],
	] as const)('localizes the reliability card grain heading in %s', (locale, heading) => {
		renderReliability(locale);
		const pane = document.querySelector('[data-slot="reliability-pane"]') as HTMLElement;
		expect(pane).not.toBeNull();
		expect(within(pane).getByText(heading)).toBeInTheDocument();
		expect(within(pane).queryByText('day')).not.toBeInTheDocument();
	});
});

describe('StopDetail reliability — habits heatmap', () => {
	it('renders the habits heatmap when the matrix carries data', () => {
		const { container } = renderReliability();

		const habitsTile = container.querySelector('[data-slot="stop-habits"]') as HTMLElement;
		expect(
			within(articleCardFor(habitsTile)).getByRole('button', {
				name: 'Relative severe-delay score by hour',
			}),
		).toBeInTheDocument();
		expect(
			within(habitsTile).getByRole('figure', {
				name: 'Relative score within this stop, by day and hour',
			}),
		).toBeInTheDocument();
	});

	it('renders NO heatmap (not a fabricated grid) when habits is absent', () => {
		reliabilityData = { ...RELIABILITY, habits: null };
		renderReliability();

		expect(screen.queryByText('Relative severe-delay score by hour')).not.toBeInTheDocument();
	});
});

describe('StopDetail reliability — crowding (occupancy_mix)', () => {
	it('renders the occupancy proportion bar when occupancy_mix is present', () => {
		renderReliability();

		const crowding = document.querySelector('[data-slot="stop-crowding"]') as HTMLElement;
		expect(crowding).not.toBeNull();
		expect(
			within(articleCardFor(crowding)).getByRole('button', {
				name: 'Crowding on vehicles seen here',
			}),
		).toBeInTheDocument();
		expect(
			within(crowding).getByText(/How full the vehicles observed at this stop ran/),
		).toBeInTheDocument();
		expect(
			within(crowding).getByRole('figure', {
				name: /Occupancy mix of vehicles observed at this stop/,
			}),
		).toBeInTheDocument();
		expect(within(crowding).getAllByText('45%').length).toBeGreaterThan(0);
		expect(within(crowding).getAllByText('Standing').length).toBeGreaterThan(0);
	});

	it.each([
		['null EN', 'en', null],
		['undefined', 'en', undefined],
		['all-zero', 'en', { empty: 0, many_seats: 0, few_seats: 0, standing: 0, full: 0 }],
		['null FR', 'fr', null],
	] as const)('leaves crowding out when none is published: %s', (_, locale, mix) => {
		reliabilityData = { ...RELIABILITY, occupancy_mix: mix };
		renderReliability(locale);
		// No published mix: no card, no absent card, no contents entry (UX-T6.4).
		expect(document.querySelector('[data-slot="stop-crowding"]')).toBeNull();
		expect(document.querySelector('[data-slot="stop-crowding-empty"]')).toBeNull();
		expect(document.querySelector('#stop-rel-crowding')).toBeNull();
	});
});

describe('StopDetail reliability — occupancy-only stop is not gated out as empty', () => {
	it('renders the crowding section for a stop with ONLY occupancy_mix (no periods/dow/by_route)', () => {
		reliabilityData = {
			generated_utc: '2026-06-15T12:00:00Z',
			id: '57191',
			name: 'Test stop',
			periods: [],
			habits: null,
			day_of_week: [],
			by_route: [],
			occupancy_mix: { empty: 0.1, many_seats: 0.2, few_seats: 0.2, standing: 0.4, full: 0.1 },
		} as unknown as StopReliability;
		renderReliability();

		const crowding = document.querySelector('[data-slot="stop-crowding"]') as HTMLElement;
		expect(crowding).not.toBeNull();
		expect(
			within(articleCardFor(crowding)).getByRole('button', {
				name: 'Crowding on vehicles seen here',
			}),
		).toBeInTheDocument();
		expect(within(crowding).getAllByText('Standing').length).toBeGreaterThan(0);

		expect(document.querySelector('[data-slot="stop-reliability-pane"]')).toBeNull();
		expect(document.querySelector('[data-slot="reliability-pane"]')).toBeNull();
	});
});

describe('StopDetail reliability — by_route ranked bars', () => {
	it('ranks routes worst-delay first and drops rows with no delay', () => {
		renderReliability();

		expect(screen.getByText('12.5 min')).toBeInTheDocument();
		expect(screen.getByText('4.1 min')).toBeInTheDocument();

		const rows = screen.getAllByRole('listitem');
		const ranked = rows.filter((r) => within(r).queryByText(/min$/));
		const worstIdx = ranked.findIndex((r) => within(r).queryByText('12.5 min'));
		const milderIdx = ranked.findIndex((r) => within(r).queryByText('4.1 min'));
		expect(worstIdx).toBeGreaterThanOrEqual(0);
		expect(worstIdx).toBeLessThan(milderIdx);
	});
});

describe('StopDetail reliability — weekday seasonality (day_of_week)', () => {
	it('ranks weekdays worst-delay first and drops a null-mean weekday (no fake-0 row)', () => {
		renderReliability();

		const weekday = document.querySelector('[data-slot="stop-weekday"]') as HTMLElement;
		expect(weekday).not.toBeNull();
		expect(
			within(articleCardFor(weekday)).getByRole('button', { name: 'By day of week' }),
		).toBeInTheDocument();

		expect(within(weekday).getByText('Friday')).toBeInTheDocument();
		expect(within(weekday).getByText('Monday')).toBeInTheDocument();
		expect(within(weekday).getByText('Wednesday')).toBeInTheDocument();
		expect(within(weekday).queryByText('Sunday')).not.toBeInTheDocument();

		const list = within(weekday).getByRole('list', { name: 'By day of week' });
		const rows = within(list).getAllByRole('listitem');
		const friIdx = rows.findIndex((r) => within(r).queryByText('Friday'));
		const monIdx = rows.findIndex((r) => within(r).queryByText('Monday'));
		expect(friIdx).toBeGreaterThanOrEqual(0);
		expect(friIdx).toBeLessThan(monIdx);
		expect(within(weekday).queryByText('0.0 min')).not.toBeInTheDocument();
	});

	it('gates the severe share on observation count (under-sampled weekday withheld)', () => {
		renderReliability();

		const weekday = document.querySelector('[data-slot="stop-weekday"]') as HTMLElement;
		expect(within(weekday).getByText('Severe-delay share 5.0%')).toBeInTheDocument();
		expect(within(weekday).queryByText('Severe-delay share 18.2%')).not.toBeInTheDocument();
		expect(within(weekday).getAllByText('Avg delay').length).toBeGreaterThan(0);
		expect(
			within(weekday).getByText(/Trailing-window, observation-weighted estimate/),
		).toBeInTheDocument();
	});

	it.each([
		['absent', undefined],
		[
			'null means',
			[
				{ day_of_week_iso: 2, avg_delay_min: null, severe_pct: null, observation_count: 0 },
				{ day_of_week_iso: 6, avg_delay_min: null, severe_pct: 4.0, observation_count: 0 },
			],
		],
	] as const)('stands the weekday section down for %s', (_, rows) => {
		reliabilityData = { ...RELIABILITY, day_of_week: rows ? [...rows] : undefined };
		renderReliability();
		expect(document.querySelector('[data-slot="stop-weekday"]')).toBeNull();
		if (rows === undefined) expect(screen.queryByText('By day of week')).not.toBeInTheDocument();
	});

	it('localizes weekday names in FR (Vendredi, not the ISO integer or EN name)', () => {
		renderReliability('fr');

		const weekday = document.querySelector('[data-slot="stop-weekday"]') as HTMLElement;
		expect(weekday).not.toBeNull();
		expect(
			within(articleCardFor(weekday)).getByRole('button', { name: 'Par jour de la semaine' }),
		).toBeInTheDocument();
		expect(within(weekday).getByText('Vendredi')).toBeInTheDocument();
		expect(within(weekday).getByText('Lundi')).toBeInTheDocument();
		expect(within(weekday).queryByText('Friday')).not.toBeInTheDocument();
		expect(within(weekday).queryByText('5')).not.toBeInTheDocument();
	});
});

describe('StopDetail reliability — by time of day (shift + day-type grains)', () => {
	it('renders the by-time-of-day shift list + weekday/weekend comparison when present', () => {
		reliabilityData = RELIABILITY_WITH_TOD;
		renderReliability();

		const tod = document.querySelector('[data-slot="stop-time-of-day"]') as HTMLElement;
		expect(tod).not.toBeNull();
		expect(
			within(articleCardFor(tod)).getByRole('button', { name: 'By time of day' }),
		).toBeInTheDocument();
		expect(within(tod).getByText('Weekday vs weekend')).toBeInTheDocument();

		expect(within(tod).getByText('PM peak')).toBeInTheDocument();
		expect(within(tod).getByText('AM peak')).toBeInTheDocument();
		expect(within(tod).getByText('Weekday')).toBeInTheDocument();
		expect(within(tod).getByText('Weekend')).toBeInTheDocument();

		const shiftList = within(tod).getByRole('list', { name: 'By time of day' });
		const shiftRows = within(shiftList).getAllByRole('listitem');
		const pmIdx = shiftRows.findIndex((r) => within(r).queryByText('PM peak'));
		const amIdx = shiftRows.findIndex((r) => within(r).queryByText('AM peak'));
		expect(pmIdx).toBeGreaterThanOrEqual(0);
		expect(pmIdx).toBeLessThan(amIdx);

		expect(within(tod).queryByText('Night')).not.toBeInTheDocument();
		expect(
			within(tod).getByText(/Trailing-window, observation-weighted estimate/),
		).toBeInTheDocument();
	});

	it('stands the whole section down when the stop carries no shift/day-type grains', () => {
		renderReliability();

		expect(document.querySelector('[data-slot="stop-time-of-day"]')).toBeNull();
		expect(screen.queryByText('By time of day')).not.toBeInTheDocument();
	});

	it('drops an avg-only (severe-null) shift period — partition + ranker stay in lock-step', () => {
		reliabilityData = {
			...RELIABILITY,
			periods: [
				...RELIABILITY.periods!,
				{ grain: 'am_peak', otp_pct: 70, avg_delay_min: 6.4, severe_pct: null },
				{ grain: 'midday', otp_pct: 91, avg_delay_min: 1.4, severe_pct: 3 },
			],
		} as StopReliability;
		renderReliability();

		const tod = document.querySelector('[data-slot="stop-time-of-day"]') as HTMLElement;
		expect(tod).not.toBeNull();
		expect(within(tod).queryByText('AM peak')).not.toBeInTheDocument();
		expect(within(tod).queryByText('6.4 min')).not.toBeInTheDocument();
		expect(within(tod).getByText('Midday')).toBeInTheDocument();
		expect(within(tod).getByText('3.0%')).toBeInTheDocument();
	});

	it('keeps the GrainPicker calendar-only even when shift grains are present', () => {
		reliabilityData = RELIABILITY_WITH_TOD;
		renderReliability();

		const group = screen.getAllByRole('radiogroup', { name: 'Roll-up period' })[0];
		const radios = within(group).getAllByRole('radio');
		expect(radios.map((r) => r.textContent?.trim())).toEqual(['Week', 'Day', 'Month']);
		for (const token of [
			'AM peak',
			'PM peak',
			'Midday',
			'Evening',
			'Night',
			'Weekday',
			'Weekend',
		]) {
			expect(within(group).queryByRole('radio', { name: token })).toBeNull();
		}
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
				`▲${t.bands.late}`,
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
				locale === 'en' ? '/stop/57191' : '/fr/stop/57191',
			);
		},
	);

	it('names both statuses a rounded minute can stand for, with a shape only for one', () => {
		liveStore.index.byStopId.set('57191', [
			{ eta_utc: '2026-06-15T12:05:00Z', route: '51', delay_min: 1 },
			{ eta_utc: '2026-06-15T12:06:00Z', route: '51', delay_min: 6 },
			{ eta_utc: '2026-06-15T12:07:00Z', route: '80', delay_min: null },
		] as StopDeparture[]);
		render(StopDetail, { props: { id: '57191' } });
		const statuses = [...predictions().querySelectorAll('tbody td:first-of-type')];
		expect(statuses.map((cell) => cell.textContent?.trim()).slice(0, 2)).toEqual([
			'On time or late',
			'■5+ min late',
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

describe('StopDetail schedule — semantic timetable + honest gaps', () => {
	it('renders route, destination and departures in one scoped schedule table', async () => {
		stopFileData = {
			...STOP_FILE,
			scheduled: [
				{
					route: '51',
					headsign: 'Nord',
					times: ['08:00', '08:10', '08:20', '08:30', '08:40', '08:50'],
				},
			],
		} as unknown as StopFile;
		const { container } = render(StopDetail, { props: { id: '57191' } });
		await fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
		const table = screen.getByRole('table', { name: 'Sample weekday times by line' });
		expect(within(table).getByRole('columnheader', { name: 'Line' })).toBeInTheDocument();
		expect(within(table).getByRole('columnheader', { name: 'Destination' })).toBeInTheDocument();
		expect(within(table).getByRole('columnheader', { name: 'Departures' })).toBeInTheDocument();
		expect(within(table).getByText('51')).toBeInTheDocument();
		expect(within(table).getByText('Nord')).toBeInTheDocument();
		expect(container.querySelectorAll('.stop-schedule-time time')).toHaveLength(6);
	});

	it('states an honest per-route absence inside the route table row', async () => {
		stopFileData = {
			...STOP_FILE,
			scheduled: [{ route: '99', headsign: 'Vide', times: [] }],
		} as unknown as StopFile;
		const { container } = render(StopDetail, { props: { id: '57191' } });
		await fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
		const table = screen.getByRole('table', { name: 'Sample weekday times by line' });
		expect(container.querySelector('.stop-schedule-times')).toBeNull();
		const row = table.querySelector('tbody tr') as HTMLElement;
		expect(row).toHaveTextContent('99');
		expect(row.querySelector('[data-slot="absent-value"]')).not.toBeNull();
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
