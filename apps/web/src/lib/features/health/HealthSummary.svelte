<script lang="ts">
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import InfoIcon from '@lucide/svelte/icons/info';
	import { StatusDot } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { LiveStore } from '#lib/v1/live/store.svelte.ts';
	import { getV1Runtime } from '#lib/v1/runtime.ts';
	import type { DataHealth, HistoricAvailabilityIndex, Manifest } from '#lib/v1/schemas/index.ts';
	import { recordGate, recordStamp } from '#lib/v1/stamp.ts';
	import { copy } from './health.copy';
	import { healthSummary, type HealthSummaryFacts } from './selectors/healthSummary';

	interface Props {
		manifest?: Manifest;
		/** The page's one live vehicles store. */
		live: LiveStore | null;
		dataHealth: DataHealth | null;
		/** Data health finished loading at least once, whether or not it returned a document. */
		dataHealthSettled?: boolean;
		historyIndex: HistoricAvailabilityIndex | null;
		gaps: readonly string[];
		locale: Locale;
	}
	let {
		manifest,
		live,
		dataHealth,
		dataHealthSettled = false,
		historyIndex,
		gaps,
		locale,
	}: Props = $props();

	// Column 1 reads the live store, so its age and staleness match every live stamp on the site.
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
		// Loading: claim nothing yet. Settled without a document: the check is unknown, said in words.
		gate: dataHealth ? recordGate(dataHealth) : dataHealthSettled ? 'unavailable' : undefined,
		gaps,
	});
	const shown = $derived(say(facts));
	const titles = $derived(copy[locale].summary.columns);
	// Each line holds every sentence it may still show; the tallest sets its height. The record line
	// always holds its dated form, so dates arriving, never arriving or failing to reload move nothing.
	const holds = $derived.by(() => {
		const { record } = facts;
		const day = record.publishedOn ?? record.dataThrough ?? '2000-12-31'; // sizing only
		const dated = { ...record, dataThrough: day, publishedOn: day };
		const current = { ageSeconds: 3540, isStale: false };
		const lives = provider
			? [current, { ...current, isStale: true }, { ...current, ageSeconds: null }]
			: [];
		// While data health loads, hold the outcomes its first answer most often gives.
		const gates =
			facts.gate === undefined ? [{ verdict: 'pass' }, null, 'unavailable' as const] : [facts.gate];
		const outcomes = lives.flatMap((alive) =>
			[record, dated].flatMap((r) =>
				gates.map((gate) => say({ ...facts, live: alive, record: r, gate })),
			),
		);
		return (key: 'live' | 'record' | 'check' | 'limits') =>
			[...new Set(outcomes.map((outcome) => outcome[key]))].filter((hold) => hold != null);
	});
	const columns = $derived([
		{ key: 'live', title: titles.live, lines: ['live'] },
		{ key: 'record', title: titles.record, lines: ['record', 'check'] },
		{ key: 'limits', title: titles.limits, lines: ['limits'] },
	] as const);
</script>

<div class="health-summary" data-slot="health-summary" aria-busy={provider != null && !known}>
	<div class="health-answers">
		{#each columns as column (column.key)}
			<section
				class="health-answer"
				data-answer={column.key}
				aria-labelledby={`health-answer-${column.key}`}
			>
				<h3 class="health-answer-title" id={`health-answer-${column.key}`}>
					{#if column.key === 'live'}
						<span class="health-answer-mark" data-state={shown.liveState ?? 'unknown'}>
							<StatusDot
								color={shown.liveState === 'current'
									? 'on_time'
									: shown.liveState === 'behind'
										? 'caution'
										: 'unknown'}
								aria-hidden="true"
							/>
						</span>
					{:else if column.key === 'record'}
						<CalendarIcon class="health-answer-mark" size={16} aria-hidden="true" />
					{:else}
						<InfoIcon class="health-answer-mark" size={16} aria-hidden="true" />
					{/if}
					<span>{column.title}</span>
				</h3>
				{#each column.lines as key (key)}
					{@const text = shown[key]}
					{@const held = holds(key)}
					{#if text || held.length > 0}<p>
							{#each held as hold (hold)}<span aria-hidden="true">{hold}</span>{/each}<span
								>{text ?? ''}</span
							>
						</p>{/if}
				{/each}
			</section>
		{/each}
	</div>
</div>

<style>
	.health-summary {
		display: flex;
		flex-direction: column;
		container: health-summary / inline-size;
		min-width: 0;
	}
	.health-answers {
		display: flex;
		flex-direction: column;
	}
	.health-answer {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
		padding-block: 1rem;
		border-top: 1px solid var(--border-subtle);
		font-size: var(--text-reading);
		line-height: 1.6;
		color: var(--foreground);
	}
	.health-answer:first-child {
		padding-top: 0;
		border-top: 0;
	}
	.health-answer:last-child {
		padding-bottom: 0;
	}
	.health-answer-title {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin: 0;
		font-size: var(--text-small);
		font-weight: 600;
		line-height: 1.4;
		color: var(--foreground);
	}
	.health-answer-title :global(.health-answer-mark) {
		flex: none;
		color: var(--muted-foreground);
	}
	.health-answer-mark {
		display: inline-flex;
		inline-size: 1rem;
		justify-content: center;
	}
	/* The shown sentence and its invisible alternatives share one cell: the tallest sets the height. */
	.health-answer p {
		display: grid;
		margin: 0;
	}
	.health-answer p > span {
		grid-area: 1 / 1;
	}
	.health-answer p > [aria-hidden='true'] {
		visibility: hidden;
	}
	@media (--desktop-min) {
		.health-answer {
			font-size: var(--text-reading-desktop);
		}
	}
	/* Three columns side by side once each can hold a readable line: 4 + 4 + 4. */
	@container health-summary (min-width: 44rem) {
		.health-answers {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
		.health-answer,
		.health-answer:first-child,
		.health-answer:last-child {
			padding: 0 1.5rem;
			border-top: 0;
			border-inline-start: 1px solid var(--border-subtle);
		}
		.health-answer:first-child {
			padding-inline-start: 0;
			border-inline-start: 0;
		}
		.health-answer:last-child {
			padding-inline-end: 0;
		}
		/* Narrow columns read better at the answer size than at the long-reading size. */
		.health-answer {
			font-size: var(--text-subheading);
		}
	}
</style>
