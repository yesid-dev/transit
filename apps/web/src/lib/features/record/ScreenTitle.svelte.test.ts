import { render } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import ScreenTitle from './ScreenTitle.svelte';

const follows = (a: Node, b: Node) =>
	Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

for (const [locale, label, title, subtitle] of [
	['en', 'All lines', 'Line 51 Édouard-Montpetit', 'Gare Montréal-Ouest to Station Laurier'],
	[
		'fr',
		'Toutes les lignes',
		'Ligne 51 Édouard-Montpetit',
		'Gare Montréal-Ouest à Station Laurier',
	],
] as const)
	it(`puts the parent listing before the plate and the title on one row (${locale})`, () => {
		const view = render(ScreenTitle, {
			props: { title, subtitle, plate: '51', back: { href: '/lines', label }, dot: false },
		});
		const crumb = view.getByRole('link', { name: label });
		const heading = view.getByRole('heading', { level: 1, name: title });
		const plate = view.container.querySelector('.route-code')!;
		expect(crumb).toHaveAttribute('href', '/lines');
		expect(follows(crumb, plate) && follows(plate, heading)).toBe(true);
		// The breadcrumb, the plate and the heading group are siblings of one wrapping row.
		const row = view.container.querySelector('[data-slot="screen-title-row"]')!;
		expect(crumb.parentElement).toBe(row);
		expect(plate.parentElement).toBe(row);
		expect(heading.closest('hgroup')!.parentElement).toBe(row);
		expect(view.getByText(subtitle).closest('hgroup')).toBe(heading.closest('hgroup'));
	});

it('has no breadcrumb on a listing screen', () => {
	const view = render(ScreenTitle, { props: { title: 'Lines', subtitle: 'STM, Montréal' } });
	expect(view.queryByRole('link')).toBeNull();
	expect(view.getByRole('heading', { level: 1 })).toBeTruthy();
});
