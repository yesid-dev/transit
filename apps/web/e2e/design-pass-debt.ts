import { expect } from '@playwright/test';
import type { Screen } from './design-pass-cases';
import { budgetWidths, widths, type measureDesignPass } from './design-pass-measure';
import baseline from './design-pass-baseline.json';

type Report = Awaited<ReturnType<typeof measureDesignPass>>;
type Budget = Record<(typeof budgetWidths)[number], { height: number; beforeFigure: number }>;

// A screen PR supplies its budgets here once all of its fixture variants leave the debt list.
const budgets: Partial<Record<Screen, Budget>> = {};
const debt: Partial<Record<string, Report>> = baseline.screens;

function compare<T>(current: T, recorded: T, location: string) {
	expect(
		current,
		`${location} changed from its fixture baseline. Fix regressions. If the screen improved, tighten or delete its debt entry.`,
	).toEqual(recorded);
}

export function expectDesignPass(screen: Screen, key: string, report: Report) {
	const recorded = debt[key];
	if (recorded) {
		compare(report.content, recorded.content, `${key} C1 content order`);
		for (const width of widths)
			compare(report.widths[width], recorded.widths[width], `${key} C2/C3/C5 at ${width}px`);
		for (const width of budgetWidths) {
			compare(report.zoom[width], recorded.zoom[width], `${key} C4 at ${width}px`);
			compare(report.keyboard[width], recorded.keyboard[width], `${key} C7 at ${width}px`);
		}
		return;
	}

	const budget = budgets[screen];
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
