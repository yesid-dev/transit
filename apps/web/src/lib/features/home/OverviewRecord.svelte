<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { StatusMark } from '@yesid/ui/brand';
	import { StateNotice } from '@yesid/ui/feedback';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, MeasureAnswer, RankingAnswer } from '#lib/server/engine.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';
	import HomeSearch from './HomeSearch.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import {
		lastGoodNote,
		pooledDays,
		shareReading,
		punctualityWeighting,
		timingBasis,
	} from '../record/recordText.ts';
	import RecordRanking from './RecordRanking.svelte';
	import { citationText, comparisonText, dateRange, measureText } from './overviewRecord.ts';

	type Measure = Promise<EngineResult<MeasureAnswer>>;
	type Ranking = Promise<EngineResult<RankingAnswer>>;

	let {
		locale,
		city,
		href,
		record,
	}: {
		locale: Locale;
		city: string;
		href: string;
		record: {
			period: DateWindow;
			previous: DateWindow;
			punctuality: Measure;
			baseline: Measure;
			delivery: Measure;
			lines: Ranking;
			stops: Ranking;
		};
	} = $props();
	const fr = $derived(locale === 'fr');
	const id = $props.id();
</script>

{#snippet reading(promise: Measure, period: DateWindow)}
	{#await promise}
		{#key promise}<RecordPending {locale} answer={promise} />{/key}
	{:then result}
		{#if result.kind === 'answer' && result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
		{#if result.kind === 'answer' && result.answer.state === 'measured'}
			<p>{measureText(result, period, locale)}</p>
		{:else if result.kind === 'busy'}
			<RecordPending {locale} busy />
		{:else}
			<StateNotice presentation="frameless" title={measureText(result, period, locale)} />
		{/if}
		{#if result.kind === 'answer' && result.answer.coverage_note}
			<p>{result.answer.coverage_note[locale]}</p>
		{/if}
	{/await}
{/snippet}

{#snippet citation(promise: Measure, period: DateWindow)}
	{#await promise then result}
		{#if result.kind === 'answer' && result.answer.state === 'measured'}
			<p>{citationText(result.answer, period, locale)}</p>
		{/if}
	{/await}
{/snippet}

<div class="grid gap-6">
	<h1>{fr ? 'Aperçu' : 'Overview'}{city ? ` · ${city}` : ''}</h1>

	<Card edge="neutral" textSize="inherit" spread class="min-w-0 px-4 sm:px-6">
		<section aria-labelledby={`${id}-punctuality`}>
			<h2 id={`${id}-punctuality`}>{fr ? 'Ponctualité' : 'On-time performance'}</h2>
			{#await record.punctuality}
				{#key record.punctuality}<RecordPending {locale} answer={record.punctuality} />{/key}
			{:then current}
				{#if current.kind === 'answer' && current.answer.state === 'measured'}
					{@const answer = current.answer}
					{@const basis = timingBasis(answer.evidence.counts, locale)}
					{#if current.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
					<div class="grid gap-4 sm:grid-cols-3">
						<div>
							<h3><StatusMark status="on_time" label={fr ? 'À l’heure' : 'On time'} /></h3>
							<p>{measureText(current, record.period, locale)}</p>
						</div>
						<div>
							<h3><StatusMark status="late" label={fr ? 'En retard' : 'Late'} /></h3>
							<p>{shareReading(answer, 'late', locale, false)}</p>
						</div>
						<div>
							<h3>
								<StatusMark status="early" label={fr ? 'Départs en avance' : 'Early departures'} />
							</h3>
							<p>{shareReading(answer, 'early', locale, false)}</p>
						</div>
					</div>
					<p>
						{fr
							? 'La part en avance compte les passages observés avec plus d’une minute d’avance.'
							: 'The early share counts observed stop events more than a minute early.'}
					</p>
					{#if basis}<p>{basis}</p>{/if}
				{:else if current.kind === 'busy'}
					<RecordPending {locale} busy />
				{:else}
					{#if current.kind === 'answer' && current.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
					<StateNotice
						presentation="frameless"
						title={measureText(current, record.period, locale)}
					/>
				{/if}
				{#if current.kind === 'answer' && current.answer.coverage_note}<p>
						{current.answer.coverage_note[locale]}
					</p>{/if}
			{/await}
			<p>
				{fr
					? 'Un passage en avance est plus pénalisant qu’un léger retard : une personne qui arrive à l’heure manque le véhicule.'
					: 'An early departure is worse than a small delay because a rider who arrives on time misses the vehicle.'}
			</p>
			<p>{punctualityWeighting[locale]}</p>
			{#if record.period.from !== record.period.to}<p>{pooledDays[locale]}</p>{/if}
		</section>

		<section aria-labelledby={`${id}-previous`}>
			<h2 id={`${id}-previous`}>
				{record.period.from === record.period.to
					? fr
						? 'Même jour de la semaine précédente'
						: 'Same weekday last week'
					: fr
						? 'Période précédente'
						: 'Previous period'}
			</h2>
			{#await record.baseline}
				{#key record.baseline}<RecordPending {locale} answer={record.baseline} />{/key}
			{:then baseline}
				{#if baseline.kind === 'answer' && baseline.answer.state !== 'measured'}
					<p>{dateRange(record.previous, locale)}</p>
				{/if}
				{#if baseline.kind === 'answer' && baseline.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
				{#if baseline.kind === 'answer' && baseline.answer.state === 'measured'}
					{@const basis = timingBasis(baseline.answer.evidence.counts, locale)}
					<p>{measureText(baseline, record.previous, locale)}</p>
					{#if basis}<p>{basis}</p>{/if}
				{:else if baseline.kind === 'busy'}
					<RecordPending {locale} busy />
				{:else}
					<StateNotice
						presentation="frameless"
						title={measureText(baseline, record.previous, locale)}
					/>
				{/if}
				{#if baseline.kind === 'answer' && baseline.answer.coverage_note}
					<p>{baseline.answer.coverage_note[locale]}</p>
				{/if}
				{#await record.punctuality then current}
					{@const change = comparisonText(current, baseline, locale)}
					{#if change}
						<p>{change}</p>
						<p>
							{fr
								? 'La comparaison exige au moins 80 % des jours mesurés et 100 passages observés par période, avec au plus 15 points d’écart de couverture. L’écart doit atteindre un point et son intervalle à 95 % doit exclure zéro pour indiquer une hausse ou une baisse.'
								: 'A comparison requires at least 80% of days measured and 100 observed stop events per period, with coverage within 15 percentage points. A change must reach one point and its 95% interval must exclude zero to indicate an increase or decrease.'}
						</p>
					{/if}
				{/await}
			{/await}
		</section>

		<section aria-labelledby={`${id}-delivery`}>
			<h2 id={`${id}-delivery`}>{fr ? 'Service effectué' : 'Service delivered'}</h2>
			{@render reading(record.delivery, record.period)}
		</section>
	</Card>

	<div class="max-w-md">
		<HomeSearch {locale} />
	</div>

	<Card edge="neutral" textSize="inherit" class="px-4 sm:px-6">
		<section aria-labelledby={`${id}-rankings`}>
			<h2 id={`${id}-rankings`}>
				{fr ? 'Lignes et arrêts à examiner' : 'Lines and stops to investigate'}
			</h2>
			<p>
				{fr
					? 'Les plus faibles taux de ponctualité pour la période choisie.'
					: 'The lowest on-time shares for the selected period.'}
			</p>
			<div class="grid gap-4 sm:grid-cols-2">
				<RecordRanking {locale} kind="line" ranking={record.lines} />
				<RecordRanking {locale} kind="stop" ranking={record.stops} />
			</div>
		</section>
	</Card>

	<div class="grid gap-3">
		{#key href}
			<CopyAction
				text={href}
				label={fr ? 'Copier le lien' : 'Copy link'}
				done={fr ? 'Lien copié.' : 'Link copied.'}
				fallback={fr ? 'Copiez le lien ci-dessous.' : 'Copy the link below.'}
				fallbackLabel={fr ? 'Lien vers cette vue' : 'Link to this view'}
			/>
		{/key}
		<details>
			<summary class="min-h-11 cursor-pointer py-3">{fr ? 'Citer' : 'Cite'}</summary>
			<p>Transit{city ? ` · ${city}` : ''}. {dateRange(record.period, locale)}.</p>
			{@render citation(record.punctuality, record.period)}
			{@render citation(record.baseline, record.previous)}
			{@render citation(record.delivery, record.period)}
		</details>
	</div>
</div>
