/**
 * The controls rail cards (View, Period and each screen's choices) in their compact form: 12 px of
 * padding and 8 px between a card's label and its controls, so the rail fits a 1280x720 laptop
 * without scrolling. Targets stay 44 px and text keeps its size.
 */
export const railCardStyle = 'padding: calc(var(--spacing) * 3); gap: calc(var(--spacing) * 2);';

/** A short label beside its box ("Line [All]"), so a one-choice card takes one row. */
export const railChoiceRow = 'grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2';
