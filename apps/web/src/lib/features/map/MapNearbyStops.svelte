<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import type { WithDistance } from '#lib/components/map/index.ts';
	import { localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { distanceReading } from '#lib/site/presenter.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import type { SlimStopEntry } from '#lib/v1/repositories/stopsSlim.ts';
	import { trackEvent } from '#lib/site/analytics.ts';
	import type { MapCopy } from './map.copy';
	import MapPanelRow from './MapPanelRow.svelte';

	let {
		locale,
		city,
		copy: t,
		heading,
		stops,
		details,
		onselect,
		onclear,
	}: {
		locale: Locale;
		city: string;
		copy: MapCopy;
		heading: string;
		stops: readonly WithDistance<SlimStopEntry>[];
		details: ReadonlyMap<string, string>;
		onselect: (stop: WithDistance<SlimStopEntry>) => void;
		onclear: () => void;
	} = $props();
	const uid = $props.id();
</script>

<section aria-labelledby={uid} data-slot="map-nearby-stops">
	<div class="flex items-start justify-between gap-2">
		<h2 id={uid} tabindex="-1" class="min-w-0 text-lg font-semibold [overflow-wrap:break-word]">
			{heading}
		</h2>
		<Button
			variant="ghost"
			size="sm"
			type="button"
			class="min-h-11 shrink-0"
			aria-label={t.nearMeClear}
			onclick={onclear}
		>
			{locale === 'fr' ? 'Effacer' : 'Clear'}
		</Button>
	</div>
	{#if stops.length}
		<ul class="list-none p-0">
			{#each stops as stop (stop.id)}
				<MapPanelRow
					code={stop.code ?? stop.id}
					name={stopDisplayName(stop.name)}
					detail={details.get(stop.id)}
					href={localizeHref(`/stop/${encodeURIComponent(stop.id)}?frameMode=live`, locale, city)}
					onselect={() => {
						trackEvent('Nearby Stop');
						onselect(stop);
					}}
				>
					{#snippet value()}{distanceReading(stop.distanceM, locale)}{/snippet}
				</MapPanelRow>
			{/each}
		</ul>
	{:else}
		<p role="status" class="text-sm text-muted-foreground">{t.nearMeNoResults}</p>
	{/if}
</section>
