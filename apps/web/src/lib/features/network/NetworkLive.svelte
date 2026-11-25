<script lang="ts">
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { RoutePlate } from '@yesid/ui/brand';
	import RecordBandBar from '../record/charts/RecordBandBar.svelte';
	import { DataTable, type DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
	import { captureNetwork } from '#lib/live/captureProjection.ts';
	import LiveCapture from '#lib/live/LiveCapture.svelte';
	import { feedState, type CaptureSnapshot } from '#lib/live/captureSnapshot.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { countedUnit, liveStampAge, singularCount } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { choose, tally } from '../record/recordText.ts';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { selectSilentTripRows } from './silentTripRows.ts';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import { overviewCopy } from '../home/overviewRecord.copy.ts';

	let {
		capture,
		captureClock,
		subject,
		operator,
		healthLink,
		locale,
		city,
		schedule,
		url,
	}: {
		capture: Promise<CaptureSnapshot | null>;
		captureClock?: number;
		subject: string;
		operator: string;
		healthLink: string;
		locale: Locale;
		city: string | null;
		schedule: ScheduleEdition | null;
		url: URL;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const statusTitle = $derived(t('Vehicles by status', 'Véhicules par état'));
	const silentTitle = $derived(t('Silent trips', 'Trajets sans signalement'));
	const delayLabels = $derived(transitTerms[locale].band);
	const term = $derived(overviewCopy[locale]);
	const display = transitDisplay();
	const silentTripLimit = 8;
	type SilentTrip = NonNullable<ReturnType<typeof selectSilentTripRows>>[number];
	const columns = $derived<DataTableColumn<SilentTrip>[]>([
		{ key: 'line', header: t('Line', 'Ligne'), cell: line, rowHeader: true },
		{ key: 'departure', header: t('Departure', 'Départ'), cell: departure },
		{ key: 'toward', header: t('Toward', 'Vers'), cell: toward },
		{
			key: 'silent',
			header: t('Silent for', 'Sans signalement depuis'),
			cell: silent,
			numeric: true,
		},
	]);

	function reading(
		snapshot: CaptureSnapshot | null,
		feed: CaptureSnapshot['feeds'][string] | undefined,
		now: number,
	) {
		if (!snapshot?.vehicle_positions || feedState(feed, now) !== 'live') return null;
		return captureNetwork(snapshot, now);
	}

	function liveAnswer(reporting: number, scheduled: number | null) {
		const one = singularCount(reporting, locale);
		if (scheduled == null) return one ? term.reportingOne : term.reporting;
		const count = countedUnit(scheduled, 'trip', locale);
		return t(
			`${one ? 'vehicle is' : 'vehicles are'} reporting now, for ${count} scheduled at this moment.`,
			`${one ? 'véhicule transmet sa position' : 'véhicules transmettent leur position'} pour ${count} ${singularCount(scheduled, locale) ? 'prévu' : 'prévus'} en ce moment.`,
		);
	}
</script>

{#snippet line(row: SilentTrip)}
	{@const name = display.lineName(row.routeId)}
	{@const href = carryFrameState(
		localizeHref(
			'/lines/' + encodeURIComponent(row.routeId) + '?frameMode=live',
			locale,
			city ?? undefined,
		),
		url,
	)}
	{#if name.name && name.name !== row.line}
		<span class="inline-flex min-w-0 items-center gap-2">
			<span class="shrink-0"><RoutePlate code={row.line} /></span>
			<a class="inline-flex min-h-11 min-w-11 items-center text-primary underline" {href}
				>{name.name}</a
			>
		</span>
	{:else}
		<a
			class="inline-flex min-h-11 min-w-11 items-center text-primary underline"
			{href}
			aria-label={display.directory.spoken(row.line)}
		>
			<RoutePlate code={row.line} />
		</a>
	{/if}
{/snippet}
{#snippet departure(row: SilentTrip)}{row.departure}{/snippet}
{#snippet toward(row: SilentTrip)}
	{#if row.toward}{row.toward}{:else}<StateMark state="unknown" {locale} />{/if}
{/snippet}
{#snippet silent(row: SilentTrip)}{row.silentFor}{/snippet}

<RecordScreen class="min-w-0">
	<RecordGroup
		><ScreenTitle title={t('Network health', 'Santé du réseau')} subtitle={subject} /></RecordGroup
	>
	<div data-slot="screen-content">
		<LiveCapture {city} {capture} {captureClock}>
			{#snippet pending()}
				<RecordGroup
					><div data-slot="screen-answer">
						<p role="status">
							{t('Checking live reports…', 'Vérification des signalements en direct…')}
						</p>
					</div></RecordGroup
				>{/snippet}
			{#snippet children(snapshot, now)}
				{@const feed = Object.values(snapshot?.feeds ?? {}).find(
					(feed) => feed.family === 'vehicle_positions',
				)}
				{@const captureAge = feed?.captured_at
					? Math.max(0, (now - Date.parse(feed.captured_at)) / 1000)
					: null}
				{@const live = reading(snapshot, feed, now)}
				{@const scheduled = live?.scheduled_now ?? null}
				{@const silentCount = live?.non_responding ?? null}
				{@const silentTrips = selectSilentTripRows(
					live,
					schedule,
					locale,
					display.directory.nameSeparators,
				)}
				{@const bands = live?.status_dist
					? (
							[
								['early', delayLabels.early],
								['on_time', delayLabels.onTime],
								['late', delayLabels.late],
								['unknown', t('Delay unknown', 'Retard inconnu')],
							] as const
						).map(([status, label]) => {
							const count = live.status_dist?.[status] ?? 0;
							return {
								id: status,
								status,
								label,
								share: count,
								valueLabel: countedUnit(count, 'vehicle', locale),
							};
						})
					: []}
				{@const stamp = live
					? {
							kind: 'live' as const,
							label: liveStampAge(captureAge, locale),
						}
					: undefined}
				<RecordGroup class="grid gap-6">
					<div data-slot="screen-answer">
						<RecordAnswer
							{locale}
							value={live ? tally(live.vehicles_in_service, locale) : null}
							state={live ? undefined : 'no_live_data'}
							sentence={live
								? liveAnswer(live.vehicles_in_service, scheduled)
								: t('No live data', 'Aucune donnée en direct')}
							time={stamp}
						>
							{#snippet meta()}
								{#if live}<p>
										{t(
											'A count of vehicles at this moment, not a percentage.',
											'Le nombre de véhicules en ce moment, pas un pourcentage.',
										)}
									</p>{/if}
							{/snippet}
						</RecordAnswer>
					</div>
					<div class="grid min-w-0 gap-4">
						<RecordCard title={statusTitle} {stamp}>
							{#if bands.length}
								<div class="grid gap-6 md:grid-cols-2">
									<div class="min-w-0">
										<RecordBandBar
											label={bands
												.map(({ label, valueLabel }) => `${label}, ${valueLabel}`)
												.join('. ')}
											{bands}
										/>
									</div>
									{#if scheduled != null && silentCount != null}
										<dl class="grid content-start gap-4">
											<div>
												<dt>
													{t(
														'Scheduled trips with a vehicle reporting',
														'Trajets prévus avec un véhicule signalé',
													)}
												</dt>
												<dd class="font-heading text-heading font-extrabold">
													{tally(scheduled - silentCount, locale)}
												</dd>
												<dd class="text-small text-muted-foreground">
													{t(`of ${tally(scheduled, locale)}`, `sur ${tally(scheduled, locale)}`)}
												</dd>
											</div>
											<div>
												<dt>{term.silent}</dt>
												<dd class="font-heading text-heading font-extrabold">
													{tally(silentCount, locale)}
												</dd>
											</div>
										</dl>
									{/if}
								</div>
							{:else}
								<StateMark state="no_live_data" {locale} />
							{/if}
						</RecordCard>
						<RecordCard interactive={Boolean(silentTrips?.length)} title={silentTitle} {stamp}>
							<p class="mb-3">
								{t(
									'Trips that should be running and have no vehicle reporting. Trips the agency cancelled are not counted.',
									'Ces trajets devraient être en cours, mais aucun véhicule ne transmet sa position. Les trajets annulés par l’exploitant sont exclus.',
								)}
							</p>
							{#if silentTrips?.length}
								<DataTable
									caption={term.silent}
									{columns}
									rows={silentTrips.slice(0, silentTripLimit)}
									key={(row) => String(silentTrips.indexOf(row))}
									responsive={{ mode: 'scroll', minWidth: '28rem' }}
								/>
								{#if silentCount != null && silentCount > silentTripLimit}
									<p class="mt-3 text-small text-muted-foreground">
										{t(
											`Showing ${tally(Math.min(silentTrips.length, silentTripLimit), locale)} of ${tally(silentCount, locale)}.`,
											`${tally(Math.min(silentTrips.length, silentTripLimit), locale)} sur ${tally(silentCount, locale)}.`,
										)}
									</p>
								{/if}
							{:else}
								{#if silentCount != null}<p>{countedUnit(silentCount, 'trip', locale)}</p>{/if}
								{#if silentTrips == null && silentCount !== 0}
									<StateMark state={snapshot ? 'not_measured' : 'no_live_data'} {locale} />
								{/if}
							{/if}
						</RecordCard>
					</div>
				</RecordGroup>
				<RecordGroup><AboutLiveFigures {locale} {operator} {healthLink} {captureAge} /></RecordGroup
				>
			{/snippet}
		</LiveCapture>
	</div>
</RecordScreen>
