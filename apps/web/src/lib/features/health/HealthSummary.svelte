<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import type { LiveStore } from '#lib/v1/live/store.svelte.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import type { DataHealth, HistoricAvailabilityIndex, Manifest } from '#lib/v1/schemas/index.ts';
	import { recordGate, recordStamp } from '#lib/v1/stamp.ts';
	import { healthSummary, type HealthSummaryFacts } from './selectors/healthSummary';

	interface Props {
		manifest?: Manifest;
		/** The page's one live vehicles store. */
		live: LiveStore | null;
		dataHealth: DataHealth | null;
		historyIndex: HistoricAvailabilityIndex | null;
		gaps: readonly string[];
		locale: Locale;
	}
	let { manifest, live, dataHealth, historyIndex, gaps, locale }: Props = $props();

	// Line 1 reads the live store, so its age and staleness match every live stamp on the site.
	const clock = getV1Runtime().clock;
	$effect(() => clock.subscribe());
	const provider = $derived(manifest?.provider);
	const health = $derived(live?.familyStates.vehicles.health);
	// After the first answer, a failure or retry keeps an unknown age rather than blanking the line.
	const known = $derived(health && health.state !== 'never-loaded' ? health : null);
	const say = (facts: HealthSummaryFacts) => healthSummary(facts, locale, manifest?.tz);
	const facts = $derived<HealthSummaryFacts>({
		live: known ?? null,
		record: recordStamp({ manifest: manifest ?? null, historyIndex }),
		gate: recordGate(dataHealth),
		gaps,
	});
	// Each line holds every sentence it may still show; the tallest sets its height. The record line
	// always holds its dated form, so dates arriving, never arriving or failing to reload move nothing.
	const slots = $derived.by(() => {
		const { record } = facts;
		const day = record.publishedOn ?? record.dataThrough ?? '2000-12-31'; // sizing only
		const dated = { ...record, dataThrough: day, publishedOn: day };
		const current = { ageSeconds: 3540, isStale: false };
		const lives = provider
			? [current, { ...current, isStale: true }, { ...current, ageSeconds: null }]
			: [];
		const outcomes = lives.flatMap((alive) =>
			[record, dated].map((r) => say({ ...facts, live: alive, record: r })),
		);
		const shown = say(facts);
		return (['live', 'record', 'doubt'] as const).map((key) => ({
			text: shown[key],
			holds: [...new Set(outcomes.map((outcome) => outcome[key]))].filter((hold) => hold != null),
		}));
	});
</script>

<div class="health-summary" data-slot="health-summary" aria-busy={provider != null && !known}>
	{#each slots as slot, index (index)}
		{#if slot.text || slot.holds.length > 0}<p>
				{#each slot.holds as hold (hold)}<span aria-hidden="true">{hold}</span>{/each}<span
					>{slot.text ?? ''}</span
				>
			</p>{/if}
	{/each}
</div>

<style>
	.health-summary {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		font-size: var(--text-reading);
		line-height: 1.7;
		color: var(--foreground);
	}
	/* The shown sentence and its invisible alternatives share one cell: the tallest sets the height. */
	.health-summary p {
		display: grid;
		margin: 0;
	}
	.health-summary p > span {
		grid-area: 1 / 1;
	}
	.health-summary p > [aria-hidden='true'] {
		visibility: hidden;
	}
	@media (--desktop-min) {
		.health-summary {
			font-size: var(--text-reading-desktop);
		}
	}
</style>
