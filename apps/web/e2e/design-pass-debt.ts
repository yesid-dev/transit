import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import { readingScreens, type Screen } from './design-pass-cases';
import { budgetWidths, widths, type measureDesignPass } from './design-pass-measure';

type Report = Awaited<ReturnType<typeof measureDesignPass>>['report'];
type Budget = Record<(typeof budgetWidths)[number], { height: number; beforeFigure: number }>;

export const mapChromeShareBudget = 0.25;
export const mapOpenLegendViewportHeight = 900;

// A screen PR supplies its budgets here once all of its fixture variants leave the debt list.
const budgets: Partial<Record<Screen, Budget>> = {
	'rankings-lines': {
		390: { height: 9078, beforeFigure: 0 },
		1440: { height: 4632, beforeFigure: 0 },
	},
	'rankings-stops': {
		390: { height: 8611, beforeFigure: 0 },
		1440: { height: 4579, beforeFigure: 0 },
	},
	'rankings-departures': {
		390: { height: 5209, beforeFigure: 0 },
		1440: { height: 2610, beforeFigure: 0 },
	},
	'rankings-vehicles': {
		390: { height: 9951, beforeFigure: 0 },
		1440: { height: 5095, beforeFigure: 0 },
	},
	lines: {
		390: { height: 8500, beforeFigure: 0 },
		1440: { height: 5500, beforeFigure: 0 },
	},
	vehicles: {
		390: { height: 6800, beforeFigure: 0 },
		1440: { height: 4000, beforeFigure: 0 },
	},
	'vehicles-live': {
		390: { height: 6800, beforeFigure: 0 },
		1440: { height: 4000, beforeFigure: 0 },
	},
	stops: {
		390: { height: 6541, beforeFigure: 4 },
		1440: { height: 3486, beforeFigure: 4 },
	},
	alerts: {
		390: { height: 5880, beforeFigure: 0 },
		1440: { height: 3600, beforeFigure: 0 },
	},
	search: {
		390: { height: 2740, beforeFigure: 1 },
		1440: { height: 1750, beforeFigure: 1 },
	},
	'search-query': {
		390: { height: 2740, beforeFigure: 1 },
		1440: { height: 1750, beforeFigure: 1 },
	},
	daily: {
		390: { height: 7500, beforeFigure: 1 },
		1440: { height: 4300, beforeFigure: 1 },
	},
	'line-live': {
		390: { height: 8000, beforeFigure: 1 },
		1440: { height: 5071, beforeFigure: 1 },
	},
	'line-record': {
		390: { height: 16000, beforeFigure: 1 },
		1440: { height: 8000, beforeFigure: 1 },
	},
	departure: {
		390: { height: 4000, beforeFigure: 1 },
		1440: { height: 2200, beforeFigure: 1 },
	},
	'vehicle-record': {
		390: { height: 8746, beforeFigure: 1 },
		1440: { height: 4348, beforeFigure: 1 },
	},
	'vehicle-live': {
		390: { height: 5110, beforeFigure: 1 },
		1440: { height: 2437, beforeFigure: 1 },
	},
	'network-health': {
		390: { height: 9798, beforeFigure: 3 },
		1440: { height: 4852, beforeFigure: 3 },
	},
	'network-health-live': {
		390: { height: 6459, beforeFigure: 1 },
		1440: { height: 3129, beforeFigure: 1 },
	},
	'data-health': {
		390: { height: 5626, beforeFigure: 2 },
		1440: { height: 3309, beforeFigure: 2 },
	},
	'data-health-live': {
		390: { height: 4767, beforeFigure: 1 },
		1440: { height: 2232, beforeFigure: 1 },
	},
	'stop-live': {
		390: { height: 5767, beforeFigure: 1 },
		1440: { height: 2686, beforeFigure: 1 },
	},
	'stop-record': {
		390: { height: 7863, beforeFigure: 1 },
		1440: { height: 3900, beforeFigure: 1 },
	},
	download: {
		390: { height: 6075, beforeFigure: 3 },
		1440: { height: 3082, beforeFigure: 3 },
	},
	roadmap: {
		390: { height: 4836, beforeFigure: 3 },
		1440: { height: 3351, beforeFigure: 3 },
	},
	overview: {
		390: { height: 6000, beforeFigure: 3 },
		1440: { height: 3500, beforeFigure: 3 },
	},
	'how-we-measure': {
		390: { height: 7392, beforeFigure: 3 },
		1440: { height: 4300, beforeFigure: 3 },
	},
};
// Reading pages vary by city and language, so each case keeps its own ceiling: the measured
// height plus 1%, never above the debt value it replaced (STM English).
const caseBudgets: Partial<Record<string, Budget>> = {
	'privacy/stm/en': {
		390: { height: 12868, beforeFigure: 0 },
		1440: { height: 7710, beforeFigure: 0 },
	},
	'terms/stm/en': {
		390: { height: 6120, beforeFigure: 0 },
		1440: { height: 3640, beforeFigure: 0 },
	},
	'accessibility/stm/en': {
		390: { height: 3340, beforeFigure: 0 },
		1440: { height: 1720, beforeFigure: 0 },
	},
	'error/stm/en': {
		390: { height: 2303, beforeFigure: 0 },
		1440: { height: 1250, beforeFigure: 0 },
	},
	'privacy/octranspo/en': {
		390: { height: 12860, beforeFigure: 0 },
		1440: { height: 7710, beforeFigure: 0 },
	},
	'terms/octranspo/en': {
		390: { height: 6060, beforeFigure: 0 },
		1440: { height: 3640, beforeFigure: 0 },
	},
	'accessibility/octranspo/en': {
		390: { height: 3290, beforeFigure: 0 },
		1440: { height: 1720, beforeFigure: 0 },
	},
	'error/octranspo/en': {
		390: { height: 2290, beforeFigure: 0 },
		1440: { height: 1250, beforeFigure: 0 },
	},
	'privacy/stm/fr': {
		390: { height: 15170, beforeFigure: 0 },
		1440: { height: 8910, beforeFigure: 0 },
	},
	'terms/stm/fr': {
		390: { height: 6920, beforeFigure: 0 },
		1440: { height: 4090, beforeFigure: 0 },
	},
	'accessibility/stm/fr': {
		390: { height: 3660, beforeFigure: 0 },
		1440: { height: 1890, beforeFigure: 0 },
	},
	'error/stm/fr': {
		390: { height: 2350, beforeFigure: 0 },
		1440: { height: 1270, beforeFigure: 0 },
	},
	'privacy/octranspo/fr': {
		390: { height: 15120, beforeFigure: 0 },
		1440: { height: 8910, beforeFigure: 0 },
	},
	'terms/octranspo/fr': {
		390: { height: 6870, beforeFigure: 0 },
		1440: { height: 4090, beforeFigure: 0 },
	},
	'accessibility/octranspo/fr': {
		390: { height: 3610, beforeFigure: 0 },
		1440: { height: 1890, beforeFigure: 0 },
	},
	'error/octranspo/fr': {
		390: { height: 2310, beforeFigure: 0 },
		1440: { height: 1270, beforeFigure: 0 },
	},
};
// Defects inside a kit part, reported upstream with the exact rule. Each matches one defect
// exactly, so any other defect on the screen still fails.
const kitGaps: Partial<Record<Screen, RegExp>> = {
	// ErrorPage keeps a 1.5rem heading inside 1.5rem inline padding: at 390 px and 200% text the
	// line is 294 px and "construction" needs 300 px.
	error: /^broken-word #error-page-heading-[\w-]+ construction$/,
	// ReadingFrame sizes its title and body headings in rem: at 390 px and 200% text the line is
	// 326 px, "confidentialité" needs 359 px and "Renseignements" 328 px.
	privacy: /^broken-word #legal-(?:title confidentialité|processing Renseignements)$/,
};

const { screens: debt }: { screens: Partial<Record<string, Report>> } = JSON.parse(
	readFileSync(new URL('./design-pass-baseline.json', import.meta.url), 'utf8'),
);

function compare(current: object, recorded: object, location: string) {
	expect(
		current,
		`${location} changed from its fixture baseline. Fix regressions. If the screen improved, tighten or delete its debt entry.`,
	).toEqual(recorded);
}

function compareSize<T extends { height: number }>(current: T, recorded: T, location: string) {
	const { height, ...geometry } = current;
	const { height: ceiling, ...recordedGeometry } = recorded;
	expect(height, `${location} height`).toBeLessThanOrEqual(ceiling);
	compare(geometry, recordedGeometry, location);
}

export function expectDesignPass(screen: Screen, key: string, report: Report) {
	if (screen.startsWith('map-')) {
		expect(report.content.titles, `${key} C1 map title`).toBe(1);
		for (const width of widths)
			expect(report.widths[width].overflow, `${key} C3 sideways map scroll at ${width}px`).toBe(0);
		for (const width of budgetWidths)
			expect(report.zoom[width].overflow, `${key} C4 sideways map scroll at ${width}px`).toBe(0);
		return;
	}
	const recorded = debt[key];
	if (recorded) {
		compare(report.content, recorded.content, `${key} C1 content order`);
		for (const width of widths)
			compareSize(report.widths[width], recorded.widths[width], `${key} C2/C3/C5 at ${width}px`);
		for (const width of budgetWidths) {
			compareSize(report.zoom[width], recorded.zoom[width], `${key} C4 at ${width}px`);
			compare(report.keyboard[width], recorded.keyboard[width], `${key} C7 at ${width}px`);
		}
		return;
	}

	const budget =
		caseBudgets[key] ??
		budgets[screen === 'overview-live' ? 'overview' : screen === 'alerts-live' ? 'alerts' : screen];
	if (!budget) throw new Error(`${key} needs measured debt or a screen budget.`);
	// Reading and error pages have a title and no Record answer to lead with.
	const reading = (readingScreens as readonly Screen[]).includes(screen);
	expect(report.content, `${key} C1`).toEqual({ titles: 1, answerFirst: !reading });
	for (const width of widths) {
		const metrics = report.widths[width];
		expect(metrics.overflow, `${key} C3 sideways scroll at ${width}px`).toBe(0);
		expect(metrics.textDefects, `${key} C3 text at ${width}px`).toEqual([]);
		expect(metrics.shortTargets, `${key} C5 targets below 44px at ${width}px`).toBe(0);
	}
	for (const width of budgetWidths) {
		expect(report.widths[width].height, `${key} C2 height at ${width}px`).toBeLessThanOrEqual(
			budget[width].height,
		);
		const zoom = report.zoom[width];
		expect(zoom.overflow, `${key} C4 sideways scroll at ${width}px`).toBe(0);
		expect(zoom.edges, `${key} C4 element edges at ${width}px`).toBe(0);
		expect(
			zoom.textDefects.filter((defect) => !kitGaps[screen]?.test(defect)),
			`${key} C4 text at ${width}px`,
		).toEqual([]);
		const keyboard = report.keyboard[width];
		expect(keyboard.withoutRing, `${key} C7 missing focus rings at ${width}px`).toBe(0);
		expect(keyboard.outOfOrder, `${key} C7 visual order at ${width}px`).toBe(0);
		expect(
			keyboard.beforeFigure,
			`${key} C7 stops before the first figure at ${width}px`,
		).toBeLessThanOrEqual(budget[width].beforeFigure);
	}
}
