import { fireEvent, render, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import RecordActionGroup from './RecordActionGroup.svelte';

afterEach(() => vi.restoreAllMocks());

it('creates the direct export only when Download is pressed and releases the anchor', async () => {
	const createDownload = vi.fn(() => ({
		href: 'data:text/csv;charset=utf-8,vehicle_id',
		filename: 'map-reports-stm-en.csv',
	}));
	const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		expect(this.href).toBe('data:text/csv;charset=utf-8,vehicle_id');
		expect(this.download).toBe('map-reports-stm-en.csv');
		expect(this.isConnected).toBe(true);
	});
	const view = render(RecordActionGroup, {
		locale: 'en',
		href: 'https://transit.example/map',
		files: [],
		citation: createRawSnippet(() => ({ render: () => '<p>Citation</p>' })),
		createDownload,
	});
	expect(view.getByRole('button', { name: 'Copy link' })).toBeVisible();
	expect(view.getByRole('button', { name: 'Cite' })).toBeVisible();
	expect(createDownload).not.toHaveBeenCalled();

	await fireEvent.click(view.getByRole('button', { name: 'Download' }));
	expect(createDownload).toHaveBeenCalledOnce();
	expect(click).toHaveBeenCalledOnce();
	expect(document.querySelector('a[download]')).toBeNull();
});

it.each([
	['en', false, 'Cite', 'Cite this record', 'Close'],
	['en', true, 'Cite', 'Cite this record', 'Close'],
	['fr', false, 'Citer', 'Citer ce bilan', 'Fermer'],
	['fr', true, 'Citer', 'Citer ce bilan', 'Fermer'],
] as const)(
	'renders %s Cite and Download (window: %s)',
	async (locale, wide, trigger, title, close) => {
		vi.spyOn(window, 'matchMedia').mockImplementation(
			(query) =>
				Object.assign(new EventTarget(), {
					matches: wide && query === '(min-width: 768px)',
				}) as MediaQueryList,
		);
		const view = render(RecordActionGroup, {
			locale,
			href: 'https://transit.example/record',
			files: [{ href: '/record.csv', label: 'CSV fixture', columns: ['date'] }],
			citation: createRawSnippet(() => ({ render: () => '<p>Citation</p>' })),
		});
		await fireEvent.click(view.getByRole('button', { name: trigger }));
		const dialog = await view.findByRole('dialog', { name: title });
		const closeButtons = within(dialog).getAllByRole('button', { name: close });
		expect(closeButtons).toHaveLength(wide ? 2 : 1);
		await fireEvent.click(closeButtons[0]);

		const fr = locale === 'fr';
		await fireEvent.click(view.getByRole('button', { name: fr ? 'Télécharger' : 'Download' }));
		const download = await view.findByRole('dialog', {
			name: fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files',
		});
		expect(within(download).getByRole('link', { name: 'CSV fixture' })).toBeVisible();
		if (wide) {
			const columns = within(download).getByRole('button', {
				name: fr ? /^Colonnes du CSV/ : /^CSV columns/,
			});
			await fireEvent.click(columns);
			expect(columns).toHaveAttribute('aria-expanded', 'true');
			expect(within(download).getByText('date')).toBeVisible();
		}
	},
);
