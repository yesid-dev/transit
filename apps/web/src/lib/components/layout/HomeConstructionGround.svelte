<!--
  The homepage's construction props above the footer (yesid.design's ConstructionProps).

  The ground opens with the props: its height grows from 0 to full as they rise, so no empty gap
  waits under the last card. Nothing a reader can see may move while it opens:
  - the reveal is led by a marker placed above the ground, early enough that the footer stays
    below the bottom of the screen for the whole reveal. The kit reveals while the marker moves
    from 95% to 70% of the viewport height; the footer is lowest-risk at one end or the other, so
    the lead is the larger of 5vh and 30vh less the ground, plus one fast scroll step (120 px):
    the browser counts a shift against where scrolling alone would have put the footer;
  - the props stand on a stage pinned to the ground's top and moved with transform only, so their
    own boxes never move;
  - focus that lands after the ground (the footer) opens it at once: focus events run before the
    browser scrolls the focused element into view, and flushSync writes the change in that task.
    Keys that scroll by a whole page do the same before they scroll: End always, Page Down and
    Space once the ground is within two screens. Opening early never moves anything in view:
    until the ground is fully open the footer is below the screen;
  - with reduced motion the ground holds its full height and the kit shows the props in place.
-->
<script lang="ts">
	import { flushSync } from 'svelte';
	import { ConstructionProps } from '@yesid/ui/brand';

	let marker = $state<HTMLElement>();
	let ground = $state<HTMLElement>();
	// Full until the kit measures: the server-drawn page and a page without JavaScript show the props.
	let progress = $state(1);
	let opened = $state(false);

	function open() {
		if (!opened) flushSync(() => (opened = true));
	}

	function openForFocus(event: FocusEvent) {
		const target = event.target;
		if (!ground || !(target instanceof Node)) return;
		if (ground.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) open();
	}

	function openForPageKeys(event: KeyboardEvent) {
		if (event.key === 'End') open();
		else if (event.key === 'PageDown' || event.key === ' ') {
			if (ground && ground.getBoundingClientRect().top < 2 * window.innerHeight) open();
		}
	}
</script>

<svelte:document onfocusin={openForFocus} onkeydown={openForPageKeys} />

<div class="home-construction" data-slot="home-construction">
	<div bind:this={marker} class="construction-anchor" aria-hidden="true"></div>
	<div
		bind:this={ground}
		class="home-construction-floor"
		style:--ground-progress={opened ? 1 : progress}
		data-opened={opened || undefined}
	>
		<div class="construction-stage">
			<ConstructionProps
				layout="spread"
				floodlight
				revealAt={opened ? undefined : marker}
				bind:progress
			/>
		</div>
	</div>
</div>

<style>
	.home-construction {
		--ground-height: 240px;
		flex-shrink: 0;
	}
	@media (--tablet-max) {
		.home-construction {
			--ground-height: 100px;
		}
	}
	.construction-anchor {
		position: relative;
		inset-block-start: calc(-1 * (max(5vh, 30vh - var(--ground-height)) + 120px));
		block-size: 0;
		inline-size: 1px;
		pointer-events: none;
	}
	.home-construction-floor {
		position: relative;
		block-size: calc(var(--ground-height) * var(--ground-progress, 1));
		overflow: clip;
	}
	.construction-stage {
		position: absolute;
		inset-inline: 0;
		inset-block-start: 0;
		block-size: var(--ground-height);
		transform: translateY(calc((var(--ground-progress, 1) - 1) * var(--ground-height)));
	}
	@media (prefers-reduced-motion: reduce) {
		.home-construction-floor {
			block-size: var(--ground-height);
		}
		.construction-stage {
			transform: none;
		}
	}
</style>
