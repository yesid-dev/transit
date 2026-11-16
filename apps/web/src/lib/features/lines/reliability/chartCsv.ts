import type {
	ChartSpec,
	HeatmapSpec,
	HistogramSpec,
	LineSpec,
	StackedShareSpec,
} from '#lib/components/dataviz/chart/ChartSpec.ts';
import { csvCount, csvNumber, csvPercent, type CsvCell, type CsvRow } from './recordCsv';
import { rounded } from './recordCsvModels';

export const CHART_COLUMNS = [
	'key',
	'label',
	'group',
	'value',
	'reference_mean',
	'reference_p50',
	'reference_p90',
	'lower_bound',
	'upper_bound',
	'lower_open',
	'upper_open',
] as const;
const valid = (value: number | null | undefined, unit: string) =>
	unit.trim() === '%' ? csvPercent(value) : csvNumber(value);

function row(
	measure: string,
	unit: string,
	cells: CsvRow['cells'],
	readings?: number | null,
): CsvRow {
	return {
		measure,
		unit,
		readings,
		state: cells[3] == null ? 'not_published' : 'published',
		cells: [...cells, ...Array<CsvCell>(CHART_COLUMNS.length).fill(null)].slice(
			0,
			CHART_COLUMNS.length,
		),
	};
}

function lineRows(spec: LineSpec, measure: string): CsvRow[] {
	return spec.series.flatMap((series) =>
		series.points.map((point, i) =>
			row(measure, spec.unit.trim(), [
				String(i),
				spec.xLabels[i],
				series.label,
				valid(point, spec.unit),
			]),
		),
	);
}

function heatmapRows(spec: HeatmapSpec, measure: string): CsvRow[] {
	return spec.cells.flatMap((cells, i) =>
		cells.map((cell, j) =>
			row(measure, 'row_relative_score', [
				`${i}:${j}`,
				spec.fullRowLabels?.[i] ?? spec.rowLabels[i],
				spec.colLabels[j],
				csvNumber(cell.value),
			]),
		),
	);
}

function histogramRows(spec: HistogramSpec, measure: string): CsvRow[] {
	const minutes = (sec: number | null | undefined) => rounded(sec == null ? null : sec / 60);
	return spec.bins.map((bin, i) =>
		row(measure, 'readings; min', [
			String(i),
			null,
			null,
			csvCount(bin.count),
			null,
			minutes(spec.medianRef),
			minutes(spec.p90Ref),
			minutes(bin.lo),
			minutes(bin.hi),
			bin.lo == null ? 'unbounded' : 'bounded',
			bin.hi == null ? 'unbounded' : 'bounded',
		]),
	);
}

/** A whole day-type/weekday panel includes its explicit absent cells, without inventing bands. */
export function mixPanelRows(
	cells: readonly { readonly label: string; readonly spec: StackedShareSpec | null }[],
	measure: string,
): CsvRow[] {
	return cells.flatMap((cell) =>
		cell.spec
			? chartRows(cell.spec, measure).map((r) => ({
					...r,
					cells: r.cells.map((v, i) => (i === 2 ? cell.label : v)),
				}))
			: [row(measure, '%', [null, null, cell.label, null])],
	);
}

/** Line-specific adapters for the exact normalized specifications rendered beside each control. */
export function chartRows(spec: ChartSpec | null, measure: string): CsvRow[] {
	if (!spec || spec.kind === 'absence') return [];
	switch (spec.kind) {
		case 'line':
			return lineRows(spec, measure);
		case 'heatmap':
			return heatmapRows(spec, measure);
		case 'histogram':
			return histogramRows(spec, measure);
		case 'dot-strip':
			return spec.points.map((point) =>
				// This line UI captions medianRef as a mean; keep that meaning in the file.
				row(
					measure,
					spec.unit.trim(),
					[
						point.key,
						point.group,
						null,
						valid(point.value, spec.unit),
						valid(spec.medianRef, spec.unit),
					],
					csvCount(point.n),
				),
			);
		case 'magnitude-bars':
			return spec.rows.map((datum) =>
				row(
					measure,
					spec.unit.trim(),
					[datum.key, datum.label, null, valid(datum.value, spec.unit)],
					csvCount(datum.n),
				),
			);
		case 'stacked-share':
			return spec.segments.map((segment) =>
				row(measure, '%', [
					segment.key,
					segment.label,
					null,
					rounded(csvPercent(segment.share), 0),
				]),
			);
		default:
			return [];
	}
}
