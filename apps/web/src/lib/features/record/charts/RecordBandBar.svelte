<script lang="ts">
	import { StatusMark } from '@yesid/ui/brand';
	import { BandBar, type BandBarBand } from '@yesid/ui/chart';

	let { label, bands }: { label: string; bands: readonly BandBarBand[] } = $props();
	const hasTrack = $derived(bands.some(({ share }) => Number.isFinite(share) && share > 0));
	let narrow = $state(0);
</script>

<div class="record-bands">
	<div class="measure" aria-hidden="true" bind:clientWidth={narrow}></div>
	<BandBar {label} {bands} rows={!narrow} />
	{#if narrow || !hasTrack}
		<dl class="mt-3 grid gap-2">
			{#each bands as band (band.id)}
				<div class="flex flex-wrap items-baseline justify-between gap-x-3">
					<dt><StatusMark status={band.status} label={band.label} detail={band.detail} /></dt>
					<dd class="tabular-nums">{band.valueLabel}</dd>
				</div>
			{/each}
		</dl>
	{/if}
</div>

<style>
	.record-bands {
		container-type: inline-size;
	}
	.measure {
		position: absolute;
		inline-size: 0;
		block-size: 0;
	}
	/* The kit's two-column rows can break status words when enlarged text has little room. */
	@container (width < 14rem) {
		.measure {
			inline-size: 1px;
		}
	}
</style>
