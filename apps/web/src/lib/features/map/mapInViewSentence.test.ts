import { expect, it } from 'vitest';
import { inViewSentence } from './mapInViewSentence';

const NB = ' ';
const counts = (early: number, on_time: number, late: number, unknown: number) => ({
	early,
	on_time,
	late,
	unknown,
});

it('lists only the statuses some vehicle has', () => {
	expect(inViewSentence(counts(10, 157, 12, 39), 218, 'en', false)).toBe(
		'vehicles in view now: 10 early, 157 on time, 12 late, 39 with unknown delay.',
	);
	expect(inViewSentence(counts(8, 31, 0, 15), 54, 'fr', false)).toBe(
		`véhicules en vue en ce moment${NB}: 8 en avance, 31 à l’heure, 15 dont le retard est inconnu.`,
	);
});

it('says one vehicle and one shared status in a few words', () => {
	expect(inViewSentence(counts(0, 1, 0, 0), 1, 'en', true)).toBe(
		'vehicle in view at the last report, on time.',
	);
	expect(inViewSentence(counts(0, 1, 0, 0), 1, 'fr', false)).toBe(
		'véhicule en vue en ce moment, à l’heure.',
	);
	expect(inViewSentence(counts(0, 0, 4, 0), 4, 'en', false)).toBe(
		'vehicles in view now: all late.',
	);
	expect(inViewSentence(counts(0, 0, 0, 3), 3, 'fr', false)).toBe(
		`véhicules en vue en ce moment${NB}: retard inconnu pour tous.`,
	);
	expect(inViewSentence(counts(0, 0, 0, 0), 0, 'en', false)).toBe('vehicles in view now.');
});
