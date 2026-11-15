import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, expect, it } from 'vitest';
import { copy } from '../receipt.copy';
import { selectStateCuts } from '../selectors/stateCuts';
import SectionStateCuts from './SectionStateCuts.svelte';

afterEach(cleanup);

it.each(['en', 'fr'] as const)('explains the expanded basis in %s', (locale) => {
	const t = copy[locale].stateCuts;
	const state = selectStateCuts(
		{
			scheduledTripDays: 1,
			deliveredTripDays: 0,
			cancelledTripDays: 2,
			silentTripDays: 0,
			beyondScheduleTripDays: 1,
		},
		{ ...t, fmtSharePct: (n) => (n == null ? null : `${n}%`) },
	);
	render(SectionStateCuts, { state, ...t, locale });
	expect(screen.getByText(t.basis(2, 1, 1))).toBeInTheDocument();
	expect(screen.getByRole('list')).toHaveTextContent('100%');
	expect(screen.queryByText(t.mismatch)).not.toBeInTheDocument();
});

it.each(['en', 'fr'] as const)('explains an unreconciled legacy receipt in %s', (locale) => {
	const t = copy[locale].stateCuts;
	const state = selectStateCuts(
		{ scheduledTripDays: 1, deliveredTripDays: 2, cancelledTripDays: 0, silentTripDays: 0 },
		{ ...t, fmtSharePct: (n) => (n == null ? null : `${n}%`) },
	);
	render(SectionStateCuts, { state, ...t, locale });
	expect(screen.getByText(t.mismatch)).toBeInTheDocument();
	expect(screen.getByRole('list')).not.toHaveTextContent('200%');
});
