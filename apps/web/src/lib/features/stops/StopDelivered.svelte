<script lang="ts">
	import { isSettled, type Awaitable } from '#lib/site/ready.ts';
	import type { StampProps } from '@yesid/ui/brand';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, RecordAnswer } from '#lib/server/engine.ts';
	import { page } from '$app/state';
	import {
		cityAgency,
		countedUnit,
		recordPercent,
		sampleWithMinimum,
		tripOutcomeLabels,
		tripsRunBase,
		tripsRunShareLabel,
		unconfirmedTripsRange,
	} from '#lib/site/presenter.ts';
	import { chartState } from '../record/charts/recordCharts.ts';
	import FactList from '../record/FactList.svelte';
	import FactRow from '../record/FactRow.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { choose, lastGoodNote, recordMessage, tally } from '../record/recordText.ts';
	import { pendingBlockSize } from '../record/recordWaiting.ts';
	import { tripOutcomes } from '../record/tripOutcomes.ts';

	let {
		locale,
		stamp,
		answer,
	}: {
		locale: Locale;
		stamp: StampProps;
		answer: Awaitable<EngineResult<RecordAnswer>>;
	} = $props();
	const shape = 'trip-facts';
	const block = pendingBlockSize(shape);
	const heading = $derived(
		choose(locale, 'Trips that ran at this stop', 'Trajets effectués à cet arrêt'),
	);
	const labels = $derived(tripOutcomeLabels(locale, cityAgency(page.data.provider)));
	// Only a result drawn with the page: one that streams in after keeps the held height, so the
	// screen does not move under the reader.
	const settled = $derived(isSettled(answer) ? answer : undefined);
	/** Drawn on a short state, the card gives back the height it holds for the trip facts. */
	const empty = $derived(
		settled !== undefined &&
			settled.kind !== 'busy' &&
			!(
				settled.kind === 'answer' &&
				'value' in settled.answer &&
				settled.answer.state === 'measured'
			),
	);
</script>

<section id="delivery" class="grid min-w-0">
	<RecordCard title={heading} {stamp} reserve={empty ? undefined : shape}>
		<div
			class="reading"
			class:held={!empty}
			data-settled-empty={empty ? '' : undefined}
			style:--delivery-wide={block?.wide}
			style:--delivery-phone={block?.phone}
		>
			{#await answer}
				{#key answer}<RecordPending {locale} {answer} {shape} />{/key}
			{:then result}
				{#if result.kind === 'busy'}
					<RecordPending {locale} {shape} busy />
				{:else}
					{@const data =
						result.kind === 'answer' && 'value' in result.answer ? result.answer : null}
					{@const outcomes = data?.state === 'measured' ? tripOutcomes(data.evidence) : null}
					{@const share = data?.value.trips_run}
					{@const info = data?.info?.find(({ id }) => id === 'trips_run')}
					{@const method = info?.text?.[locale]}
					{#if outcomes && share != null}
						{@const range = unconfirmedTripsRange(
							outcomes.ran,
							outcomes.known,
							outcomes.statusUnknown,
							locale,
						)}
						{@const added = data?.evidence.excluded?.added}
						<FactList leading={false}>
							<FactRow
								label={tripsRunShareLabel(locale)}
								labelDetail={tripsRunBase(outcomes.ran, outcomes.known, locale)}
								emphasis
							>
								{recordPercent(share, locale)}
							</FactRow>
							{#each [[labels.cancelled, outcomes.cancelled], [labels.missing, outcomes.missing], [choose(locale, 'Added trips, counted separately', 'Trajets ajoutés, comptés à part'), added]] as const as [label, count] (label)}
								{#if count != null}
									<FactRow {label}>{tally(count, locale)}</FactRow>
								{/if}
							{/each}
						</FactList>
						{#if range}<p class="mt-3 text-small text-muted-foreground">{range}</p>{/if}
					{:else}
						{@const message = recordMessage(result, locale)}
						<p>
							<StateMark
								state={chartState(data?.state === 'measured' ? 'unknown' : data?.state)}
								{locale}
								hiddenLabel={message !== null}
							/>
							{message ?? ''}
						</p>
						{#if data?.state === 'too_few_to_judge' && data.evidence.counts.eligible != null && info?.minimum_sample != null}
							<p class="mt-2 text-small text-muted-foreground">
								{sampleWithMinimum(
									countedUnit(data.evidence.counts.eligible, 'trip', locale),
									info.minimum_sample,
									locale,
								)}
							</p>
						{/if}
					{/if}
					{#if method?.definition}<p class="mt-3 text-small text-muted-foreground">
							{method.definition}
							{choose(
								locale,
								'An outcome applies to the whole trip.',
								'L’issue s’applique au trajet entier.',
							)}
						</p>{/if}
					{#if result.kind === 'answer' && result.lastGood}
						<p class="mt-3 text-small text-muted-foreground">{lastGoodNote[locale]}</p>
					{/if}
				{/if}
			{/await}
		</div>
	</RecordCard>
</section>

<style>
	.held {
		min-block-size: var(--delivery-wide);
	}

	@media (width < 40rem) {
		.held {
			min-block-size: var(--delivery-phone);
		}
	}
</style>
