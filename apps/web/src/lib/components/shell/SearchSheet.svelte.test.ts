import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { goto, pushState } from '$app/navigation';
import { searchTransit } from '#lib/search/transitSearch.ts';
import SearchSheet from './SearchSheet.svelte';

const kit = vi.hoisted(() => ({ popState: () => {} }));
vi.mock('$app/state', async () => {
	const { createPageState } = await import('../../../tests/pageState.svelte.ts');
	const page = createPageState<{ state: App.PageState }>({ state: {} });
	kit.popState = () => page.set({ state: {} });
	return { page: page.page };
});
vi.mock('$app/navigation', async () => {
	const { page } = await import('$app/state');
	return {
		goto: vi.fn(),
		pushState: vi.fn((_url: string, state: App.PageState) => {
			page.state = state;
		}),
	};
});

let back: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	back = vi.spyOn(history, 'back').mockImplementation(() => kit.popState());
});
afterEach(() => {
	kit.popState();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	document.body.replaceChildren();
});

const routes = [{ id: '161', short: '161', long: 'Van Horne', type: 3 }];
const stops = [{ id: 's1', code: '5001', name: 'Van Horne / Querbes', lat: 0, lon: 0 }];

// The shell as the layout renders it: the page beside the header that holds the trigger.
function open(query = 'van') {
	const shell = document.createElement('div');
	shell.dataset.slot = 'app-shell';
	const header = shell.appendChild(document.createElement('div'));
	const behind = shell.appendChild(document.createElement('main'));
	document.body.append(shell);
	const list = searchTransit({ surface: 'list', query }, { routes, stops, vehicles: [] });
	const view = render(
		SearchSheet,
		{
			target: header,
			props: {
				locale: 'en',
				providerId: 'stm',
				url: new URL('https://transit.local/'),
				scope: 'all',
				list,
				query,
				label: 'Search the network',
			},
		},
		{ baseElement: document.body },
	);
	const trigger = view.getByRole('button', { name: 'Search the network' });
	return { ...view, trigger, behind };
}

async function show(view: ReturnType<typeof open>) {
	await fireEvent.click(view.trigger);
	const dialog = await view.findByRole('dialog', { name: 'Search' });
	return { dialog, field: within(dialog).getByRole('combobox', { name: 'Search the network' }) };
}

it('opens a search dialog over an inert page; Escape closes it, keeps the text and returns focus', async () => {
	const view = open();
	expect(view.trigger).toHaveAttribute('aria-haspopup', 'dialog');
	const { dialog, field } = await show(view);
	await waitFor(() => expect(field).toHaveFocus());
	expect(pushState).toHaveBeenCalledWith('', { searchSheet: true });
	expect(view.behind).toHaveAttribute('inert');
	expect(view.trigger.closest('[inert]')).not.toBeNull();
	expect(within(dialog).getByRole('option', { name: 'Line 161 · Van Horne' })).toBeVisible();

	await fireEvent.keyDown(field, { key: 'Escape' });
	await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
	expect(back).toHaveBeenCalledOnce();
	expect(view.behind).not.toHaveAttribute('inert');
	await waitFor(() => expect(view.trigger).toHaveFocus());

	const again = await show(view);
	expect(again.field).toHaveValue('van');
});

it('the back gesture closes the sheet and returns focus to the trigger', async () => {
	const view = open();
	await show(view);
	kit.popState();
	await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
	expect(back).not.toHaveBeenCalled();
	await waitFor(() => expect(view.trigger).toHaveFocus());
});

it('a chosen row replaces the sheet in history and leads to the record', async () => {
	const view = open();
	const { dialog } = await show(view);
	const row = within(dialog).getByRole('option', { name: 'Line 161 · Van Horne' });
	expect(row.closest('[data-sveltekit-replacestate]')).toHaveAttribute(
		'data-sveltekit-replacestate',
		'',
	);
	row.addEventListener('click', (event) => event.preventDefault());
	await fireEvent.click(row);
	await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
	// The link's navigation takes the sheet's entry; nothing goes back, focus follows the new page.
	expect(back).not.toHaveBeenCalled();
	expect(view.trigger).not.toHaveFocus();
	expect(view.behind).not.toHaveAttribute('inert');
});

it('Enter with nothing highlighted opens the search page in place of the sheet', async () => {
	const view = open();
	const { field } = await show(view);
	await fireEvent.keyDown(field, { key: 'Enter' });
	expect(vi.mocked(goto)).toHaveBeenCalledWith(expect.stringMatching(/^\/search\?q=van/), {
		replaceState: true,
	});
	await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
	expect(back).not.toHaveBeenCalled();
});
