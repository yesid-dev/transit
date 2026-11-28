<script lang="ts">
	import type { Awaitable } from '#lib/site/ready.ts';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import type { DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import { type CaptureSnapshot, captureDisplayState } from '#lib/live/captureSnapshot.ts';
	import LiveCapture from '#lib/live/LiveCapture.svelte';
	import {
		alertsNotPublished,
		officialAlertsLabel,
		singularCount,
		healthFeedName,
		captureAge,
		captureCadence,
		captureFacts,
		tickingLiveStamp,
		recordRatio,
	} from '#lib/site/presenter.ts';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordPending from '../record/RecordPending.svelte';
	import { localizeHref } from '#lib/i18n/index.ts';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { choose } from '../record/recordText.ts';

	let {
		city,
		capture,
		subject,
		operator,
		operatorOf,
		alerts = { tracked: true },
		locale,
	}: {
		city: string | null;
		capture: Awaitable<CaptureSnapshot | null>;
		subject: string;
		operator: string;
		operatorOf?: string | null;
		alerts?: { tracked: boolean; officialUrl?: string };
		locale: Locale;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const table = $derived(t('Each feed, at its last capture', 'Dernière collecte de chaque flux'));
	const hold = $derived(
		t(
			'A late feed is held: the screens keep showing what was last received, and say so.',
			'Si un flux est en retard, les écrans conservent les dernières données reçues et le signalent.',
		),
	);
	const labels = $derived({
		live: t('Fresh', 'À jour'),
		stale: t('Late', 'En retard'),
		no_live_data: t('No live data', 'Aucune donnée en direct'),
		refresh_unavailable: t('Refresh unavailable', 'Actualisation indisponible'),
		not_tracked: t('Transit did not track this feed', 'Transit n’a pas suivi ce flux'),
		unknown: t('Unknown', 'Inconnu'),
		not_measured: t('Not measured', 'Non mesuré'),
	});

	function reading(
		snapshot: CaptureSnapshot | null,
		now: number,
	): {
		id: string;
		name: string;
		age: string | null;
		cadence: string | null;
		state: ReturnType<typeof captureDisplayState>;
	}[] {
		return Object.entries(snapshot?.feeds ?? {}).map(([id, feed]) => ({
			id,
			name: healthFeedName(feed.family, locale),
			age: captureAge(feed.captured_at, now, locale),
			cadence: captureCadence(feed.expected_every_seconds, locale),
			state: captureDisplayState(feed, now, snapshot?.published_at),
		}));
	}
	type FeedRow = {
		id: string;
		label: string;
		age: string;
		cadence: string;
		state: string;
		facts: string | null;
	};
	const feedColumns = $derived<DataTableColumn<FeedRow>[]>([
		{ key: 'age', header: t('Last capture', 'Dernière collecte'), cell: ageCell },
		{ key: 'cadence', header: t('Expected', 'Fréquence prévue'), cell: cadenceCell },
		{ key: 'state', header: t('State', 'État'), cell: stateCell },
	]);
	const feedShape = { shape: 'table', rows: 4 } as const;
</script>

{#snippet ageCell(row: FeedRow)}{row.age}{/snippet}
<!-- Words in the feed table read in the body face; only the age is a figure. -->
{#snippet cadenceCell(row: FeedRow)}<span class="font-sans">{row.cadence}</span>{/snippet}
{#snippet stateCell(row: FeedRow)}<span class="font-sans">{row.state}</span>{/snippet}

<!-- An agency that publishes no notices says so inside the feed card, beside its other feeds. -->
{#snippet alertsGap()}
	{#if !alerts.tracked}
		<div class="mt-3 grid gap-1" data-slot="alerts-not-published">
			<p class="font-semibold">{t('Service alerts', 'Avis de service')}</p>
			<p>
				<StateMark state="not_published" {locale} />{t(':', '\u00a0:')}
				{alertsNotPublished(
					{ name: operator, frenchOf: operatorOf },
					locale,
					Boolean(alerts.officialUrl),
				)}
			</p>
			{#if alerts.officialUrl}<a
					class="inline-flex min-h-11 items-center text-primary underline"
					href={alerts.officialUrl}>{officialAlertsLabel(locale)}</a
				>{/if}
		</div>
	{/if}
{/snippet}

{#snippet about(text: string | null)}
	<AboutLiveFigures
		{locale}
		{operator}
		scope={t(
			'The state of each feed at its last capture.',
			'L’état de chaque flux à son dernier relevé.',
		)}
		statusLabel={t('How a feed gets its state', 'Comment est déterminé l’état d’un flux')}
		definition={t(
			'A feed is fresh while its latest capture is within its freshness window.',
			'Un flux reste à jour tant que son dernier relevé respecte le délai de fraîcheur.',
		)}
		errorLink={localizeHref('/metrics', locale, city ?? undefined) + '#about-transit'}
		captureText={text ?? labels.no_live_data}
	/>
{/snippet}

<RecordScreen class="min-w-0">
	<div data-slot="screen-content">
		<LiveCapture {capture} {city}>
			{#snippet pending()}
				<RecordGroup
					><ScreenTitle title={t('Data health', 'Santé des données')} subtitle={subject} />
					<div data-slot="screen-answer"><RecordPending {locale} shape="answer" /></div>
					<RecordCard title={table} stampRule reserve={feedShape}
						><RecordPending {locale} shape={feedShape} /></RecordCard
					></RecordGroup
				>
				<RecordGroup>{@render about(null)}</RecordGroup>
			{/snippet}
			{#snippet children(snapshot, now)}
				{@const feeds = reading(snapshot, now)}
				{@const schedule = snapshot?.schedule}
				{@const fresh = feeds.filter((feed) => feed.state === 'live')}
				{@const lastCapture = Object.values(snapshot?.feeds ?? {})
					.flatMap((feed) => feed.captured_at ?? [])
					.sort((left, right) => Date.parse(left) - Date.parse(right))
					.at(-1)}
				{@const late = feeds
					.filter((feed) => feed.state === 'stale')
					.map((feed) => feed.name)
					.join(', ')}
				{@const stamp = snapshot
					? tickingLiveStamp(new Date(snapshot.published_at), locale, { now })
					: undefined}
				<RecordGroup>
					<ScreenTitle title={t('Data health', 'Santé des données')} subtitle={subject} />
					<div data-slot="screen-answer">
						<RecordAnswer
							{locale}
							value={feeds.length ? recordRatio(fresh.length, String(feeds.length), locale) : null}
							state={feeds.length ? undefined : 'no_live_data'}
							sentence={feeds.length
								? late
									? t(
											`live feeds are fresh. Late: ${late}.`,
											`${singularCount(fresh.length, locale) ? 'flux en direct est à jour' : 'flux en direct sont à jour'}. En retard\u00a0: ${late}.`,
										)
									: t(
											'live feeds are fresh.',
											singularCount(fresh.length, locale)
												? 'flux en direct est à jour.'
												: 'flux en direct sont à jour.',
										)
								: labels.no_live_data}
							time={stamp}
						/>
					</div>
					<div class="grid min-w-0 gap-4">
						<RecordCard
							title={table}
							stampRule
							reserve={feedShape}
							interactive={!alerts.tracked && Boolean(alerts.officialUrl)}
						>
							{#if feeds.length || schedule}
								<RecordDataTable
									{locale}
									title={table}
									rowHeader={t('Feed', 'Flux')}
									columns={feedColumns}
									rows={[
										...feeds.map(({ id, name, age, cadence, state }) => ({
											id: 'feed:' + id,
											label: name,
											age: age ?? labels.unknown,
											cadence: cadence ?? labels.not_measured,
											state:
												state === 'stale' && age
													? t(
															`Late: last received ${age}`,
															`En retard\u00a0: dernière réception ${age}`,
														)
													: labels[state],
											facts: captureFacts(state === 'stale' ? null : age, cadence, null, locale),
										})),
										...(schedule
											? [
													{
														id: 'schedule',
														label: t('Schedule', 'Horaire'),
														age: captureAge(schedule.captured_at, now, locale) ?? labels.unknown,
														cadence: t(
															'when the agency publishes',
															'à la publication par la société de transport',
														),
														state: schedule.effective_date
															? t('In use', 'En vigueur')
															: labels.not_measured,
														facts: captureFacts(
															captureAge(schedule.captured_at, now, locale),
															t(
																'when the agency publishes',
																'à la publication par la société de transport',
															),
															null,
															locale,
														),
													},
												]
											: []),
									]}
									scrollMinWidth="24rem"
									value="state"
									phone={{ line: (row) => row.facts }}
								/>
								<p class="mt-3 text-small text-muted-foreground">{hold}</p>
							{:else}<StateMark state="no_live_data" {locale} />{/if}
							{@render alertsGap()}
						</RecordCard>
					</div>
				</RecordGroup>
				<RecordGroup>
					{@render about(captureAge(lastCapture ?? null, now, locale, { short: false }))}
				</RecordGroup>
			{/snippet}
		</LiveCapture>
	</div>
</RecordScreen>
