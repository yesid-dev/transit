import { render, screen, within, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	RepeatOffendersSchema,
	type IsoUtc,
	type Manifest,
	type RepeatOffenderEntry,
	type RepeatOffenders as RepeatOffendersData,
} from '#lib/v1/schemas/index.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { localizeHref } from '#lib/i18n/routing.ts';
import { stampCopy } from '#lib/v1/stamp.copy.ts';
import { formatDateKey } from '#lib/utils/time.ts';

let mockUrl = new URL('http://localhost/repeat-offenders');
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

const { payload } = vi.hoisted(() => ({
	payload: { current: null as RepeatOffendersData | null },
}));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getRepeatOffenders: vi.fn(),
	getRepeatOffendersHistoryIndex: vi.fn(),
	getRepeatOffendersHistoryDay: vi.fn(),
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

import RepeatOffenders from './RepeatOffenders.svelte';

// fr-CA puts a no-break space before the percent sign.
const NB = String.fromCharCode(0xa0);

/**
 * A row as the publisher writes it: the share follows from its counts, and its Wilson bounds
 * (of the not-late share) hold the share's complement.
 */
function row(
	type: 'trip' | 'vehicle',
	rank: number | null,
	readings: number,
	late: number,
	over: Partial<RepeatOffenderEntry>,
): RepeatOffenderEntry {
	const pct = Math.round((1000 * late) / readings) / 10;
	return {
		rank,
		type,
		id: `${type}-${rank}`,
		route: '36',
		route_name: 'Monk',
		observation_count: readings,
		severe_count: late,
		severe_pct: pct,
		wilson_lo: Math.max(0, Math.round((100 - pct - 8) * 10) / 10),
		wilson_hi: Math.min(100, Math.round((100 - pct + 8) * 10) / 10),
		observed_days: 6,
		window_days: 7,
		...over,
	};
}

const departure = (time: string, headsign: string | null) => ({
	route_short_name: '36',
	departure_time: time,
	headsign,
});

/**
 * A week as the publisher writes it, current or retained: departure labels (#1080) and the
 * period's dates, plus `extra` generated trips after the first three.
 */
function seed(extra = 0): RepeatOffendersData {
	return {
		generated_utc: '2026-11-18T07:00:00Z' as IsoUtc,
		methodology_version: 'reliability-2',
		by_grain: [
			{
				grain: 'week',
				date: '2026-11-11',
				window_end: '2026-11-17',
				window_days: 7,
				entries: [
					row('trip', 1, 90, 60, {
						id: '302181941',
						...departure('07:42:00', 'Monk'),
						recurrence_days: 4,
						avg_delay_min: 18.4,
					}),
					row('trip', 2, 120, 45, {
						...departure('08:15:00', 'Monk'),
						recurrence_days: 3,
						observed_days: 5,
						avg_delay_min: 12.3,
					}),
					row('trip', 3, 45, 20, {
						...departure('17:05:00', null),
						recurrence_days: 3,
						observed_days: 3,
						avg_delay_min: 9.9,
					}),
					...Array.from({ length: extra }, (_, i) =>
						row('trip', 4 + i, 60, 20, {
							id: `gen-${i}`,
							...departure(`09:${10 + i}:00`, `Generated ${i}`),
							recurrence_days: 2,
							observed_days: 4,
							avg_delay_min: 20 - i / 10,
						}),
					),
					row('vehicle', 1, 64, 30, {
						id: '4672',
						route: '158',
						route_name: 'Bayshore <> Haanel',
						recurrence_days: 3,
						observed_days: 4,
						avg_delay_min: 7.5,
					}),
				],
				tray: [
					row('vehicle', null, 26, 17, {
						id: '6675',
						route: '21',
						route_name: 'Canotek <> Blair',
						recurrence_days: 2,
						observed_days: 2,
						wilson_lo: null,
						wilson_hi: null,
						avg_delay_min: 8,
					}),
				],
				total_ranked_trips: 120,
				total_ranked_vehicles: 41,
				tray_total: 1,
			},
		],
	} as unknown as RepeatOffendersData;
}

/** An earlier public shape: positions from the earlier rule, no departure labels, no dates. */
function olderRecord(): RepeatOffendersData {
	return {
		generated_utc: '2026-11-11T00:00:00Z' as IsoUtc,
		methodology_version: 'reliability-2',
		by_grain: [
			{
				grain: 'week',
				window_days: 7,
				entries: [
					row('trip', 1, 34, 34, {
						id: '302181944',
						recurrence_days: 1,
						observed_days: 1,
						wilson_lo: 0,
						wilson_hi: 10.2,
						avg_delay_min: 50.9,
					}),
					row('trip', 2, 146, 146, {
						id: '302095905',
						route: '777',
						route_name: 'Jean-Drapeau / Casino / Bonaventure',
						recurrence_days: 2,
						observed_days: 2,
						wilson_lo: 0,
						wilson_hi: 2.6,
						avg_delay_min: 48.9,
					}),
				],
				tray: [],
				total_ranked_trips: 46831,
				total_ranked_vehicles: 0,
				tray_total: 0,
			},
		],
	} as unknown as RepeatOffendersData;
}

function context(provider = 'stm') {
	return new Map<unknown, unknown>([
		[
			Symbol.for('transit.line-directory'),
			() =>
				createLineDirectory(
					['36', '158', '21', '777'].map((id) => ({ id, short: id })),
					{ line: (id) => `Line ${id}` },
				),
		],
		[
			Symbol.for('transit.i18n.href'),
			(href: string, lang: 'en' | 'fr') => localizeHref(href, lang, provider),
		],
	]);
}

const manifest = { provider: 'stm', display_name: 'STM', files: {} } as unknown as Manifest;

function show(data = seed(), url = 'http://localhost/repeat-offenders') {
	payload.current = data;
	mockUrl = new URL(url);
	return render(RepeatOffenders, { props: { manifest }, context: context() });
}

const rowButtons = () =>
	within(screen.getByRole('list', { name: /^(Trips|Buses|Trajets|Bus)$/ })).getAllByRole('button');
const openEvidence = () =>
	document.querySelector('[data-slot="offender-row-evidence"]:not([hidden])') as HTMLElement;

const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
	currentLocale.value = 'en';
	writeText.mockClear();
	vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
});
afterEach(() => vi.unstubAllGlobals());

describe('RepeatOffenders', () => {
	it('names the first-ranked departure for its complete period and rule', () => {
		const { container } = show();

		expect(
			screen.getByRole('heading', {
				level: 2,
				name: 'First-ranked trip: Line 36, 07:42 toward Monk.',
			}),
		).toBeInTheDocument();
		expect(container.querySelector('[data-slot="offenders-period"]')).toHaveTextContent(
			'November 11 to 17, 2026, 7 complete days.',
		);
		expect(
			screen.getByText('Trips and buses that are late again and again in the published record.'),
		).toBeInTheDocument();
		expect(container.querySelector('[data-slot="offenders-earlier-rule"]')).toBeNull();
	});

	it('keeps the publisher’s order with identity first and every figure spoken', () => {
		const { container } = show();

		const names = [
			...container.querySelectorAll('[data-slot="offender-rows"] [data-slot="offender-row-name"]'),
		].map((node) => node.textContent?.trim());
		expect(names).toEqual(['07:42 toward Monk', '08:15 toward Monk', '17:05']);
		expect(rowButtons()[0]).toHaveAccessibleName(
			'Position 1 of 120. Line 36, 07:42 toward Monk. Late on 4 of 6 days seen. 18.4 min average delay.',
		);
		expect(container.querySelector('[data-slot="offender-count"]')).toHaveTextContent(
			'Showing 3 of 120 eligible trips. This record publishes the first 3.',
		);
	});

	it('shows the first ten rows, then every published row and never more', async () => {
		show(seed(9));

		expect(rowButtons()).toHaveLength(10);
		await fireEvent.click(screen.getByRole('button', { name: 'Show all 12 published trips' }));
		expect(rowButtons()).toHaveLength(12);
		await waitFor(() => expect(mockUrl.searchParams.get('n')).toBe('all'));
		await fireEvent.click(screen.getByRole('button', { name: 'Show the first 10' }));
		expect(rowButtons()).toHaveLength(10);
	});

	it('opens evidence with the late-share interval converted once and links that keep the record', async () => {
		show();

		const first = rowButtons()[0];
		await fireEvent.click(first);
		expect(first).toHaveAttribute('aria-expanded', 'true');
		const inline = openEvidence();
		expect(
			within(inline).getByRole('heading', { level: 3, name: 'Selected record' }),
		).toBeInTheDocument();
		expect(inline.querySelector('[data-slot="offender-late-days"]')).toHaveTextContent('4 of 6');
		expect(inline).toHaveTextContent('days seen had a reading more than 5 minutes late.');
		expect(inline).toHaveTextContent('60 of 90 readings (66.7%)');
		// Published on-time bounds 25.3–41.3 become the late share's 58.7–74.7, once.
		expect(inline.querySelector('[data-slot="offender-interval"]')).toHaveTextContent(
			'58.7% to 74.7%',
		);
		expect(inline).toHaveTextContent('6 of 7 complete days');
		expect(inline).toHaveTextContent('A trip is one scheduled departure.');
		expect(
			within(inline).getByRole('link', { name: 'Open the line’s record: Line 36' }),
		).toHaveAttribute('href', '/lines/36?from=2026-11-11&to=2026-11-17&provider=stm');
		await waitFor(() => expect(mockUrl.searchParams.get('selected')).toBe('302181941@36'));

		const link =
			'http://localhost/repeat-offenders?date=2026-11-17&selected=302181941%4036&provider=stm';
		await fireEvent.click(within(inline).getByRole('button', { name: 'Copy link' }));
		expect(writeText).toHaveBeenLastCalledWith(link);
		await fireEvent.click(within(inline).getByRole('button', { name: 'Cite this record' }));
		expect(writeText).toHaveBeenLastCalledWith(
			`Transit. STM. Line 36, 07:42 toward Monk: late on 4 of 6 days seen, November 11 to 17, 2026. 90 readings. Record published November 18, 2026. Method version: reliability-2. ${link}`,
		);
	});

	it('keeps the current file’s period in the line record link once the contract reads it', async () => {
		// The adapter reads the current file with this schema, which drops undeclared fields.
		show(RepeatOffendersSchema.parse(seed()));

		await fireEvent.click(rowButtons()[0]);
		expect(
			within(openEvidence()).getByRole('link', { name: 'Open the line’s record: Line 36' }),
		).toHaveAttribute('href', '/lines/36?from=2026-11-11&to=2026-11-17&provider=stm');
	});

	it('copies a link to a row past the first ten that reopens on that row', async () => {
		const first = show(seed(9), 'http://localhost/repeat-offenders?n=all&selected=gen-8%4036');
		expect(openEvidence()).toHaveTextContent('Position 12 of 120');

		await fireEvent.click(within(openEvidence()).getByRole('button', { name: 'Copy link' }));
		const link = writeText.mock.lastCall![0];
		expect(link).toBe(
			'http://localhost/repeat-offenders?date=2026-11-17&n=all&selected=gen-8%4036&provider=stm',
		);
		first.unmount();

		show(seed(9), link);
		expect(openEvidence()).toHaveTextContent('Position 12 of 120');
		expect(openEvidence()).toHaveTextContent('09:18 toward Generated 8');
	});

	it('ranks buses per line, with the rule, its scope and the published rows below it', async () => {
		show();

		await fireEvent.click(screen.getByRole('radio', { name: 'Buses' }));
		expect(
			screen.getByRole('heading', {
				level: 2,
				name: 'First-ranked bus: Bus 4672 on line 158 (Bayshore <> Haanel).',
			}),
		).toBeInTheDocument();
		await waitFor(() => expect(mockUrl.searchParams.get('kind')).toBe('buses'));
		const exclusions = screen.getByRole('region', { name: 'Buses not ranked' });
		expect(exclusions).toHaveTextContent(
			'A row ranks only with at least 30 readings, seen on at least 3 days and late on at least 2 of them.',
		);
		expect(exclusions).toHaveTextContent('A bus is counted per line');
		expect(exclusions).toHaveTextContent('The number of buses left out is not published.');
		const unranked = screen.getByRole('list', { name: 'Published buses not ranked' });
		expect(
			within(unranked).getByRole('link', { name: 'Bus 6675 on line 21 (Canotek <> Blair)' }),
		).toHaveAttribute('href', '/lines/21?from=2026-11-11&to=2026-11-17&provider=stm');
		expect(unranked).toHaveTextContent('Late on 2 of 2 days seen · 26 readings');
		expect(unranked).toHaveTextContent('Fewer than 30 readings. Seen on fewer than 3 days.');
		expect(screen.getByText('1 published bus below the rule.')).toBeInTheDocument();
	});

	it('lists an older record’s rows as not ranked and invents no departure', () => {
		const { container } = show(olderRecord());

		expect(
			screen.getByRole('heading', {
				level: 2,
				name: 'No trip meets the ranking rule for these dates.',
			}),
		).toBeInTheDocument();
		expect(container.querySelector('[data-slot="offenders-earlier-rule"]')).toBeInTheDocument();
		expect(container.querySelector('[data-slot="offenders-period"]')).toHaveTextContent(
			'7 complete days. The dates of this period are not published.',
		);
		expect(container.querySelector('[data-slot="offender-rows"]')).toBeNull();
		const unranked = screen.getByRole('list', { name: 'Published trips not ranked' });
		expect(
			within(unranked).getByRole('link', { name: 'Trip 302181944 on line 36 (Monk)' }),
		).toHaveAttribute('href', '/lines/36?provider=stm');
		expect(unranked).toHaveTextContent('Late on 1 of 1 day seen · 34 readings');
		expect(unranked).toHaveTextContent('Seen on fewer than 3 days. Late on fewer than 2 days.');
		expect(container.textContent).not.toMatch(/toward|\d:\d\d/);
	});

	it('shows the first ten rows below the rule, then all of them', async () => {
		const data = olderRecord();
		data.by_grain![0].entries = Array.from({ length: 12 }, (_, i) =>
			row('trip', i + 1, 40, 40, {
				id: `old-${i}`,
				recurrence_days: 1,
				observed_days: 1,
				wilson_lo: 0,
				wilson_hi: 8.8,
			}),
		);
		show(data);

		const unranked = () => screen.getByRole('list', { name: 'Published trips not ranked' });
		expect(within(unranked()).getAllByRole('listitem')).toHaveLength(10);
		expect(screen.getByText('12 published trips below the rule.')).toBeInTheDocument();
		await fireEvent.click(screen.getByRole('button', { name: 'Show all 12 published trips' }));
		expect(within(unranked()).getAllByRole('listitem')).toHaveLength(12);
		await fireEvent.click(screen.getByRole('button', { name: 'Show the first 10' }));
		expect(within(unranked()).getAllByRole('listitem')).toHaveLength(10);
	});

	it.each([
		[
			'en',
			'2 published trips not ranked.',
			'Reading count not published. Days seen not published. Late days not published.',
			'Fewer than 30 readings. Seen on fewer than 3 days. Late on fewer than 2 days.',
		],
		[
			'fr',
			'2 trajets publiés non classés.',
			'Nombre de relevés non publié. Jours observés non publiés. Jours en retard non publiés.',
			'Moins de 30 relevés. Vu moins de 3 jours. En retard moins de 2 jours.',
		],
	] as const)(
		'tells unpublished eligibility counts from measured ones below the rule in %s',
		(locale, summary, unknown, measured) => {
			currentLocale.value = locale;
			const data = seed();
			const base = { rank: null, type: 'trip', route: '36', window_days: 7 };
			data.by_grain![0].tray = [
				{ ...base, id: 'UNPUBLISHED' },
				{
					...base,
					id: 'ZERO',
					observation_count: 0,
					severe_count: 0,
					recurrence_days: 0,
					observed_days: 0,
				},
			];
			data.by_grain![0].tray_total = 2;
			show(data);

			const [absent, zero] = within(
				screen.getByRole('list', {
					name: locale === 'en' ? 'Published trips not ranked' : 'Trajets publiés non classés',
				}),
			).getAllByRole('listitem');
			expect(absent).toHaveTextContent(unknown);
			expect(absent.textContent).not.toMatch(/Fewer than|Moins de|fewer than|moins de/);
			expect(zero).toHaveTextContent(measured);
			// Eligibility is not established for every listed row, so the summary stays neutral.
			expect(screen.getByText(summary)).toBeInTheDocument();
		},
	);

	it.each([
		['en', 'Not published in this record', 'Readings', '90 readings', '60 of 90 readings'],
		['fr', 'Non publié dans ce bilan', 'Relevés', '90 relevés', '60 sur 90 relevés'],
	] as const)(
		'never shows the total under the late-readings label in %s',
		async (locale, unpublished, totalLabel, total, withoutShare) => {
			currentLocale.value = locale;
			const lateOf = () =>
				openEvidence().querySelector('[data-slot="offender-late-readings"]')?.textContent?.trim();
			const data = seed();
			const first = data.by_grain![0].entries![0];
			data.by_grain![0].entries![0] = {
				...first,
				severe_count: null,
				severe_pct: null,
				wilson_lo: null,
				wilson_hi: null,
			};
			const missing = show(data);
			await fireEvent.click(rowButtons()[0]);
			expect(lateOf()).toBe(unpublished);
			const readings = openEvidence().querySelector('[data-slot="offender-readings"]');
			expect(readings?.previousElementSibling).toHaveTextContent(totalLabel);
			expect(readings).toHaveTextContent(total);
			missing.unmount();

			const shareless = seed();
			const row = shareless.by_grain![0].entries![0];
			shareless.by_grain![0].entries![0] = { ...row, severe_pct: null };
			show(shareless);
			await fireEvent.click(rowButtons()[0]);
			expect(lateOf()).toBe(withoutShare);
			expect(lateOf()).not.toBe(total);
		},
	);

	it('keeps unpublished figures absent, never a reassuring zero', async () => {
		const data = seed();
		const week = data.by_grain![0];
		week.entries![0] = {
			...week.entries![0],
			avg_delay_min: null,
			wilson_lo: null,
			wilson_hi: null,
		};
		week.total_ranked_trips = null;
		const { container } = show(data);

		expect(rowButtons()[0]).toHaveTextContent('Average delay not published');
		expect(container.querySelector('[data-slot="offender-count"]')).toHaveTextContent(
			'Showing 3 of 3 published trips. The number of eligible trips is not published.',
		);
		await fireEvent.click(rowButtons()[0]);
		expect(openEvidence().querySelector('[data-slot="offender-interval"]')).toHaveTextContent(
			'Not published in this record',
		);
	});

	it.each([
		['en', '0 readings'],
		['fr', '0 relevé'],
	] as const)('never shows a negative zero count in %s', (locale, zero) => {
		currentLocale.value = locale;
		const data = seed();
		data.by_grain![0].tray = [
			{
				rank: null,
				type: 'trip',
				id: 'T0',
				route: '36',
				observation_count: -0,
				severe_count: -0,
				recurrence_days: -0,
				observed_days: -0,
				window_days: 7,
			},
		];
		show(data);

		const unranked = screen.getByRole('list', {
			name: locale === 'en' ? 'Published trips not ranked' : 'Trajets publiés non classés',
		});
		expect(unranked).toHaveTextContent(zero);
		expect(unranked.textContent).not.toMatch(/[-−]\s*0/);
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
		broken.by_grain![0].entries![1] = { ...broken.by_grain![0].entries![1], recurrence_days: 9 };
		const { container } = show(broken);
		expect(
			screen.getByRole('heading', {
				level: 2,
				name: 'This ranking failed its consistency checks, so it is not shown.',
			}),
		).toBeInTheDocument();
		expect(container.querySelector('[data-slot="offender-rows"]')).toBeNull();
	});

	it('reads the same record in French', async () => {
		currentLocale.value = 'fr';
		const { container } = show();

		expect(
			screen.getByRole('heading', {
				level: 2,
				name: 'Trajet en tête du classement : Ligne 36, 07:42 vers Monk.',
			}),
		).toBeInTheDocument();
		expect(container.querySelector('[data-slot="offenders-period"]')).toHaveTextContent(
			'Du 11 au 17 novembre 2026, 7 jours complets.',
		);
		expect(container.querySelector('[data-slot="offender-count"]')).toHaveTextContent(
			'3 trajets affichés sur 120 admissibles. Ce bilan publie les 3 premiers.',
		);
		await fireEvent.click(rowButtons()[0]);
		const inline = openEvidence();
		expect(inline.querySelector('[data-slot="offender-interval"]')?.textContent).toBe(
			`de 58,7${NB}% à 74,7${NB}%`,
		);
		// The matcher folds the no-break space.
		expect(inline).toHaveTextContent('60 sur 90 relevés (66,7 %)');
		await fireEvent.click(within(inline).getByRole('button', { name: 'Citer ce bilan' }));
		expect(writeText).toHaveBeenLastCalledWith(
			'Transit. STM. Ligne 36, 07:42 vers Monk : en retard 4 jours sur 6 observés, du 11 au 17 novembre 2026. 90 relevés. Bilan publié le 18 novembre 2026. Version de la méthode : reliability-2. http://localhost/fr/repeat-offenders?date=2026-11-17&selected=302181941%4036&provider=stm',
		);
	});

	it('shows the record stamp without a publication time', async () => {
		const { container } = show();
		const header = container.querySelector('[data-slot="article-header"]') as HTMLElement;
		await waitFor(() =>
			expect(header).toHaveTextContent(
				stampCopy.en.record(null, formatDateKey('2026-11-18', 'en', true), 'window'),
			),
		);
	});
});
