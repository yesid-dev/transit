import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import RecordDataTableHarness from './RecordDataTableHarness.svelte';

it.each([
	[
		'en',
		'Measured stops',
		'Showing 20 of 25',
		'Show 5 more',
		'Unknown',
		'Reverse sort by Readings',
	],
	[
		'fr',
		'Arrêts mesurés',
		'20 sur 25',
		'Afficher 5 de plus',
		'Inconnu',
		'Inverser le tri par Passages',
	],
] as const)(
	'pages, links, sorts and shows reading states in %s',
	async (locale, title, showing, more, unknown, sort) => {
		render(RecordDataTableHarness, { locale });
		const table = within(screen.getByRole('table', { name: title }));
		const sortButton = table.getByRole('button', { name: sort });
		const header = sortButton.closest('th');
		expect(header).toHaveAttribute('aria-sort', 'ascending');
		expect(table.getAllByRole('link')).toHaveLength(20);
		expect(table.getByRole('link', { name: 'Station 1' })).toHaveAttribute('href', '/stop/1');
		expect(table.getByText(unknown)).toBeVisible();
		expect(screen.getByRole('status')).toHaveTextContent(showing);
		expect(screen.getByRole('button', { name: more })).toBeEnabled();
		await fireEvent.click(sortButton);
		expect(header).toHaveAttribute('aria-sort', 'descending');
		expect(table.getAllByRole('link')).toHaveLength(20);
		expect(table.getAllByRole('link')[0]).toHaveTextContent('Station 25');
	},
);
