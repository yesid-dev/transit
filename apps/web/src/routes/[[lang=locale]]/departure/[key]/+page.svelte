<script lang="ts">
	import { dateRange, delayReading, scheduledClock } from '#lib/site/presenter.ts';
	import { page } from '$app/state';
	import { StateNotice } from '@yesid/ui/feedback';
	import { Surface } from '@yesid/ui/layout';
	import { localizeHref } from '#lib/i18n/index.ts';
	import {
		choose,
		emptyRecord,
		pooledDays,
		punctualityWeighting,
		rateStateText,
		tally,
		timingBasis,
		withCoverage,
	} from '#lib/features/record/recordText.ts';
	import {
		departureDays,
		departureTitles,
		shortDay,
	} from '#lib/features/record/departureDailyText.ts';
	import RecordSection from '#lib/features/record/RecordSection.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import TripDetail from '#lib/features/trips/TripDetail.svelte';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import type { PageData } from './$types';
	import type { RecordAnswer, RecordSeries } from '#lib/server/engine.ts';

	let { data }: { data: PageData } = $props();
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(data.lang, en, fr);
	const n = (count: number) => tally(count, data.lang);
	const line = $derived(display.line(data.identity.line));
	const clock = $derived(scheduledClock(data.identity.departure, data.lang));
	const subject = $derived(
		t(`Line ${line}, ${clock} departure`, `Ligne ${line}, départ de ${clock}`),
	);

	const stopNames = $derived(new Map(Object.entries(data.stopNames)));
	const pinned = $derived.by(() => {
		const url = new URL(page.url.href);
		url.searchParams.set('provider', data.city);
		if (data.mode === 'record') url.searchParams.set('day', data.day);
		return new URL(
			frameHref(url, { mode: data.mode, period: data.period && { ...data.period, preset: null } }),
			url,
		);
	});
	const lineHref = $derived(
		carryFrameState(
			localizeHref(`/lines/${encodeURIComponent(data.identity.line)}`, data.lang, data.city),
			pinned,
		),
	);

	function noObservation(answer: RecordSeries) {
		const scheduled = answer.cells.filter((cell) => (cell.evidence.counts.scheduled ?? 0) > 0);
		const relevant = scheduled.length ? scheduled : answer.cells;
		const state = relevant[0];
		return state && relevant.every((cell) => cell.state === state.state)
			? rateStateText(state, data.lang)
			: emptyRecord(answer.evidence, data.lang);
	}

	function observedStatement(answer: RecordAnswer) {
		if (!('cells' in answer)) return '';
		const { observed, late } = departureDays(answer);
		if (!observed) return noObservation(answer);
		return t(
			`${n(late)} of ${n(observed)} observed days had a late stop.`,
			`Au moins un retard à un arrêt sur ${n(late)} des ${n(observed)} jours observés.`,
		);
	}
</script>

<svelte:head><title>{subject} · Transit</title></svelte:head>

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<a class="w-fit" href={lineHref}>{t('See the line', 'Voir la ligne')}</a>
			<h1>{subject}</h1>
			<p>
				{display.directionLabel(data.identity.direction, data.headsigns, data.lang)}
			</p>
			<nav class="flex flex-wrap gap-x-4" aria-label={t('Departure views', 'Vues du départ')}>
				<a
					class="inline-flex min-h-11 items-center"
					aria-current={data.mode === 'record' ? 'page' : undefined}
					href={frameHref(pinned, { mode: 'record', period: data.period })}
					>{t('Record', 'Bilan')}</a
				>
				<a
					class="inline-flex min-h-11 items-center"
					aria-current={data.mode === 'live' ? 'page' : undefined}
					href={frameHref(pinned, { mode: 'live', period: data.period })}
					>{t('Live now', 'En direct')}</a
				>
			</nav>
			{#if data.mode === 'record' && data.period}<p>{dateRange(data.period, data.lang)}</p>{/if}
		</header>

		{#if data.mode === 'live'}
			{#await data.liveTrips}
				<RecordPending locale={data.lang} />
			{:then trips}
				{#if trips?.length === 1 && trips[0]}
					<TripDetail id={trips[0]} embedded />
				{:else if trips?.length}
					<ul class="grid gap-2">
						{#each trips as id (id)}
							<li>
								<a
									class="inline-flex min-h-11 items-center"
									href={localizeHref(`/trip/${encodeURIComponent(id)}`, data.lang, data.city)}
								>
									{t(`Prediction report for trip ${id}`, `Rapport de prévisions du trajet ${id}`)}
								</a>
							</li>
						{/each}
					</ul>
				{:else}
					<p>
						{t(
							'No live data for this departure today.',
							'Aucune donnée en direct pour ce départ aujourd’hui.',
						)}
					</p>
				{/if}
			{/await}
		{:else if data.period}
			{@const period = data.period}
			{#each data.sections as { section, answer } (section)}
				{@const title = departureTitles[section][data.lang === 'fr' ? 1 : 0]}
				<RecordSection
					{section}
					{title}
					{subject}
					locale={data.lang}
					url={pinned}
					{answer}
					statement={section === 'observed' ? observedStatement : undefined}
				>
					{#snippet controls()}
						{#if section === 'stops'}
							<form
								method="GET"
								action={pinned.pathname + '#stops'}
								class="flex flex-wrap items-end gap-3"
							>
								<input type="hidden" name="provider" value={data.city} />
								<input type="hidden" name="frameMode" value="record" />
								<input type="hidden" name="recordFrom" value={period.from} />
								<input type="hidden" name="recordTo" value={period.to} />
								<label class="grid gap-1">
									{t('Service date', 'Date de service')}
									<input
										class="min-h-11 rounded border px-2"
										type="date"
										name="day"
										value={data.day}
										min={period.from}
										max={period.to}
										required
									/>
								</label>
								<button class="min-h-11 rounded border px-3" type="submit"
									>{t('Show this day', 'Afficher cette journée')}</button
								>
							</form>
						{/if}
					{/snippet}
					{#snippet reading(result)}
						{#if section === 'observed' && 'cells' in result}
							{#if departureDays(result).observed}
								<p>{observedStatement(result)}</p>
							{:else}
								<StateNotice presentation="frameless" title={observedStatement(result)} />
							{/if}
							<p>
								{t(
									'A day is observed if at least one stop event could be classified. The second total counts days with at least one observed late stop.',
									'Une journée est observée si au moins un passage a pu être classé. Le deuxième total compte les journées où au moins un passage observé était en retard.',
								)}
							</p>
						{:else if section === 'delay' && 'value' in result}
							{@const basis = timingBasis(result.evidence.counts, data.lang)}
							{#if basis}<p>{basis}</p>{/if}
							<p>{punctualityWeighting[data.lang]}</p>
							{#if period.from !== period.to}<p>{pooledDays[data.lang]}</p>{/if}
							<dl class="flex flex-wrap gap-4">
								<div>
									<dt>{t('Median', 'Médiane')}</dt>
									<dd>
										{delayReading(
											result.value.median_delay,
											data.lang,
											rateStateText(result, data.lang),
										)}
									</dd>
								</div>
								<div>
									<dt>{t('90th percentile', '90e centile')}</dt>
									<dd>
										{delayReading(
											result.value.p90_delay,
											data.lang,
											rateStateText(result, data.lang),
										)}
									</dd>
								</div>
								{#if result.evidence.counts.classified}
									<div>
										<dt>{t('Observed stop events', 'Passages observés')}</dt>
										<dd>
											{withCoverage(
												n(result.evidence.counts.classified),
												result.evidence,
												data.lang,
											)}
										</dd>
									</div>
								{/if}
							</dl>
						{:else if section === 'stops' && 'cells' in result}
							{#if result.cells.length}
								<RecordTable
									{title}
									headers={[t('Stop', 'Arrêt'), t('Observed delay', 'Retard observé')]}
									rows={result.cells.map((cell) => [
										`${cell.key.stop_sequence}. ${stopNames.get(String(cell.key.stop)) || cell.key.stop}`,
										[
											delayReading(
												cell.evidence.observed_delay_seconds ?? cell.value.median_delay,
												data.lang,
												rateStateText(cell, data.lang),
											),
											timingBasis(cell.evidence.counts, data.lang),
										]
											.filter(Boolean)
											.join('. '),
									])}
								/>
							{:else}
								<p>{emptyRecord(result.evidence, data.lang)}</p>
							{/if}
						{:else if section === 'missed' && 'cells' in result}
							{@const missed = result.cells.filter(
								(cell) =>
									(cell.evidence.counts.cancelled ?? 0) + (cell.evidence.counts.missing ?? 0) > 0,
							)}
							{@const eligibleDays = result.cells.filter(
								(cell) => (cell.evidence.counts.eligible ?? 0) > 0,
							)}
							{#if missed.length}
								<RecordTable
									{title}
									headers={[
										t('Service date', 'Date de service'),
										t('Cancelled', 'Annulés'),
										t('Missing', 'Manquants'),
									]}
									rows={missed.map((cell) => [
										shortDay(String(cell.key.day), data.lang),
										n(cell.evidence.counts.cancelled!),
										n(cell.evidence.counts.missing!),
									])}
								/>
							{:else}
								<p>
									{eligibleDays.length
										? t(
												'No cancellations or missing trips among the departures with known status.',
												'Aucun trajet annulé ou manquant parmi les départs dont l’état est connu.',
											)
										: noObservation(result)}
								</p>
							{/if}
							{#if eligibleDays.length}<p>
									{t(
										`Days with a known trip status: ${n(eligibleDays.length)}.`,
										`Jours avec un trajet à l’état connu : ${n(eligibleDays.length)}.`,
									)}
								</p>{/if}
							<p>
								{t(
									'The agency announced cancelled trips. Missing trips were scheduled but never appeared during continuous capture.',
									'L’agence a annoncé les annulations. Les trajets manquants étaient prévus, mais ne sont jamais apparus pendant une collecte continue.',
								)}
							</p>
						{/if}
					{/snippet}
				</RecordSection>
			{/each}
		{/if}
	</div>
</Surface>
