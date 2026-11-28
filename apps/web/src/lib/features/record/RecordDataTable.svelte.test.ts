import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import RecordDataTableHarness from './RecordDataTableHarness.svelte';

it.each([
	[
		'en',
		'Measured stops',
		'Showing 20 of 25',
		'Show 5 more',
		'Unknown',
		'Readings: Reverse the order',
	],
	[
		'fr',
		'Arrêts mesurés',
		'20 sur 25',
		'Afficher 5 de plus',
		'Inconnu',
		'Passages\u00a0: Inverser l’ordre',
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
		const firstStop = table.getByRole('link', { name: /Station 1$/u });
		expect(firstStop).toHaveAttribute('href', '/stop/1');
		expect(within(firstStop).getByText('01234')).toHaveClass('outlined');
		expect(table.getByText(unknown)).toBeVisible();
		expect(screen.getByRole('status')).toHaveTextContent(showing);
		expect(screen.getByRole('button', { name: more })).toBeEnabled();
		await fireEvent.click(sortButton);
		expect(header).toHaveAttribute('aria-sort', 'descending');
		expect(table.getAllByRole('link')).toHaveLength(20);
		expect(table.getAllByRole('link')[0]).toHaveTextContent('Station 25');
	},
);

afterEach(() => vi.restoreAllMocks());

it.each([
	['en', 'Measured stops', 'Station 3', '3 readings'],
	['fr', 'Arrêts mesurés', 'Station 3', '3 passages'],
] as const)(
	'shows one phone row per entry: name, bold value, one sentence, no column names, in %s',
	(locale, title, name, line) => {
		vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
		const { container } = render(RecordDataTableHarness, { locale, phone: true });
		expect(screen.getAllByRole('table')).toHaveLength(1);
		const table = within(screen.getByRole('table', { name: title }));
		expect(table.getAllByRole('columnheader')).toHaveLength(1);
		const row = table.getByRole('link', { name: new RegExp(`${name}$`, 'u') }).closest('tr')!;
		expect(row.querySelector('.phone-value')).toHaveTextContent(/^3$/u);
		expect(row.querySelector('.phone-line')).toHaveTextContent(line);
		expect(container.querySelector('[data-row-position="value"]')).toBeNull();
		expect(table.getAllByRole('link')).toHaveLength(20);
	},
);

it('keeps the wide table while the frame has no width yet', () => {
	render(RecordDataTableHarness, { locale: 'en', phone: true });
	expect(screen.getAllByRole('table')).toHaveLength(1);
	expect(screen.getAllByRole('columnheader')).toHaveLength(2);
});
