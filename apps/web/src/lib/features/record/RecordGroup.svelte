<script lang="ts">
	import { PageSection, type PageSectionProps } from '@yesid/ui/layout';
	import RecordSkeleton from './RecordSkeleton.svelte';
	import type { RecordWaiting } from './recordWaiting.ts';

	let {
		children,
		class: className,
		density,
		waiting,
		...rest
	}: PageSectionProps & { density?: 'compact'; waiting?: RecordWaiting } = $props();
</script>

<!-- Keep the answer and its first cards in one group, and About these figures in the last.
     Cards inside a group and the space on each side of a section edge share the kit's card gap
     (holistic pass F3), so stacked cards and grids of cards sit the same distance apart. -->
<PageSection
	{...rest}
	data-record-pending={waiting ? '' : undefined}
	aria-busy={waiting ? 'true' : undefined}
	class={[
		'grid min-w-0 grid-cols-1 gap-(--space-card-gap) py-(--space-card-gap) first:pt-0 last:pb-0 print:py-0',
		'record-group',
		density === 'compact' && 'max-sm:gap-4',
		className,
	]}
>
	{#if waiting}<RecordSkeleton shape={waiting} />{/if}
	{@render children()}
</PageSection>

<style>
	/* Keep the first cards under a legacy answer in place while their readings stream. */
	:global(.record-group):has(> :global([data-slot='screen-answer']) > :global(.plain-answer))
		:global([data-slot='record-card-body']:has(> [data-record-pending])) {
		min-block-size: 13.5rem;
	}
</style>
