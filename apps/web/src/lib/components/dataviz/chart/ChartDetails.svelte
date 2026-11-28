<script module lang="ts">
	// One chart tooltip is open on a page at a time: opening one closes the one before.
	let closeOpenTooltip: (() => void) | null = null;
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import ChartTooltip from '../ChartTooltip.svelte';
	import ChartDatumPopover from './ChartDatumPopover.svelte';
	import {
		createChartDatumPopover,
		type ChartDatumPopoverModel,
	} from './useChartDatumPopover.svelte';

	let {
		label,
		readings,
		targets = '[data-chart-datum]',
		suspended = false,
		children,
	}: {
		label: string;
		readings: readonly ChartDatumPopoverModel[];
		targets?: string;
		suspended?: boolean;
		children: Snippet;
	} = $props();

	const id = $props.id();
	const popover = createChartDatumPopover();
	let active = $state(-1);
	let keyboard = $state(false);
	let pointerType = '';
	let xPct = $state(50);
	let yPct = $state(50);
	const reading = $derived(readings[active]);
	// A tooltip that has just opened keeps through the scroll that brought its mark into view (a
	// keyboard step or a pointer that scrolled the chart in); a later scroll by the reader closes it.
	let ownScroll = false;

	function hide() {
		active = -1;
		if (closeOpenTooltip === hide) closeOpenTooltip = null;
	}

	function claim() {
		if (closeOpenTooltip !== hide) closeOpenTooltip?.();
		closeOpenTooltip = hide;
	}

	function scrolled() {
		if (active < 0 || ownScroll) return;
		hide();
	}

	function indexOf(root: HTMLElement, target: EventTarget | null, point?: MouseEvent) {
		const direct = target instanceof Element ? target.closest(targets) : null;
		if (!direct && readings.length === 1) return 0;
		// LayerChart puts its own event surface above the SVG data marks.
		const hit =
			direct ??
			(point && targets === '[data-chart-datum]'
				? document
						.elementsFromPoint(point.clientX, point.clientY)
						.map((element) => element.closest(targets))
						.find((element) => element && root.contains(element))
				: null);
		if (!hit || !root.contains(hit)) return readings.length === 1 ? 0 : -1;
		const explicit = hit.getAttribute('data-chart-datum');
		if (explicit !== null) return Number(explicit);
		return Array.from(root.querySelectorAll(targets)).indexOf(hit);
	}

	function anchor(root: HTMLElement, index: number) {
		return (
			Array.from(root.querySelectorAll(`[data-chart-datum="${index}"]`)).find(
				(node) => node.getClientRects().length > 0,
			) ??
			root.querySelectorAll(targets)[index] ??
			root
		);
	}

	function show(root: HTMLElement, index: number, scroll = false) {
		if (!readings[index]) {
			hide();
			return;
		}
		const mark = anchor(root, index);
		claim();
		ownScroll = true;
		if (scroll) mark.scrollIntoView({ inline: 'nearest', block: 'nearest' });
		// Scroll events from that move arrive before the second frame.
		requestAnimationFrame(() => requestAnimationFrame(() => (ownScroll = false)));
		const box = root.getBoundingClientRect();
		const datum = mark.getBoundingClientRect();
		xPct = ((datum.left + datum.width / 2 - box.left) / Math.max(1, box.width)) * 100;
		yPct = ((datum.top + datum.height / 2 - box.top) / Math.max(1, box.height)) * 100;
		active = index;
	}

	function move(event: PointerEvent & { currentTarget: HTMLDivElement }) {
		if (event.pointerType !== 'mouse' || popover.open) return;
		keyboard = false;
		const index = indexOf(event.currentTarget, event.target, event);
		if (index !== active) show(event.currentTarget, index);
	}

	function focus(event: FocusEvent & { currentTarget: HTMLDivElement }) {
		if (!(event.target instanceof Element) || !event.target.matches(':focus-visible')) return;
		keyboard = true;
		const index = indexOf(event.currentTarget, event.target);
		show(event.currentTarget, Math.max(index, 0), true);
	}

	function key(event: KeyboardEvent & { currentTarget: HTMLDivElement }) {
		if (event.target !== event.currentTarget || !readings.length) return;
		const last = readings.length - 1;
		const next =
			event.key === 'Home'
				? 0
				: event.key === 'End'
					? last
					: event.key === 'ArrowRight' || event.key === 'ArrowDown'
						? Math.min(last, active + 1)
						: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
							? Math.max(0, active - 1)
							: null;
		if (next !== null) {
			event.preventDefault();
			keyboard = true;
			show(event.currentTarget, next, true);
		}
	}

	function activate(event: MouseEvent & { currentTarget: HTMLDivElement }) {
		const source = 'pointerType' in event ? event.pointerType : pointerType;
		pointerType = '';
		if (suspended || (source !== 'touch' && source !== 'pen')) return;
		if (
			event.target instanceof Element &&
			event.target.closest('a,button,[role=button],input,select,summary')
		)
			return;
		const index = indexOf(event.currentTarget, event.target, event);
		if (!readings[index]) return;
		const root = event.currentTarget;
		hide();
		popover.openFromTrigger(root, readings[index], anchor(root, index));
	}
</script>

<ChartTooltip
	{id}
	open={!!reading && !popover.open && !suspended}
	{xPct}
	{yPct}
	heading={reading?.heading}
	rows={reading ? [...reading.rows] : []}
	role="group"
	aria-label={label}
	aria-describedby={reading && !popover.open && !suspended ? id : undefined}
	aria-keyshortcuts={readings.length > 1
		? 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End'
		: undefined}
	tabindex={readings.length ? 0 : undefined}
	data-chart-details={readings.length ? '' : undefined}
	data-ripple-exempt
	onpointermove={move}
	onpointerdown={(event) => {
		pointerType = event.pointerType;
	}}
	onpointercancel={() => {
		pointerType = '';
	}}
	onpointerleave={() => {
		if (!keyboard) hide();
	}}
	onfocusin={focus}
	onfocusout={hide}
	onkeydown={key}
	onclick={activate}
>
	{@render children()}
</ChartTooltip>
<ChartDatumPopover controller={popover} />

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape') hide();
	}}
/>
<svelte:document onscrollcapture={scrolled} />
