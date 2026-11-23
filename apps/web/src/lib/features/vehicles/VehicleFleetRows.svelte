<script lang="ts">
	import { StateNotice } from '@yesid/ui/feedback';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordSeries } from '#lib/server/engine.ts';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import { choose, tally } from '#lib/features/record/recordText.ts';

	let {
		cells,
		search,
		locale,
		rowLabel,
	}: {
		cells: RecordSeries['cells'];
		search: string;
		locale: Locale;
		rowLabel: Snippet<[string]>;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const rows = $derived(
		cells.flatMap((cell) => {
			const id = cell.key.vehicle;
			if (typeof id !== 'string' || !id.toLowerCase().includes(search.trim().toLowerCase()))
				return [];
			const days = cell.value.vehicle_days_in_service;
			return [
				[
					id,
					cell.state !== 'measured'
						? cell.state_text[locale]
						: days == null
							? t('Unknown', 'Inconnu')
							: tally(days, locale),
				],
			];
		}),
	);
</script>

{#if rows.length > 0}
	<RecordTable
		title={t('Days in service by vehicle', 'Jours en service par véhicule')}
		headers={[t('Vehicle', 'Véhicule'), t('Days in service', 'Jours en service')]}
		{rows}
		{rowLabel}
	/>
{:else}
	<StateNotice
		role="status"
		presentation="frameless"
		title={t('No matching vehicle number.', 'Aucun numéro de véhicule correspondant.')}
	/>
{/if}
