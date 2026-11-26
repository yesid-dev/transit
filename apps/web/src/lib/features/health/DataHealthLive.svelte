<script lang="ts">
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import type { DataTableColumn } from '@yesid/ui/table';
	import type { Locale } from '#lib/i18n/index.ts';
	import { type CaptureSnapshot, captureDisplayState } from '#lib/live/captureSnapshot.ts';
	import LiveCapture from '#lib/live/LiveCapture.svelte';
	import {
		healthFeedName,
		captureAge,
		captureCadence,
		captureSize,
		liveStampAge,
		recordRatio,
	} from '#lib/site/presenter.ts';
	import RecordDataTable from '../record/RecordDataTable.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import AboutLiveFigures from '../record/AboutLiveFigures.svelte';
	import ScreenTitle from '../record/ScreenTitle.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { choose } from '../record/recordText.ts';

	let {
		city,
		capture,
		subject,
		operator,
		locale,
	}: {
		city: string | null;
		capture: Promise<CaptureSnapshot | null>;
		subject: string;
		operator: string;
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
		not_tracked: t('Not tracked', 'Non suivi'),
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
		size: string | null;
		state: ReturnType<typeof captureDisplayState>;
	}[] {
		return Object.entries(snapshot?.feeds ?? {}).map(([id, feed]) => ({
			id,
			name: healthFeedName(feed.family, locale),
			age: captureAge(feed.captured_at, now, locale),
			cadence: captureCadence(feed.expected_every_seconds, locale),
			size: captureSize(feed.bytes, locale),
			state: captureDisplayState(feed, now),
		}));
	}
	type FeedRow = {
		id: string;
		label: string;
		age: string;
		cadence: string;
		size: string;
		state: string;
	};
	const feedColumns = $derived<DataTableColumn<FeedRow>[]>([
		{ key: 'age', header: t('Last capture', 'Dernière collecte'), cell: ageCell },
		{ key: 'cadence', header: t('Expected', 'Fréquence prévue'), cell: cadenceCell },
		{ key: 'size', header: t('Size', 'Taille'), numeric: true, cell: sizeCell },
		{ key: 'state', header: t('State', 'État'), cell: stateCell },
	]);
</script>

{#snippet ageCell(row: FeedRow)}{row.age}{/snippet}
{#snippet cadenceCell(row: FeedRow)}{row.cadence}{/snippet}
{#snippet sizeCell(row: FeedRow)}{row.size}{/snippet}
{#snippet stateCell(row: FeedRow)}{row.state}{/snippet}

<RecordScreen class="min-w-0">
	<RecordGroup
		><ScreenTitle title={t('Data health', 'Santé des données')} subtitle={subject} /></RecordGroup
	>
	<div data-slot="screen-content">
		<LiveCapture {capture} {city}>
			{#snippet pending()}
				<RecordGroup waiting="facts"
					><div data-slot="screen-answer">
						<p role="status">{t('Checking live feeds…', 'Vérification des flux en direct…')}</p>
					</div></RecordGroup
				>{/snippet}
			{#snippet children(snapshot, now)}
				{@const feeds = reading(snapshot, now)}
				{@const schedule = snapshot?.schedule}
				{@const fresh = feeds.filter((feed) => feed.state === 'live')}
				{@const lastCapture = Object.values(snapshot?.feeds ?? {})
					.flatMap((feed) => feed.captured_at ?? [])
					.sort((left, right) => Date.parse(left) - Date.parse(right))
					.at(-1)}
				{@const publicationAge = snapshot
					? Math.max(0, (now - Date.parse(snapshot.published_at)) / 1000)
					: null}
				{@const late = feeds
					.filter((feed) => feed.state === 'stale')
					.map((feed) => feed.name)
					.join(', ')}
				{@const stamp = snapshot
					? {
							kind: 'live' as const,
							label: liveStampAge(publicationAge, locale),
						}
					: undefined}
				<RecordGroup>
					<div data-slot="screen-answer">
						<RecordAnswer
							{locale}
							value={feeds.length ? recordRatio(fresh.length, String(feeds.length), locale) : null}
							state={feeds.length ? undefined : 'no_live_data'}
							sentence={feeds.length
								? late
									? t(`feeds are fresh. Late: ${late}.`, `flux sont à jour. En retard : ${late}.`)
									: t('feeds are fresh.', 'flux sont à jour.')
								: labels.no_live_data}
							time={stamp}
						/>
					</div>
					<div class="grid min-w-0 gap-4">
						<RecordCard title={table} {stamp}>
							{#if feeds.length || schedule}
								<RecordDataTable
									{locale}
									title={table}
									rowHeader={t('Feed', 'Flux')}
									columns={feedColumns}
									rows={[
										...feeds.map(({ id, name, age, cadence, size, state }) => ({
											id: 'feed:' + id,
											label: name,
											age: age ?? labels.unknown,
											cadence: cadence ?? labels.not_measured,
											size: size ?? labels.not_measured,
											state:
												state === 'stale' && age
													? t(`Late: last received ${age}`, `En retard : dernière réception ${age}`)
													: labels[state],
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
														size: captureSize(schedule.bytes, locale) ?? labels.not_measured,
														state: schedule.effective_date
															? t('In use', 'En vigueur')
															: labels.not_measured,
													},
												]
											: []),
									]}
									scrollMinWidth="24rem"
								/>
								<p class="mt-3 text-small text-muted-foreground">{hold}</p>
							{:else}<StateMark state="no_live_data" {locale} />{/if}
						</RecordCard>
					</div>
				</RecordGroup>
				<RecordGroup>
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
						captureText={captureAge(lastCapture ?? null, now, locale) ?? labels.no_live_data}
					/>
				</RecordGroup>
			{/snippet}
		</LiveCapture>
	</div>
</RecordScreen>
