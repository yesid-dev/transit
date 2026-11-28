<script lang="ts">
	import { observedSize } from '#lib/utils/observedSize.ts';
	import { StatusMark } from '@yesid/ui/brand';
	import { BandBar, type BandBarBand } from '@yesid/ui/chart';
	import ChartDetails from '#lib/components/dataviz/chart/ChartDetails.svelte';
	import type { Snippet } from 'svelte';
	import { getLocale } from '#lib/i18n/index.ts';

	let { label, bands, absent }: { label: string; bands: readonly BandBarBand[]; absent?: Snippet } =
		$props();
	// The tooltip's heading names the band; its row says what the figure is, never the name again.
	const share = getLocale() === 'fr' ? 'Part' : 'Share';
	const readings = $derived(
		bands
			.filter(({ share }) => Number.isFinite(share) && share > 0)
			.map((band) => ({
				key: band.id,
				heading: band.label,
				rows: [
					{ label: share, value: band.valueLabel },
					...(band.detail ? [{ label: '', value: band.detail }] : []),
				],
			})),
	);
	const hasTrack = $derived(bands.some(({ share }) => Number.isFinite(share) && share > 0));
	let narrow = $state(0);
</script>

<div class="record-bands" data-ripple-exempt>
	<div
		class="measure"
		aria-hidden="true"
		{@attach observedSize('clientWidth', (value) => (narrow = value))}
	></div>
	<ChartDetails {label} {readings} targets="[data-slot='band-bar'] [role='img'] > span">
		<BandBar {label} {bands} {absent} rows={!narrow} />
	</ChartDetails>
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
