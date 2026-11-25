<script lang="ts">
	import { dateRange, versionNumber } from '#lib/site/presenter.ts';
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { DataHealthAnswer, EngineResult, MethodEntry } from '#lib/server/engine.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import { healthReading, tableName } from './dataHealthText.ts';
	import RecordActions from './RecordActions.svelte';
	import RecordPending from './RecordPending.svelte';
	import RecordTable from './RecordTable.svelte';
	import { recordSectionLinks } from './recordLinks.ts';
	import { choose, lastGoodNote, recordConnection } from './recordText.ts';

	let {
		locale,
		url,
		record,
	}: {
		locale: Locale;
		url: URL;
		record: {
			city: string;
			period: DateWindow;
			health: Promise<EngineResult<DataHealthAnswer>>;
			methods: Promise<EngineResult<MethodEntry[]>>;
		} | null;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('Data health', 'Santé des données'));
	const dailyTitle = $derived(
		t('Each clean table, day by day', 'État des tables nettoyées, jour par jour'),
	);
	const pinned = $derived.by(() => {
		const selected = new URL(url.pathname, url);
		if (record) selected.searchParams.set('provider', record.city);
		return new URL(
			frameHref(selected, {
				mode: 'record',
				period: record && { ...record.period, preset: null },
			}),
			url,
		);
	});
	const share = $derived(recordSectionLinks(pinned, 'table-health').share);
	const methodHref = $derived(
		carryFrameState(localizeHref('/metrics', locale, record?.city), pinned),
	);
	const dayLabel = (day: string) =>
		intl.dateTime(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(day));
	const tablesFor = (days: DataHealthAnswer['days']) => [
		...new Set(days.flatMap((day) => Object.keys(day.tables))),
	];
	const familiesFor = (entries: MethodEntry[]) => [
		...new Map(entries.map((entry) => [entry.family, entry])).values(),
	];
</script>

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<h1>{title}</h1>
			<p>{t('Can I trust what I see today?', 'Puis-je me fier à ce que je vois aujourd’hui?')}</p>
			{#if record}<p>{dateRange(record.period, locale)}</p>{/if}
		</header>
		{#if !record}
			<p>
				{t('No dates are available for the record yet.', 'Le bilan ne couvre encore aucune date.')}
			</p>
		{:else}
			<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
				<section
					id="table-health"
					aria-labelledby="table-health-heading"
					class="grid min-w-0 gap-3"
				>
					<h2 id="table-health-heading">{dailyTitle}</h2>
					{#await record.health}
						{#key record.health}<RecordPending {locale} answer={record.health} />{/key}
					{:then result}
						{#if result.kind !== 'answer'}
							<p>{recordConnection[result.kind][locale]}</p>
						{:else}
							{@const { days, cleaning_version } = result.answer}
							{@const tables = tablesFor(days)}
							{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
							<p>
								{t('Cleaning version in force', 'Version du nettoyage en vigueur')}
								<strong>{versionNumber(cleaning_version)}</strong>
							</p>
							{#if days.length}
								<RecordTable
									title={dailyTitle}
									wide
									headers={[
										t('Service day', 'Jour de service'),
										t('Day status', 'État du jour'),
										t('Cleaning version', 'Version du nettoyage'),
										...tables.map((table) => tableName(table, locale)),
									]}
									rows={days.map((day) => [
										dayLabel(day.service_date),
										healthReading(day, locale),
										versionNumber(day.cleaning_version) ?? '',
										...tables.map((table) => healthReading(day.tables[table], locale, day.reason)),
									])}
								/>
							{:else}
								<p>
									{t(
										'No table status was returned for these dates.',
										'Aucun état de table n’a été reçu pour ces dates.',
									)}
								</p>
							{/if}
							<RecordActions
								{locale}
								{title}
								href={share}
								citation={`Transit. ${title} (${record.city}). ${dateRange(record.period, locale)}. ${t('Cleaning version', 'Version du nettoyage')} ${versionNumber(cleaning_version)}. ${share}`}
							/>
						{/if}
					{/await}
				</section>
			</Card>
			<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
				<section aria-labelledby="health-method-versions" class="grid gap-3">
					<h2 id="health-method-versions">
						{t('Method versions in force', 'Versions des méthodes en vigueur')}
					</h2>
					{#await record.methods}
						{#key record.methods}<RecordPending {locale} answer={record.methods} />{/key}
					{:then result}
						{#if result.kind !== 'answer'}
							<p>{recordConnection[result.kind][locale]}</p>
						{:else}
							{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
							{#if result.answer.length}
								<dl class="grid gap-2">
									{#each familiesFor(result.answer) as entry (entry.family)}
										<div>
											<dt>
												<a
													class="inline-flex min-h-11 min-w-11 items-center"
													href={`${methodHref}#${entry.id}`}
													>{entry.family_text?.[locale] ?? entry.family}</a
												>
											</dt>
											<dd>{versionNumber(entry.method_version)}</dd>
										</div>
									{/each}
								</dl>
							{:else}
								<p>
									{t(
										'No method versions are listed yet.',
										'Aucune version de méthode n’est encore répertoriée.',
									)}
								</p>
							{/if}
						{/if}
					{/await}
				</section>
			</Card>
		{/if}
	</div>
</Surface>
