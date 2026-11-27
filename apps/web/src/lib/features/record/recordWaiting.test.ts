import { describe, expect, it } from 'vitest';
import {
	pendingBlockSize,
	resolveWaiting,
	screenWaitingWords,
	skeletonBlockSize,
} from './recordWaiting.ts';

const px = (size: string | null) => (size ? Number(size.replace('rem', '')) * 16 : null);

describe('skeleton heights follow the measured filled parts', () => {
	it.each([
		['facts (3)', 'facts', 132],
		['facts (2)', { shape: 'facts', count: 2 }, 88],
		['trip-facts', 'trip-facts', 264],
		['table (7 rows)', { shape: 'table', rows: 7 }, 32 + 7 * 44],
		['table without header', { shape: 'table', rows: 4, header: false }, 4 * 44],
		['rows (20, two lines)', { shape: 'rows', count: 20 }, 32 + 20 * 61],
		['rows (3, one line)', { shape: 'rows', count: 3, lines: 1 }, 32 + 3 * 39],
		['bands', 'bands', 28 + 3 * 36 + 2 * 24],
		['grid', 'grid', 333],
		['histogram', 'histogram', 352],
		['ladder (6)', { shape: 'ladder', count: 6 }, 6 * 48],
		['ladder (47), capped with Show all', { shape: 'ladder', count: 47 }, 12 * 48 + 44],
		['notice (4)', { shape: 'notice', count: 4 }, 4 * 127 + 3 * 12],
	] as const)('%s', (_, shape, height) => {
		expect(px(skeletonBlockSize(shape))).toBe(height);
	});

	it('lets the chart frame decide the trend height', () => {
		expect(skeletonBlockSize('trend')).toBe('calc(clamp(12rem, 26vw, 17rem) + 1.5rem)');
	});

	it.each(['answer', 'reading', 'card', 'listing', 'tiles'] as const)(
		'lets the %s shape follow its layout',
		(shape) => {
			expect(skeletonBlockSize(shape)).toBeNull();
		},
	);

	it('never draws zero or a fraction of a row', () => {
		expect(resolveWaiting({ shape: 'rows', count: 0 }).count).toBe(1);
		expect(resolveWaiting({ shape: 'facts', count: 2.4 }).count).toBe(2);
		expect(resolveWaiting({ shape: 'facts', count: Number.NaN }).count).toBe(3);
	});
});

describe('a waiting card keeps a foot line for its words', () => {
	// The shape, an 8 px gap, then one 22 px line (two, 44 px, on a phone).
	it.each([
		['facts (4)', { shape: 'facts', count: 4 }, 206, 228],
		['trip-facts', 'trip-facts', 294, 401],
		['table (7 rows)', { shape: 'table', rows: 7 }, 370, 392],
		['rows (8, two lines)', { shape: 'rows', count: 8 }, 550, 572],
		['grid', 'grid', 363, 385],
		['histogram', 'histogram', 382, 404],
		['ladder (47)', { shape: 'ladder', count: 47 }, 650, 672],
		['notice (2)', { shape: 'notice', count: 2 }, 296, 318],
	] as const)('%s', (_, shape, wide, phone) => {
		const size = pendingBlockSize(shape);
		expect(px(size?.wide ?? null)).toBe(wide);
		expect(px(size?.phone ?? null)).toBe(phone);
	});

	it('adds the foot line to a chart frame that follows the width', () => {
		expect(pendingBlockSize('trend')?.wide).toBe(
			'calc(calc(clamp(12rem, 26vw, 17rem) + 1.5rem) + 1.875rem)',
		);
	});

	it('lets an answer follow its layout', () => {
		expect(pendingBlockSize('answer')).toBeNull();
	});
});

describe('the screen live region', () => {
	const period = { from: '2026-11-19', to: '2026-11-25' };

	it.each([
		['loading', 'en', 'Loading the record for 19 to 25 Nov 2026.'],
		['loading', 'fr', 'Chargement du bilan du 19 au 25 nov. 2026.'],
		[
			'still',
			'en',
			'Still calculating the record for 19 to 25 Nov 2026. Each card fills in when its answer arrives.',
		],
		[
			'still',
			'fr',
			'Le calcul du bilan du 19 au 25 nov. 2026 se poursuit. Chaque carte se remplit dès que sa réponse arrive.',
		],
		['done', 'en', 'The record is on screen.'],
		['done', 'fr', 'Le bilan est affiché.'],
		['live', 'en', 'Loading live reports…'],
		['live', 'fr', 'Chargement des données en direct…'],
	] as const)('%s in %s', (stage, locale, words) => {
		expect(screenWaitingWords(stage, locale, period)).toBe(words);
	});

	it.each([
		['en', 'Loading the record for 22 Nov 2026.'],
		['fr', 'Chargement du bilan du 22 nov. 2026.'],
	] as const)('names a single day in %s', (locale, words) => {
		expect(screenWaitingWords('loading', locale, { from: '2026-11-22', to: '2026-11-22' })).toBe(
			words,
		);
	});

	it.each([
		['en', 'Loading the record.'],
		['fr', 'Chargement du bilan.'],
	] as const)('reads without dates in %s', (locale, words) => {
		expect(screenWaitingWords('loading', locale)).toBe(words);
	});
});
