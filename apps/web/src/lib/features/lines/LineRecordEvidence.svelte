<script lang="ts" module>
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordEvidence, RecordMeasure } from '#lib/server/engine.ts';
	import { countedUnit } from '#lib/site/presenter.ts';

	type Evidence = RecordEvidence & Partial<Pick<RecordMeasure['evidence'], 'counts' | 'trip_ids'>>;
	export function lineEvidenceSample(evidence: Evidence, locale: Locale) {
		const trips = evidence.trip_ids?.length ?? evidence.counts?.observed_trips;
		return [
			evidence.counts?.classified == null
				? null
				: countedUnit(evidence.counts.classified, 'event', locale),
			trips == null ? null : countedUnit(trips, 'trip', locale),
			evidence.days_included.length
				? countedUnit(evidence.days_included.length, 'day', locale)
				: null,
		]
			.filter(Boolean)
			.join(', ');
	}
</script>

<script lang="ts">
	import RecordEvidenceLine from '../record/RecordEvidenceLine.svelte';

	let { evidence, locale }: { evidence: Evidence; locale: Locale } = $props();
	// A card's foot carries its own sample; a span of days with nothing counted is no sample.
	const counted = $derived(
		evidence.counts?.classified != null ||
			(evidence.trip_ids?.length ?? evidence.counts?.observed_trips) != null,
	);
	const sample = $derived(counted ? lineEvidenceSample(evidence, locale) : null);
</script>

<RecordEvidenceLine {evidence} {locale} {sample} />
