import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecordCopyButton from './RecordCopyButton.svelte';

const A = 'https://transit.yesid.dev/lines/1?provider=stm&from=2026-11-04&to=2026-11-10';
const B = 'https://transit.yesid.dev/lines/2?provider=stm&from=2026-11-04&to=2026-11-10';
const props = {
	label: 'Copy record link',
	done: 'Link copied',
	fallbackLabel: 'Copy this link:',
	text: A,
};
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function clipboard(writeText: (value: string) => Promise<void>) {
	Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

afterEach(() => {
	cleanup();
	if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
	else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('record copy payload identity', () => {
	it('does not announce a newly selected record after an older copy completes', async () => {
		const old = deferred();
		const writeText = vi.fn(() => old.promise);
		clipboard(writeText);
		const view = render(RecordCopyButton, { props });
		await fireEvent.click(screen.getByRole('button', { name: props.label }));
		await view.rerender({ ...props, text: B });
		old.resolve();
		await old.promise;
		await tick();
		expect(writeText).toHaveBeenCalledWith(A);
		expect(screen.getByRole('status')).toHaveTextContent('');
		expect(screen.queryByText('Link copied')).toBeNull();
	});

	it('clears the current announcement if an older payload actually finishes writing last', async () => {
		const first = deferred(),
			second = deferred();
		let actual = '';
		clipboard((value) =>
			(value === A ? first.promise : second.promise).then(() => {
				actual = value;
			}),
		);
		const view = render(RecordCopyButton, { props });
		await fireEvent.click(screen.getByRole('button', { name: props.label }));
		await view.rerender({ ...props, text: B });
		await fireEvent.click(screen.getByRole('button', { name: props.label }));
		second.resolve();
		await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Link copied'));
		expect(actual).toBe(B);
		first.resolve();
		await first.promise;
		await tick();
		expect(actual).toBe(A);
		expect(screen.queryByText('Link copied')).toBeNull();
	});

	it('does not open or focus a new record fallback for a rejected old request', async () => {
		const old = deferred();
		clipboard(() => old.promise);
		const view = render(RecordCopyButton, { props });
		await fireEvent.click(screen.getByRole('button', { name: props.label }));
		await view.rerender({ ...props, text: B });
		old.reject(new Error('denied'));
		await old.promise.catch(() => {});
		await tick();
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('retains the selectable fallback for a denied current payload and drops it on selection change', async () => {
		clipboard(async () => {
			throw new Error('denied');
		});
		const view = render(RecordCopyButton, { props });
		await fireEvent.click(screen.getByRole('button', { name: props.label }));
		const fallback = await screen.findByRole('textbox', { name: props.fallbackLabel });
		expect(fallback).toHaveValue(A);
		await view.rerender({ ...props, text: B });
		expect(screen.queryByRole('textbox')).toBeNull();
	});
});
