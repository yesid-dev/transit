import { afterEach, expect, it, vi } from 'vitest';

const observers: ObserverStub[] = [];

class ObserverStub {
	readonly targets = new Set<Element>();
	constructor(readonly callback: (entries: { target: Element }[]) => void) {
		observers.push(this);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	fire(...targets: Element[]) {
		this.callback(targets.map((target) => ({ target })));
	}
}

function element(width: number) {
	const read = vi.fn(() => width);
	const node = {} as HTMLElement;
	Object.defineProperty(node, 'clientWidth', { get: read });
	return { node, read, resize: (next: number) => (width = next) };
}

async function load() {
	vi.resetModules();
	return (await import('./observedSize')).observedSize;
}

afterEach(() => {
	vi.unstubAllGlobals();
	observers.length = 0;
});

it('reads the size only when the observer reports, never while attaching', async () => {
	vi.stubGlobal('ResizeObserver', ObserverStub);
	const observedSize = await load();
	const shell = element(1024);
	const set = vi.fn();

	const detach = observedSize('clientWidth', set)(shell.node);
	expect(shell.read).not.toHaveBeenCalled();
	expect(set).not.toHaveBeenCalled();

	observers[0]!.fire(shell.node);
	expect(set).toHaveBeenLastCalledWith(1024);
	shell.resize(390);
	observers[0]!.fire(shell.node);
	expect(set).toHaveBeenLastCalledWith(390);

	detach?.();
	expect(observers[0]!.targets.has(shell.node)).toBe(false);
});

it('shares one observer and keeps an element observed while another listener remains', async () => {
	vi.stubGlobal('ResizeObserver', ObserverStub);
	const observedSize = await load();
	const chart = element(640);
	const first = vi.fn();
	const second = vi.fn();
	const detachFirst = observedSize('clientWidth', first)(chart.node);
	observedSize('clientWidth', second)(chart.node);
	observedSize('clientWidth', vi.fn())(element(10).node);

	expect(observers).toHaveLength(1);
	detachFirst?.();
	expect(observers[0]!.targets.has(chart.node)).toBe(true);
	observers[0]!.fire(chart.node);
	expect(first).not.toHaveBeenCalled();
	expect(second).toHaveBeenCalledWith(640);
});

it('reads the size straight away where the browser has no resize observer', async () => {
	vi.stubGlobal('ResizeObserver', undefined);
	const observedSize = await load();
	const band = element(1);
	const set = vi.fn();
	observedSize('clientWidth', set)(band.node);
	expect(set).toHaveBeenCalledWith(1);
});
