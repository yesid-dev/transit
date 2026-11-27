import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { getMeasure, getRanking, getRecordAnswer, type EnginePeriod } from './engine.ts';
import { readingFilter } from './readingFilter.ts';
import { overviewSelection } from './screenQuestions.ts';

type Edition = ScheduleEdition | Promise<ScheduleEdition | null> | null;

function scheduleTotals(edition: ScheduleEdition | null) {
	return edition ? { lines: edition.routes.length, stops: edition.stops.length } : null;
}

/**
 * The Overview's readings. With `only`, just the named readings are asked again; the three stops'
 * names come with their ranking.
 */
export function readOverviewRecord(
	scope: EnginePeriod,
	edition: () => Edition,
	only?: ReadonlySet<string>,
) {
	const include = readingFilter(only);
	const questions = overviewSelection(scope);
	const stops = include('stops') ? getRanking(...questions.stops) : undefined;
	const schedule = stops || include('totals') ? edition() : null;
	return {
		punctuality: include('punctuality') ? getMeasure(...questions.punctuality) : undefined,
		baseline: include('baseline') ? getMeasure(...questions.baseline) : undefined,
		delivery: include('delivery') ? getMeasure(...questions.delivery) : undefined,
		lines: include('lines') ? getRanking(...questions.lines) : undefined,
		stops,
		directory: stops
			? Promise.all([schedule, stops]).then(([timetable, ranked]) => {
					if (!timetable || ranked.kind !== 'answer') return [];
					const ids = new Set(ranked.answer.rows.map((row) => row.id));
					return timetable.stops.filter((stop) => ids.has(stop.id));
				})
			: undefined,
		totals: include('totals')
			? schedule instanceof Promise
				? schedule.then(scheduleTotals)
				: scheduleTotals(schedule)
			: undefined,
		trend: include('trend') ? getRecordAnswer(...questions.trend) : undefined,
		previous: questions.previous,
	};
}
