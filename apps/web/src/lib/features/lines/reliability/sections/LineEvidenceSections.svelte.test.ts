import { render, fireEvent, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { verdictForWindow } from '#lib/v1/verdict.ts';
import type {
	CancellationPeriod,
	HeadwayPeriod,
	SkippedStopPeriod,
	WeakStop,
} from '#lib/v1/index.ts';
import { reliabilityCopy } from '../reliability.copy';
import type {
	CrowdingVM,
	PeriodComparisonRow,
	PunctualityVM,
	ServiceDeliveredVM,
} from '../clusters';
import { crowdingFigure, type CutScope } from '../selectors/evidence';
import Section1WhenToRide from './Section1WhenToRide.svelte';
import Section2TheWait from './Section2TheWait.svelte';
import Section3RunAndFit from './Section3RunAndFit.svelte';
import Section4WorstStops from './Section4WorstStops.svelte';
import SectionCrowding from './SectionCrowding.svelte';

const week: CutScope = { kind: 'window', from: '2026-11-04', to: '2026-11-10' };
const range: CutScope = { kind: 'none', range: true };

const cut = (
	grain: string,
	onTime: number | null,
	readings: number | null,
): PeriodComparisonRow => ({
	grain,
	otpPct: null,
	avgDelayMin: null,
	severePct: 4,
	observationCount: readings,
	onTime,
	priorOtpPct: null,
	priorObservationCount: null,
	priorOnTime: null,
});

const punctuality = (
	byShift: PeriodComparisonRow[],
	byDayType: PeriodComparisonRow[] = [],
): PunctualityVM => ({
	headline: {
		...verdictForWindow(null),
		otpPct: null,
		avgDelayMin: null,
		p50Min: null,
		p90Min: null,
		severePct: null,
		delayHistogram: null,
		observationCount: null,
		onTime: null,
	},
	trend: [],
	dayOfWeek: [],
	weakStops: [],
	peakOffPeak: { byShift, byDayType, isEmpty: byShift.length + byDayType.length === 0 },
	byShiftDaytype: [],
	windowed: true,
	weakStopsWindowed: true,
	isEmpty: false,
});
const noHabits = { scale: null, matrix: [], isEmpty: true };

const shifts = [
	cut('night', 437, 480),
	cut('am_peak', 73_419, 80_927),
	cut('pm_peak', 60_900, 70_000),
	cut('midday', 0, 0),
];

describe('By time of day', () => {
	it('shows the record’s measure for each period of the day, with the cut’s own days', () => {
		const view = render(Section1WhenToRide, {
			props: {
				punctuality: punctuality(shifts, [cut('weekend', 9, 10)]),
				habits: noHabits,
				scope: week,
				locale: 'en',
				copy: reliabilityCopy.en,
			},
		});
		const table = view.container.querySelector<HTMLElement>('[data-slot="time-of-day"]')!;
		expect(table.querySelector('caption')).toHaveTextContent(
			'Readings on time by period of the day. Period of these figures: November 4 to 10.',
		);
		const [periods, dayTypes] = [...table.querySelectorAll('tbody')];
		const rows = [...periods.querySelectorAll('tr')].map((row) =>
			[...row.querySelectorAll('th,td')].map((cell) =>
				cell.textContent!.replace(/\s+/gu, ' ').trim(),
			),
		);
		expect(rows).toEqual([
			['Morning peak', '91%', '80,927'],
			['Midday', 'Not published for this period', ''],
			['Afternoon peak', '87%', '70,000'],
			['Night', '91%', '480'],
		]);
		expect(within(dayTypes).getByRole('rowheader', { name: 'Weekends' })).toBeInTheDocument();
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'Between 87% and 91% by period of the day. Lowest: Afternoon peak.',
		);
	});

	it('never lends the latest day’s cut to a chosen range', () => {
		const view = render(Section1WhenToRide, {
			props: {
				punctuality: punctuality(shifts),
				habits: noHabits,
				scope: range,
				locale: 'fr',
				copy: reliabilityCopy.fr,
			},
		});
		expect(view.container.querySelector('[data-slot="time-of-day"]')).toBeNull();
		expect(view.container.querySelector('[data-slot="shift-severe-strip"]')).toBeNull();
		expect(view.getByText(reliabilityCopy.fr.evidence.timeOfDay.absentRange)).toHaveAttribute(
			'data-slot',
			'absent-value',
		);
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'Non publié pour cette période.',
		);
	});

	it('writes French shares and dates in French', () => {
		const view = render(Section1WhenToRide, {
			props: {
				punctuality: punctuality(shifts),
				habits: noHabits,
				scope: week,
				locale: 'fr',
				copy: reliabilityCopy.fr,
			},
		});
		expect(view.container.querySelector('caption')).toHaveTextContent(
			'Période de ces données : du 4 au 10 novembre.',
		);
		expect(view.container.querySelector('[data-slot="section-summary"]')!.textContent).toMatch(
			/^Entre 87\s%\set 91\s% selon la période de la journée\. Le plus bas : Pointe de l’après-midi\.$/u,
		);
	});
});

const stop = (
	id: string,
	severe: number | null,
	readings: number | null,
	name = `Stop ${id}`,
): WeakStop => ({
	id,
	name,
	severe_pct: severe,
	observation_count: readings,
	avg_delay_min: 2,
	wilson_lo: 84,
	wilson_hi: 87,
});
const longName =
	'Queen-Mary / Frère-André (Oratoire Saint-Joseph du Mont-Royal), quai en direction est';

describe('Stops with delays', () => {
	const stops = [
		stop('1', 61.2, 2_000),
		stop('2', 63.9, 1_891, longName),
		stop('3', 61.6, 1_500),
		stop('4', 60.7, 900),
		stop('5', 57, 1_200),
		stop('6', 40, 1),
		stop('7', 12.5, 500),
	];

	it('lists stops by their shown share with their readings and no interval', async () => {
		const view = render(Section4WorstStops, {
			props: { stops, scope: week, locale: 'en', copy: reliabilityCopy.en },
		});
		const list = view.getByRole('list', { name: 'Stops with delays' });
		const items = within(list).getAllByRole('listitem');
		expect(items).toHaveLength(5);
		expect(within(items[0]).getByRole('link', { name: longName })).toHaveAttribute(
			'href',
			'/stop/2',
		);
		expect(
			items.map((item) => item.querySelector('[data-slot="stop-delay-value"]')!.textContent),
		).toEqual([
			'63.9% of readings more than 5 minutes late',
			'61.6% of readings more than 5 minutes late',
			'61.2% of readings more than 5 minutes late',
			'60.7% of readings more than 5 minutes late',
			'57% of readings more than 5 minutes late',
		]);
		expect(items[0]).toHaveTextContent('1,891 readings');
		expect(list.textContent).not.toMatch(/CI|–|\bto\b/u);
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			`${longName} has the highest share: 63.9% of its readings were more than 5 minutes late.`,
		);

		const toggle = view.getByRole('button', { name: 'Show all 7 stops' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(toggle);
		expect(within(list).getAllByRole('listitem')).toHaveLength(7);
		expect(within(list).getAllByRole('listitem')[5]).toHaveTextContent('1 reading');
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(toggle).toHaveAccessibleName('Show fewer stops');
	});

	it('says stop figures are not published for a chosen range', () => {
		const view = render(Section4WorstStops, {
			props: { stops, scope: range, locale: 'en', copy: reliabilityCopy.en },
		});
		expect(view.queryByRole('list')).toBeNull();
		expect(view.getByText(reliabilityCopy.en.evidence.stops.absentRange)).toHaveAttribute(
			'data-slot',
			'absent-value',
		);
	});
});

const cancelled = (date: string, c: number, seen: number): CancellationPeriod => ({
	grain: 'day',
	date,
	canceled_trip_days: c,
	total_trip_days: seen,
});
const skipped = (date: string, s: number, updates: number): SkippedStopPeriod => ({
	date,
	skipped_stop_count: s,
	stop_time_update_count: updates,
});
const service = (
	cancellations: CancellationPeriod[],
	skippedStops: SkippedStopPeriod[],
): ServiceDeliveredVM => ({
	serviceSpans: [],
	cancellations,
	skippedStops,
	cancellationRatePct: null,
	skippedStopRatePct: null,
	serviceCompletenessPct: null,
	scheduledService: null,
	isRampIn: true,
	isEmpty: false,
});
const period = { from: '2026-11-04', to: '2026-11-10', days: 7 };

describe('Cancelled and missing trips', () => {
	it('counts cancellations among trips seen live and keeps missing and silent trips apart', () => {
		const view = render(Section3RunAndFit, {
			props: {
				service: service(
					[
						cancelled('2026-11-03', 50, 60),
						cancelled('2026-11-04', 20, 500),
						cancelled('2026-11-10', 16, 519),
					],
					[skipped('2026-11-04', 65_000, 4_000_000), skipped('2026-11-09', 214, 984_621)],
				),
				period,
				locale: 'en',
				copy: reliabilityCopy.en,
			},
		});
		const facts = within(view.container.querySelector<HTMLElement>('[data-slot="trip-facts"]')!);
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'36 of the 1,019 trips seen in the live data were reported cancelled (3.5%).',
		);
		expect(facts.getByText('36 of 1,019 (3.5%)')).toBeInTheDocument();
		expect(
			facts.getByText(/not every scheduled trip\. Published for 2 of these 7 days\./u),
		).toBeInTheDocument();
		expect(facts.getByText('65,214 of 4,984,621 stop updates (1.3%)')).toBeInTheDocument();
		const missing = view.container.querySelector(
			'[data-slot="missing-trips"] [data-slot="absent-value"]',
		);
		expect(missing).toHaveTextContent('Not published for this period');
		expect(facts.getByRole('link', { name: 'See live now' }).getAttribute('href')).toContain(
			'tab=detail',
		);
	});

	it('withholds a count that breaks its definition instead of showing a share', () => {
		const view = render(Section3RunAndFit, {
			props: {
				service: service([cancelled('2026-11-05', 9, 4)], []),
				period,
				locale: 'fr',
				copy: reliabilityCopy.fr,
			},
		});
		expect(view.container.querySelectorAll('[data-slot="absent-value"]')).toHaveLength(3);
		expect(view.container.textContent).not.toMatch(/\d\s?%/u);
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'Non publié pour cette période.',
		);
	});
});

const gap = (shift: string, scheduled: number, observed: number): HeadwayPeriod => ({
	shift,
	direction_id: null,
	day_type: null,
	scheduled_min: scheduled,
	observed_min: observed,
	excess_wait_min: 2,
	cov: 0.7,
	bunched_pct: 26,
	observation_count: 150,
	prior_observation_count: null,
	prior_observed_min: null,
});

describe('Waiting and gaps', () => {
	const wait = {
		headway: [gap('am_peak', 4, 4.6), gap('evening', 12, 13.3)],
		windowed: true,
		isEmpty: false,
	};

	it('states that waiting is not measured and shows gaps between first reports for their days', () => {
		const view = render(Section2TheWait, {
			props: { wait, scope: week, locale: 'en', copy: reliabilityCopy.en },
		});
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'Waiting time is not measured here. These are gaps between first reports, not arrivals at your stop.',
		);
		const gaps = view.getByRole('table');
		expect(gaps.querySelector('caption')).toHaveTextContent(
			'Median gap in minutes, by period of the day. Period of these figures: November 4 to 10.',
		);
		const rows = [...gaps.querySelectorAll('tbody tr')].map((row) =>
			[...row.querySelectorAll('th,td')].map((cell) => cell.textContent!.trim()),
		);
		expect(rows).toEqual([
			['Morning peak', '4', '4.6'],
			['Evening', '12', '13.3'],
		]);
		expect(view.container.textContent).not.toMatch(/excess wait|you will wait/iu);
		expect(view.getByText(reliabilityCopy.en.evidence.gaps.frequent)).toBeInTheDocument();
	});

	it('withholds the latest day’s gaps from a chosen range but still explains frequency', () => {
		const view = render(Section2TheWait, {
			props: { wait, scope: range, locale: 'en', copy: reliabilityCopy.en },
		});
		expect(view.queryByRole('table')).toBeNull();
		expect(view.getByText(reliabilityCopy.en.evidence.gaps.absentRange)).toBeInTheDocument();
		expect(view.getByText(reliabilityCopy.en.evidence.gaps.frequent)).toBeInTheDocument();
	});

	it('never shows a zero-minute gap: a gap between trips is a positive duration', () => {
		const zero = { ...gap('am_peak', 0, 0), observed_min: null };
		const view = render(Section2TheWait, {
			props: {
				wait: { headway: [zero], windowed: true, isEmpty: false },
				scope: week,
				locale: 'fr',
				copy: reliabilityCopy.fr,
			},
		});
		expect(view.queryByRole('table')).toBeNull();
		expect(view.getByText('Non publié pour cette période')).toHaveAttribute(
			'data-slot',
			'absent-value',
		);
	});
});

const mix = (many: number, few: number, standing: number, full: number) => ({
	empty: 0,
	many_seats: many,
	few_seats: few,
	standing,
	full,
});
const crowding = (
	byGrain: ReturnType<typeof mix> | null,
	all: ReturnType<typeof mix> | null,
): CrowdingVM => ({
	mix: all,
	delayByCrowding: [],
	mixByGrain: byGrain,
	weekdayWeekend: null,
	byWeekday: null,
	isEmpty: all == null,
});

const labels = { grain: 'Last 7 days', range: 'November 4 to 10' };
const renderCrowding = (vm: CrowdingVM, mode: 'week' | 'range', locale: 'en' | 'fr' = 'en') =>
	render(SectionCrowding, {
		props: {
			crowding: vm,
			figure: crowdingFigure(vm, mode, labels),
			locale,
			copy: reliabilityCopy[locale],
		},
	});

describe('Crowding', () => {
	it('names the dominant band of occupancy readings and the mix’s own scope', () => {
		const view = renderCrowding(
			crowding(mix(0.2, 0.5, 0.28, 0.02), mix(0.34, 0.34, 0.3, 0.02)),
			'week',
		);
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'Few seats in 50% of occupancy readings.',
		);
		expect(view.getByText('Period of these figures: Last 7 days.')).toBeInTheDocument();
	});

	it('never labels the file-level mix with the chosen grain', () => {
		const view = renderCrowding(crowding(null, mix(0.2, 0.8, 0, 0)), 'week');
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'No crowding data for this record.',
		);
		expect(view.container.textContent).not.toMatch(/Last 7 days|80s?%/u);
	});

	it('names a chosen range’s own dates for its retained mix', () => {
		const view = renderCrowding(crowding(null, mix(0.2, 0.5, 0.28, 0.02)), 'range');
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'Few seats in 50% of occupancy readings.',
		);
		expect(view.getByText('Period of these figures: November 4 to 10.')).toBeInTheDocument();
	});

	it('says plainly when no crowding is published', () => {
		const view = renderCrowding(crowding(null, null), 'week', 'fr');
		expect(view.container.querySelector('[data-slot="section-summary"]')).toHaveTextContent(
			'Aucune donnée d’occupation pour ce bilan.',
		);
		expect(view.container.textContent).not.toMatch(/ds?%/u);
	});
});
