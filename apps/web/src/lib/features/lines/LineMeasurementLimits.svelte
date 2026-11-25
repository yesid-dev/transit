<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordCard from '../record/RecordCard.svelte';
	import { choose } from '../record/recordText.ts';

	let {
		locale,
		methodHref,
		scheduleOnly = true,
	}: { locale: Locale; methodHref: string; scheduleOnly?: boolean } = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
</script>

<RecordCard title={t('What cannot be measured', 'Ce qui ne peut pas être mesuré')}>
	<ul class="grid gap-2 list-disc ps-5">
		<li>
			{t(
				'On-time, early and late shares need observed times to compare with the timetable.',
				'Les parts à l’heure, en avance et en retard nécessitent des heures observées à comparer à l’horaire.',
			)}
		</li>
		<li>
			{t(
				'The data cannot show which trips were cancelled or missing.',
				'Les données ne permettent pas de savoir quels trajets ont été annulés ou sont manquants.',
			)}
		</li>
		{#if scheduleOnly}
			<li>
				{t(
					'The agency publishes no vehicle positions for this line.',
					'L’agence ne publie aucune position de véhicule pour cette ligne.',
				)}
			</li>{/if}
		<li>
			{t(
				'This line is excluded from live-data rates and rankings.',
				'Cette ligne est exclue des taux et des classements fondés sur les données en direct.',
			)}
		</li>
	</ul>
	{#snippet footer()}
		<a class="inline-flex min-h-11 items-center text-primary underline" href={methodHref}
			>{t('How we measure', 'Comment nous mesurons')}</a
		>
	{/snippet}
</RecordCard>
