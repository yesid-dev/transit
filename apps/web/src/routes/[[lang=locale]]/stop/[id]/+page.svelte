<script lang="ts">
	import { page } from '$app/state';
	import { ErrorPage, Surface } from '@yesid/ui/layout';
	import { getLocale, localizeHref } from '#lib/i18n/index.ts';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import StopEngineRecord from '#lib/features/stops/StopEngineRecord.svelte';
	import StopLive from '#lib/features/stops/StopLive.svelte';
	import { stopArchiveAvailability } from '#lib/features/stops/stopRecordText.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { providerDisplayNames, publishedNetwork } from '#lib/site/providerDisplay.ts';
	import { stopViewHref } from '#lib/site/stopFrame.ts';
	import { errorPageCopy } from '#lib/site/errorPage.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const readings = recoverReadings(
		() => data.record,
		({ period: { from, to }, city }) => ({ screen: 'stop', from, to, city, id: data.seed.id }),
	);
	const stopRecord = $derived(readings());
	const locale = getLocale();
	const display = transitDisplay();
	const url = $derived(new URL(page.shallow?.url.href ?? page.url.href));
	const code = $derived(data.stopCode || data.seed.id);
	const stopLabel = $derived(locale === 'fr' ? `Arrêt ${code}` : `Stop ${code}`);
	const name = $derived(data.seed.name === data.seed.id ? null : stopDisplayName(data.seed.name));
	const lines = $derived(data.stopLines.map(display.line).join(', '));
	const timetableNotice =
		locale === 'fr'
			? 'Cet arrêt ne figure pas à l’horaire actuel.'
			: 'This stop is not in the current timetable.';
	const subtitle = $derived(
		data.outsideCurrentTimetable
			? timetableNotice
			: lines
				? locale === 'fr'
					? `${stopLabel}, ${data.stopLines.length === 1 ? 'ligne' : 'lignes'} ${lines}`
					: `${stopLabel}, ${data.stopLines.length === 1 ? 'line' : 'lines'} ${lines}`
				: name
					? stopLabel
					: undefined,
	);
	const operator = $derived(
		providerDisplayNames(
			data.provider ?? publishedNetwork(data.providerId),
			locale,
			data.providerId,
		).short,
	);
	const back = $derived.by(() => {
		const source = new URL(url);
		source.searchParams.set('provider', data.providerId);
		const contentUrl = stopRecord
			? new URL(
					frameHref(source, { mode: 'record', period: { ...stopRecord.period, preset: null } }),
					url,
				)
			: source;
		return {
			href: carryFrameState(localizeHref('/stops', locale, data.providerId), contentUrl),
			label: locale === 'fr' ? 'Tous les arrêts' : 'All stops',
		};
	});
	const missingCopy = errorPageCopy[locale].stopNotFound;
	let confirmed = $state<Promise<'available' | 'missing' | 'unconfirmed'>>();
	$effect(() => {
		const identity = data.stopIdentity;
		let active = true;
		void identity?.then((result) => {
			if (active && result === 'available') confirmed = identity;
		});
		return () => {
			active = false;
		};
	});
	const archive = $derived(
		data.outsideCurrentTimetable && stopRecord ? stopArchiveAvailability(stopRecord) : null,
	);
</script>

{#snippet record()}
	{#if stopRecord}
		<StopEngineRecord
			stop={data.seed}
			code={data.stopCode}
			{operator}
			{locale}
			{url}
			record={stopRecord}
		/>
	{/if}
{/snippet}

<svelte:head>
	{#if data.stopIdentity && confirmed !== data.stopIdentity}
		<meta name="robots" content="noindex" />
	{/if}
</svelte:head>

{#snippet identityStatus(unconfirmed = false)}
	<Surface>
		<RecordScreen>
			<RecordGroup>
				<ScreenTitle id="stop-title" title={stopLabel} {back} dot={false} />
			</RecordGroup>
			<div data-slot="screen-content">
				<RecordGroup>
					{#if unconfirmed}
						<RecordAnswer
							{locale}
							value={null}
							state="unknown"
							sentence={locale === 'fr'
								? 'Le bilan de cet arrêt est temporairement indisponible.'
								: 'The record for this stop is temporarily unavailable.'}
						>
							{#snippet actions()}
								<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={url.href}
									data-sveltekit-reload
								>
									{locale === 'fr' ? 'Réessayer' : 'Try again'}
								</a>
							{/snippet}
						</RecordAnswer>
					{:else}
						<RecordPending {locale} />
					{/if}
				</RecordGroup>
			</div>
		</RecordScreen>
	</Surface>
{/snippet}

{#if data.stopIdentity}
	{#await data.stopIdentity}
		{@render identityStatus()}
	{:then identity}
		{#if identity === 'missing'}
			<ErrorPage
				status={404}
				heading={missingCopy.heading}
				body={missingCopy.body}
				illustration="none"
				suggestionsLabel={errorPageCopy[locale].suggestionsLabel}
				suggestions={missingCopy.suggestions.map(({ href, label }) => ({
					href: localizeHref(href, locale),
					label,
				}))}
			/>
		{:else if identity === 'unconfirmed'}
			{@render identityStatus(true)}
		{:else}
			{@render stopContent()}
		{/if}
	{/await}
{:else}
	{@render stopContent()}
{/if}

{#snippet stopContent()}
	<Surface>
		<RecordScreen>
			<RecordGroup>
				<ScreenTitle
					id="stop-title"
					title={name ?? stopLabel}
					stopCode={name ? code : undefined}
					{subtitle}
					hideSubtitle={data.frameLive && data.outsideCurrentTimetable}
					{back}
					dot={false}
				/>
			</RecordGroup>
			{#if data.frameLive && data.outsideCurrentTimetable}
				<div data-slot="screen-content">
					<RecordGroup>
						<div data-slot="screen-answer" id="stop-detail-departures">
							<RecordAnswer {locale} value={null} state="no_live_data" sentence={timetableNotice}>
								{#snippet actions()}
									<a
										class="inline-flex min-h-11 items-center text-primary underline"
										href={stopViewHref(url, 'record').href}
									>
										{locale === 'fr' ? 'Voir le bilan' : 'View record'}
									</a>
								{/snippet}
							</RecordAnswer>
						</div>
					</RecordGroup>
				</div>
			{:else if data.frameLive}
				{#key data.capture ?? data.seed.id}
					<StopLive
						id={data.seed.id}
						name={name ?? code}
						lines={data.stopLines}
						{operator}
						{locale}
						{url}
						city={data.providerId}
						timeZone={data.provider?.timezone ?? 'UTC'}
						directions={data.schedule?.route_directions}
						patterns={data.linePatterns}
						capture={data.capture}
						trips={data.trips}
						scheduleOnly={data.scheduleOnly}
						tripUpdatesPublished={data.tripUpdatesPublished}
						hasAlerts={data.hasAlerts}
					/>
				{/key}
			{:else if archive}
				{#await archive}
					<div data-slot="screen-content">
						<RecordGroup>
							<div id="punctuality" data-slot="screen-answer">
								<RecordPending {locale} />
							</div></RecordGroup
						>
					</div>
				{:then state}
					{#if state === 'available'}
						{@render record()}
					{:else}
						<div data-slot="screen-content">
							<RecordGroup>
								<div id="punctuality" data-slot="screen-answer">
									{#if state === 'busy'}
										<RecordPending {locale} busy />
									{:else}
										<RecordAnswer
											{locale}
											value={null}
											state={state === 'empty' ? 'not_measured' : 'unknown'}
											sentence={state === 'empty'
												? locale === 'fr'
													? 'Aucune lecture n’a été publiée pour cet arrêt aux dates choisies.'
													: 'No readings were published for this stop on the selected dates.'
												: locale === 'fr'
													? 'Le bilan de cet arrêt est temporairement indisponible.'
													: 'The record for this stop is temporarily unavailable.'}
										/>
									{/if}
								</div>
							</RecordGroup>
						</div>
					{/if}
				{/await}
			{:else}
				{@render record()}
			{/if}
		</RecordScreen>
	</Surface>
{/snippet}
