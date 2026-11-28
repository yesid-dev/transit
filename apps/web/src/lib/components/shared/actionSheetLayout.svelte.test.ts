import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { actionSheetLayout } from './actionSheetLayout.svelte.ts';

describe('actionSheetLayout focusTitle', () => {
	let frames: FrameRequestCallback[];

	beforeEach(() => {
		frames = [];
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
			frames.push(callback);
			return frames.length;
		});
		vi.spyOn(window, 'matchMedia').mockImplementation(
			(query) =>
				({
					matches: query.includes('min-width: 768px'),
					media: query,
					addEventListener() {},
					removeEventListener() {},
				}) as unknown as MediaQueryList,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	function runFrames() {
		while (frames.length) frames.shift()!(performance.now());
	}

	function openWindow() {
		const button = document.createElement('button');
		button.textContent = 'Cite';
		const dialog = document.createElement('div');
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('data-state', 'open');
		const title = document.createElement('h2');
		title.tabIndex = -1;
		const link = document.createElement('a');
		link.href = '#method';
		dialog.append(title, link);
		document.body.append(button, dialog);
		button.focus();
		const event = new CustomEvent('focusScope.onOpenAutoFocus', { cancelable: true });
		actionSheetLayout().focusTitle(event, title);
		return { button, dialog, title, link, event };
	}

	it('moves focus to the title of a window that is still open', () => {
		const { title, event } = openWindow();
		expect(event.defaultPrevented).toBe(true);
		runFrames();
		expect(document.activeElement).toBe(title);
	});

	it('leaves focus on the button when the window closes before its first frames', () => {
		const { button, dialog } = openWindow();
		// Escape closes the window; it stays in the page while it fades out.
		dialog.setAttribute('data-state', 'closed');
		runFrames();
		expect(document.activeElement).toBe(button);
	});

	it('keeps focus that already moved into the window', () => {
		const { link } = openWindow();
		link.focus();
		runFrames();
		expect(document.activeElement).toBe(link);
	});
});
