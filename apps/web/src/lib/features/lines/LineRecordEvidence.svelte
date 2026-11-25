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
	const sample = $derived(lineEvidenceSample(evidence, locale));
</script>

<RecordEvidenceLine {evidence} {locale} {sample} />
