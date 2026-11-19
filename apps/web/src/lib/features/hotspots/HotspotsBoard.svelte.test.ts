import { render, screen, within, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HotspotEntry, Hotspots, IsoUtc, Manifest } from '#lib/v1/schemas/index.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { localizeHref } from '#lib/i18n/routing.ts';
import { stampCopy } from '#lib/v1/stamp.copy.ts';
import { formatDateKey } from '#lib/utils/time.ts';

let mockUrl = new URL('http://localhost/hotspots');
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return mockUrl;
		},
		state: {},
	},
}));
vi.mock('$app/navigation', () => ({
	afterNavigate: () => {},
	goto: vi.fn(),
	replaceState: vi.fn((url: string | URL) => {
		mockUrl = new URL(url, 'http://localhost');
	}),
}));

const currentLocale = vi.hoisted(() => ({ value: 'en' as 'en' | 'fr' }));
vi.mock('#lib/i18n/index.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/i18n/index.ts')>();
	return { ...actual, getLocale: () => currentLocale.value };
});

const { payload } = vi.hoisted(() => ({ payload: { current: null as Hotspots | null } }));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getHotspots: vi.fn(),
	getHotspotsHistoryIndex: vi.fn(),
	getHotspotsHistoryDay: vi.fn(),
}));
vi.mock('#lib/v1/history/dateResource.svelte.ts', () => ({
	historyDateRequestFromSearchParams: vi.fn(() => ({ hasDate: false, rawDate: null })),
	createHistoryDateResource: vi.fn(() => ({
		request: { hasDate: false, rawDate: null },
		index: null,
		// Discovery has settled with no retained history.
		resolved: { canonicalDate: null, selection: null, correction: null },
		availableDates: [],
		selectedDate: null,
		canonicalDate: null,
		previousDate: null,
		nextDate: null,
		correction: null,
		mode: 'current',
		state: 'current',
		value: payload.current,
		data: payload.current,
		error: null,
		loading: false,
		settled: true,
		setRequest: vi.fn(),
		retry: vi.fn(),
		reload: vi.fn(),
		destroy: vi.fn(),
	})),
}));
vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: () => ({
		data: null,
		error: null,
		loading: false,
		settled: true,
		reload: vi.fn(),
	}),
}));

import HotspotsBoard from './HotspotsBoard.svelte';
import { TRAY_CAP } from './selectors/hotspotRanking';
import { createHistoryDateResource } from '#lib/v1/history/dateResource.svelte.ts';

// fr-CA puts a no-break space before the percent sign.
const NB = String.fromCharCode(0xa0);
const BAYSHORE = 'Bayshore / Carlingwood <> Dunrobin / Carp / Stittsville';

/** A ranked row as the publisher writes it; the share follows from its counts. */
function row(
	kind: 'route' | 'stop',
	rank: number,
	id: string,
	name: string,
	readings: number,
	late: number,
) {
	return {
		rank,
		type: kind,
		id,
		name,
		observation_count: readings,
		severe_count: late,
		severe_pct: Math.round((1000 * late) / readings) / 10,
		// The publisher orders by this bound, ascending.
		wilson_lo: 5 * rank,
		wilson_hi: 5 * rank + 10,
	} satisfies HotspotEntry;
}

/** M5's captured week, plus `extra` generated lines after the first five. */
function seed(extra = 0): Hotspots {
	return {
		generated_utc: '2026-11-11T09:00:00Z' as IsoUtc,
		methodology_version: 'r2',
		hotspots: [],
		by_grain: [
			{
				grain: 'week',
				date: '2026-11-04',
				window_end: '2026-11-10',
				entries: [
					row('route', 1, '303', BAYSHORE, 173, 147),
					row('route', 2, '301', 'Bayshore / Carlingwood <> Richmond / Stittsville', 185, 156),
					row('route', 3, '305', 'Carlingwood <> North Gower / Manotick', 127, 96),
					row('route', 4, '302', 'St. Laurent / Place D’Orléans <> Cumberland', 120, 65),
					row('route', 5, '646', 'Canterbury H.S <> Terry Fox', 118, 65),
					...Array.from({ length: extra }, (_, i) =>
						row('route', 6 + i, `9${i}`, `Generated ${i}`, 60, 20),
					),
					row('stop', 1, '3060', 'Main / Mill', 64, 60),
					row('stop', 2, '3061', 'Manotick Main / Currier', 47, 40),
				],
				tray: [
					{
						type: 'stop',
						id: '5581',
						name: 'Doctor Leach / Ad. 5581',
						observation_count: 2,
						severe_pct: 50,
					},
				],
				total_ranked_routes: 173,
				total_ranked_stops: 4930,
				tray_total: 1,
			},
		],
	};
}

function context(provider = 'octranspo') {
	return new Map<unknown, unknown>([
		[
			Symbol.for('transit.line-directory'),
			() =>
				createLineDirectory(
					['303', '301', '305', '302', '646'].map((id) => ({ id, short: id })),
					{ line: (id) => `Line ${id}` },
				),
		],
		[
			Symbol.for('transit.i18n.href'),
			(href: string, lang: 'en' | 'fr') => localizeHref(href, lang, provider),
		],
	]);
}

const manifest = {
	provider: 'octranspo',
	display_name: 'OC Transpo',
	files: {},
} as unknown as Manifest;

function show(data = seed(), url = 'http://localhost/hotspots') {
	payload.current = data;
	mockUrl = new URL(url);
	return render(HotspotsBoard, { props: { manifest }, context: context() });
}

const rowButtons = () =>
	within(screen.getByRole('list', { name: /^(Lines|Stops|Lignes|Arrêts)$/ })).getAllByRole(
		'button',
	);

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
	currentLocale.value = 'en';
	writeText.mockClear();
	vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
});
afterEach(() => vi.unstubAllGlobals());

describe('HotspotsBoard', () => {
	it('names the first-ranked line for its complete period and measure', () => {
		const { container } = show();

		expect(
			screen.getByRole('heading', { level: 2, name: `First-ranked line: 303, ${BAYSHORE}.` }),
		).toBeInTheDocument();
		expect(container.querySelector('[data-slot="hotspots-period"]')).toHaveTextContent(
			'November 4 to 10, 2026, 7 complete days.',
		);
		expect(screen.getByText('Share of readings more than 5 minutes late.')).toBeInTheDocument();
		expect(
			screen.getByText('Lines and stops to investigate in the published record.'),
		).toBeInTheDocument();
	});

	it('keeps the published order, even where a lower share ranks higher', () => {
		const { container } = show();

		const shares = [
			...container.querySelectorAll('[data-slot="hotspot-rows"] [data-slot="ranking-rate"]'),
		].map((node) => node.textContent?.trim());
		expect(shares).toEqual(['85%', '84.3%', '75.6%', '54.2%', '55.1%']);
		expect(rowButtons()[0]).toHaveAccessibleName(
			`Position 1 of 173. Line 303, ${BAYSHORE}. 85% of readings more than 5 minutes late. 173 readings.`,
		);
		expect(container.querySelector('[data-slot="hotspot-count"]')).toHaveTextContent(
			'Showing 5 of 173 eligible lines. This record publishes the first 5.',
		);
	});

	it('shows the first ten rows, then every published row and never more', async () => {
		show(seed(7));

		expect(rowButtons()).toHaveLength(10);
		expect(
			screen.getByText('Showing 10 of 173 eligible lines. This record publishes the first 12.'),
		).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Show all 12 published lines' }));
		expect(rowButtons()).toHaveLength(12);
		expect(
			screen.getByText('Showing 12 of 173 eligible lines. This record publishes the first 12.'),
		).toBeInTheDocument();
		await waitFor(() => expect(mockUrl.searchParams.get('n')).toBe('all'));
		await fireEvent.click(screen.getByRole('button', { name: 'Show the first 10' }));
		expect(rowButtons()).toHaveLength(10);
	});

	it('keeps unpublished figures absent, never a reassuring zero', () => {
		const data = seed();
		const week = data.by_grain![0];
		week.entries![1] = {
			...week.entries![1],
			severe_count: null,
			severe_pct: null,
			observation_count: null,
		};
		week.entries![2] = { ...week.entries![2], severe_count: 0, severe_pct: 0 };
		week.total_ranked_routes = null;
		week.tray_total = null;
		const { container } = show(data);

		const rows = container.querySelectorAll('[data-slot="hotspot-rows"] > li');
		expect(rows[1]).toHaveTextContent('Late share not published');
		expect(rows[1]).toHaveTextContent('Reading count not published');
		expect(rows[2].querySelector('[data-slot="ranking-rate"]')).toHaveTextContent('0%');
		expect(container.querySelector('[data-slot="hotspot-count"]')).toHaveTextContent(
			'Showing 5 of 5 published lines. The number of eligible lines is not published.',
		);
		expect(container.querySelector('[data-slot="hotspot-floor-total"]')).toHaveTextContent(
			'Total not published.',
		);
		expect(screen.getByText('No live data').nextElementSibling).toHaveTextContent(
			'Total not published.',
		);
	});

	it('never draws an interval beside the late share', async () => {
		const data = seed();
		// A 90% late share next to complementary 5 to 15% bounds of the on-time share.
		data.by_grain![0].entries![0] = {
			...row('route', 1, '303', BAYSHORE, 100, 90),
			wilson_lo: 5,
			wilson_hi: 15,
		};
		const { container } = show(data);
		await fireEvent.click(rowButtons()[0]);

		const page = container.querySelector('[data-slot="hotspots-page"]')!.textContent!;
		expect(page).not.toMatch(/\b(5|15|85|95)(\.\d)?\s*%/);
		expect(page).not.toMatch(/CI|IC à/);
		expect(
			screen.getAllByText(
				'An uncertainty range for this late share is not published in this record.',
			).length,
		).toBeGreaterThan(0);
	});

	it('opens evidence in place with record links and a citation that keep the dates and provider', async () => {
		const { container } = show();

		const first = rowButtons()[0];
		expect(first).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(first);
		expect(first).toHaveAttribute('aria-expanded', 'true');
		const inline = container.querySelector(
			'[data-slot="hotspot-row-evidence"]:not([hidden])',
		) as HTMLElement;
		expect(
			within(inline).getByRole('heading', { level: 3, name: 'Selected record' }),
		).toBeInTheDocument();
		expect(inline).toHaveTextContent('Position 1 of 173');
		expect(inline).toHaveTextContent('173 readings');
		expect(inline).toHaveTextContent('November 4 to 10, 2026, 7 complete days.');
		expect(inline).toHaveTextContent('Method version: r2.');
		expect(
			within(inline).getByRole('link', { name: `Open record: Line 303, ${BAYSHORE}` }),
		).toHaveAttribute('href', '/lines/303?from=2026-11-04&to=2026-11-10&provider=octranspo');
		await waitFor(() => expect(mockUrl.searchParams.get('selected')).toBe('303'));

		await fireEvent.click(within(inline).getByRole('button', { name: 'Copy link' }));
		expect(writeText).toHaveBeenLastCalledWith(
			'http://localhost/hotspots?date=2026-11-10&selected=303&provider=octranspo',
		);
		await fireEvent.click(within(inline).getByRole('button', { name: 'Cite this record' }));
		expect(writeText).toHaveBeenLastCalledWith(
			`Transit. OC Transpo. Line 303, ${BAYSHORE}: 85% of readings more than 5 minutes late, November 4 to 10, 2026. 173 readings. Record published November 11, 2026. Method version: r2. http://localhost/hotspots?date=2026-11-10&selected=303&provider=octranspo`,
		);
		expect(await within(inline).findByText('Citation copied.')).toBeInTheDocument();

		await fireEvent.click(first);
		expect(first).toHaveAttribute('aria-expanded', 'false');
	});

	it('copies links to a row past the first ten that reopen on that row', async () => {
		const openEvidence = () =>
			document.querySelector('[data-slot="hotspot-row-evidence"]:not([hidden])') as HTMLElement;
		const first = show(seed(7), 'http://localhost/hotspots?n=all&selected=96');
		expect(openEvidence()).toHaveTextContent('Position 12 of 173');

		await fireEvent.click(within(openEvidence()).getByRole('button', { name: 'Copy link' }));
		const link = writeText.mock.lastCall![0];
		expect(link).toBe(
			'http://localhost/hotspots?date=2026-11-10&n=all&selected=96&provider=octranspo',
		);
		await fireEvent.click(within(openEvidence()).getByRole('button', { name: 'Cite this record' }));
		expect(writeText.mock.lastCall![0].endsWith(` ${link}`)).toBe(true);
		first.unmount();

		show(seed(7), link);
		expect(openEvidence()).toHaveTextContent('Position 12 of 173');
		expect(openEvidence()).toHaveTextContent('Generated 6');
	});

	it.each([
		['en', '0 readings'],
		['fr', '0 relevé'],
	] as const)('never shows a negative zero reading count in %s', async (locale, zero) => {
		currentLocale.value = locale;
		const data = seed();
		data.by_grain![0].tray = [
			{ type: 'stop', id: '5581', name: 'Doctor Leach', observation_count: -0 },
		];
		show(data, 'http://localhost/hotspots?kind=stops');

		const excluded = screen.getByRole('list', {
			name: locale === 'en' ? 'Published excluded stops' : 'Arrêts exclus publiés',
		});
		expect(excluded).toHaveTextContent(zero);
		expect(excluded.textContent).not.toMatch(/[-−]\s*0/);
	});

	it('switches to stops with their own finding, exclusions and record links', async () => {
		const { container } = show();

		await fireEvent.click(screen.getByRole('radio', { name: 'Stops' }));
		expect(
			screen.getByRole('heading', { level: 2, name: 'First-ranked stop: Main / Mill.' }),
		).toBeInTheDocument();
		await waitFor(() => expect(mockUrl.searchParams.get('kind')).toBe('stops'));
		expect(screen.getByRole('heading', { level: 2, name: 'Stops not ranked' })).toBeInTheDocument();
		expect(container.querySelector('[data-slot="hotspot-floor-total"]')).toHaveTextContent(
			'1 stop',
		);
		expect(screen.queryByText('No live data')).toBeNull();
		expect(
			screen.getByText('1 stop below the 30-reading floor, all listed below.'),
		).toBeInTheDocument();
		const excluded = screen.getByRole('list', { name: 'Published excluded stops' });
		expect(
			within(excluded).getByRole('link', { name: 'Stop Doctor Leach / Ad. 5581' }),
		).toHaveAttribute('href', '/stop/5581?from=2026-11-04&to=2026-11-10&provider=octranspo');
		// A below-floor row keeps its low-sample presentation: readings, never a share.
		expect(excluded).toHaveTextContent('2 readings');
		expect(excluded).not.toHaveTextContent('50');
	});

	it('reads the 30-day record with its own dates', async () => {
		const data = seed();
		data.by_grain!.push({
			...data.by_grain![0],
			grain: 'month',
			date: '2026-10-12',
			window_end: '2026-11-10',
			entries: [
				row('route', 1, '301', 'Bayshore / Carlingwood <> Richmond / Stittsville', 700, 500),
			],
			total_ranked_routes: 180,
		});
		const { container } = show(data);

		await fireEvent.click(screen.getByRole('radio', { name: '30 days' }));
		expect(container.querySelector('[data-slot="hotspots-period"]')).toHaveTextContent(
			'October 12 to November 10, 2026, 30 complete days.',
		);
		expect(
			screen.getByRole('heading', { level: 2, name: /^First-ranked line: 301, / }),
		).toBeInTheDocument();
		await waitFor(() => expect(mockUrl.searchParams.get('grain')).toBe('month'));
	});

	it('says when a period is not published and when a ranking fails its checks', () => {
		const data = seed();
		data.by_grain = [];
		const absent = show(data);
		expect(
			screen.getByRole('heading', {
				level: 2,
				name: 'The 7-day ranking is not published in this record.',
			}),
		).toBeInTheDocument();
		absent.unmount();

		const broken = seed();
		broken.by_grain![0].entries![0] = { ...broken.by_grain![0].entries![0], severe_count: 400 };
		const { container } = show(broken);
		expect(
			screen.getByRole('heading', {
				level: 2,
				name: 'This ranking failed its consistency checks, so it is not shown.',
			}),
		).toBeInTheDocument();
		expect(container.querySelector('[data-slot="hotspot-rows"]')).toBeNull();
	});

	it('reads the same record in French', async () => {
		currentLocale.value = 'fr';
		const { container } = show();

		expect(
			screen.getByRole('heading', {
				level: 2,
				name: `Ligne en tête du classement : 303, ${BAYSHORE}.`,
			}),
		).toBeInTheDocument();
		expect(container.querySelector('[data-slot="hotspots-period"]')).toHaveTextContent(
			'Du 4 au 10 novembre 2026, 7 jours complets.',
		);
		expect(
			container.querySelector('[data-slot="hotspot-rows"] [data-slot="ranking-rate"]')?.textContent,
		).toBe(`85${NB}%`);
		expect(container.querySelector('[data-slot="hotspot-count"]')).toHaveTextContent(
			'5 lignes affichées sur 173 admissibles. Ce bilan publie les 5 premières.',
		);
		await fireEvent.click(rowButtons()[0]);
		const inline = container.querySelector(
			'[data-slot="hotspot-row-evidence"]:not([hidden])',
		) as HTMLElement;
		await fireEvent.click(within(inline).getByRole('button', { name: 'Citer ce bilan' }));
		expect(writeText).toHaveBeenLastCalledWith(
			`Transit. OC Transpo. Ligne 303, ${BAYSHORE} : 85${NB}% des relevés en retard de plus de 5 minutes, du 4 au 10 novembre 2026. 173 relevés. Bilan publié le 11 novembre 2026. Version de la méthode : r2. http://localhost/fr/hotspots?date=2026-11-10&selected=303&provider=octranspo`,
		);
	});

	it('holds the loaded room with a hidden, inert gauge that links nowhere while the record loads', () => {
		const loaded = vi.mocked(createHistoryDateResource).getMockImplementation()!;
		vi.mocked(createHistoryDateResource).mockImplementationOnce((...args) => ({
			...loaded(...args),
			resolved: null,
			data: null,
			value: null,
			loading: true,
			settled: false,
			state: 'loading-current',
		}));
		const { container } = show();

		const gauges = [...container.querySelectorAll('.hotspots-gauge')];
		// The navigator's room and the record's room, each under its own gauge.
		expect(gauges).toHaveLength(2);
		for (const gauge of gauges) {
			expect(gauge).toHaveAttribute('aria-hidden', 'true');
			expect(gauge).toHaveAttribute('inert');
			// No record link: its rows name no real line or stop. Only the method's definition link.
			const links = [...gauge.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
			expect(links.every((href) => href!.startsWith('/metrics'))).toBe(true);
		}
		const record = container.querySelector('.hotspots-gauge.hotspots-record')!;
		// Its rows reserve the published cap: ten rows and the button that shows all.
		expect(record.querySelectorAll('[data-slot="hotspot-rows"] > li')).toHaveLength(10);
		// Every row below the floor the publisher can send, each with a link's box and no destination.
		expect(record.querySelectorAll('.hotspots-excluded li > a:not([href])')).toHaveLength(TRAY_CAP);
		expect(record.querySelector('[data-slot="hotspot-record-link"]')).not.toHaveAttribute('href');
		// Its dates only shape the period line: none reaches the page as a date.
		expect(record.querySelector('[data-slot="hotspots-period"]')).toHaveTextContent(
			'Mnnnnnnnn 00 nn 00, 0000, 0 nnnnnnnn nnnn.',
		);
		expect(record.textContent).not.toMatch(/September|2000/);
		// Readers see the skeleton and no row they could reach.
		expect(screen.queryByRole('list', { name: /^(Lines|Stops)$/ })).toBeNull();
		expect(container.querySelector('[data-slot="hotspots-page"]')).not.toHaveAttribute('style');
	});

	it('shows the record stamp without a publication time', async () => {
		const { container } = show();
		const header = container.querySelector('[data-slot="article-header"]') as HTMLElement;
		await waitFor(() =>
			expect(header).toHaveTextContent(
				stampCopy.en.record(null, formatDateKey('2026-11-11', 'en', true), 'window'),
			),
		);
		expect(header.querySelector('time')).toHaveAttribute('datetime', '2026-11-11');
	});
});
