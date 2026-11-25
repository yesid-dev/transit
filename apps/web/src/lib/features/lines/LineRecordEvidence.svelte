<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordEvidence, RecordMeasure } from '#lib/server/engine.ts';
	import { countedUnit, methodEvidence } from '#lib/site/presenter.ts';

	type Evidence = RecordEvidence & Partial<Pick<RecordMeasure['evidence'], 'counts' | 'trip_ids'>>;
	let { evidence, locale }: { evidence: Evidence; locale: Locale } = $props();
	const trips = $derived(evidence.trip_ids?.length ?? evidence.counts?.observed_trips);
	const sample = $derived(
		[
			evidence.counts?.classified == null
				? null
				: countedUnit(evidence.counts.classified, 'event', locale),
			trips == null ? null : countedUnit(trips, 'trip', locale),
			evidence.days_included.length
				? countedUnit(evidence.days_included.length, 'day', locale)
				: null,
		]
			.filter(Boolean)
			.join(', '),
	);
</script>

<div
	class="flex min-w-0 grow basis-56 flex-wrap justify-between gap-x-3 font-mono text-small text-muted-foreground"
>
	{#if sample}<span>{sample}</span>{/if}
	<span>{methodEvidence(evidence, locale, true)}</span>
</div>
