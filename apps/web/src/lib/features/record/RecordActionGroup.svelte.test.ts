import { fireEvent, render } from '@testing-library/svelte';
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
