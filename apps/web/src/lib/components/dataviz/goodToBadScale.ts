/** Ordered levels run from the best measured reading to the worst. Keep absent states separate. */
export const GOOD_TO_BAD_LEVELS = [0, 1, 2, 3, 4] as const;

export type GoodToBadLevel = (typeof GOOD_TO_BAD_LEVELS)[number];

export function goodToBadStep(level: GoodToBadLevel) {
	return {
		fill: `var(--transit-good-to-bad-${level})`,
		ink: level === 0 ? 'var(--transit-good-to-bad-ink-0)' : 'var(--transit-good-to-bad-ink)',
	};
}
