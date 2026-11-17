<script lang="ts">
	import { SegmentedChoice, type SegmentedChoiceOption } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import { mapReportsCopy } from './mapReports.copy';

	interface Props {
		value: 'map' | 'reports';
		locale: Locale;
		onchange: (next: 'map' | 'reports') => void;
	}

	let { value, locale, onchange }: Props = $props();
	const t = $derived(mapReportsCopy(locale));
	const options = $derived<SegmentedChoiceOption[]>([
		{ key: 'map', label: t.mapTab },
		{ key: 'reports', label: t.reportsTab },
	]);
</script>

<SegmentedChoice
	{options}
	{value}
	label={t.viewSwitchLabel}
	onSelect={(key) => onchange(key === 'reports' ? 'reports' : 'map')}
	data-slot="map-view-switch"
	class="map-view-switch"
/>

<style>
	/* The selected segment is a bordered card state: its text keeps the card foreground pair
	   instead of the primary pair, which cannot carry text in the light theme. */
	:global(.map-view-switch .segmented-choice-segment--active) {
		background-color: var(--card);
		color: var(--foreground);
		box-shadow: inset 0 0 0 2px var(--primary);
	}
</style>
