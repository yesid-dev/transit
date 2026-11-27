import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { keepFooterFocusInView } from './footerFocus.ts';

const frames: (() => void)[] = [];
const frame = (callback: () => void) => frames.push(callback);
const run = (count: number) => {
	for (let index = 0; index < count && frames.length; index++) frames.shift()!();
};

function page(withGround: boolean) {
	document.body.innerHTML = `${withGround ? '<div class="home-construction-floor"></div>' : ''}<footer><a href="/">Transit</a></footer>`;
	const link = document.querySelector('a')!;
	link.scrollIntoView = vi.fn();
	link.focus();
	return link;
}

const view = 900;

function place(link: HTMLElement, top: number) {
	vi.spyOn(link, 'getBoundingClientRect').mockReturnValue({ top, bottom: top + 44 } as DOMRect);
}

beforeEach(() => {
	vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(view);
});

afterEach(() => {
	frames.length = 0;
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

it('brings a focused footer link back once the opening ground pushes it below the viewport', () => {
	const link = page(true);
	link.addEventListener('focusin', (event) => keepFooterFocusInView(event, frame));
	place(link, view + 200);
	link.dispatchEvent(new FocusEvent('focusin'));
	run(1);
	expect(link.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
	place(link, view - 60);
	run(10);
	expect(link.scrollIntoView).toHaveBeenCalledTimes(1);
	expect(frames).toHaveLength(0);
});

it('leaves pages without the construction ground alone', () => {
	const link = page(false);
	link.addEventListener('focusin', (event) => keepFooterFocusInView(event, frame));
	place(link, view + 200);
	link.dispatchEvent(new FocusEvent('focusin'));
	expect(frames).toHaveLength(0);
	expect(link.scrollIntoView).not.toHaveBeenCalled();
});

it('stops following once focus moves on', () => {
	const link = page(true);
	link.addEventListener('focusin', (event) => keepFooterFocusInView(event, frame));
	place(link, view + 200);
	link.dispatchEvent(new FocusEvent('focusin'));
	link.blur();
	run(1);
	expect(link.scrollIntoView).not.toHaveBeenCalled();
	expect(frames).toHaveLength(0);
});
