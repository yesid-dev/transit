import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
import type { Screen } from './design-pass-cases';
import { budgetWidths, widths, type measureDesignPass } from './design-pass-measure';

type Report = Awaited<ReturnType<typeof measureDesignPass>>['report'];
type Budget = Record<(typeof budgetWidths)[number], { height: number; beforeFigure: number }>;

// A screen PR supplies its budgets here once all of its fixture variants leave the debt list.
const budgets: Partial<Record<Screen, Budget>> = {
	'line-record': {
		390: { height: 16000, beforeFigure: 1 },
		1440: { height: 8000, beforeFigure: 1 },
	},
	departure: {
		390: { height: 4000, beforeFigure: 1 },
		1440: { height: 2200, beforeFigure: 1 },
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

	const budget = budgets[screen === 'overview-live' ? 'overview' : screen];
	if (!budget) throw new Error(`${key} needs measured debt or a screen budget.`);
	expect(report.content, `${key} C1`).toEqual({ titles: 1, answerFirst: true });
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
		expect(zoom.textDefects, `${key} C4 text at ${width}px`).toEqual([]);
		const keyboard = report.keyboard[width];
		expect(keyboard.withoutRing, `${key} C7 missing focus rings at ${width}px`).toBe(0);
		expect(keyboard.outOfOrder, `${key} C7 visual order at ${width}px`).toBe(0);
		expect(
			keyboard.beforeFigure,
			`${key} C7 stops before the first figure at ${width}px`,
		).toBeLessThanOrEqual(budget[width].beforeFigure);
	}
}
