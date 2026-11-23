<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import type { EngineResult, MethodEntry } from '#lib/server/engine.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import RecordActions from './RecordActions.svelte';
	import RecordPending from './RecordPending.svelte';
	import { recordSectionLinks } from './recordLinks.ts';
	import { choose, dateRange, lastGoodNote, recordConnection, tally } from './recordText.ts';

	let {
		catalog,
		locale,
		url,
		city,
		period,
	}: {
		catalog: Promise<EngineResult<MethodEntry[]>>;
		locale: Locale;
		url: URL;
		city: string;
		period: DateWindow | null;
	} = $props();

	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('How we measure', 'Comment on mesure'));
	const canonical = $derived(new URL(url.pathname, url));
	const csvScope = $derived.by(() => {
		const selected = new URL(canonical);
		selected.searchParams.set('provider', city);
		return new URL(
			frameHref(selected, { mode: 'record', period: period && { ...period, preset: null } }),
			url,
		);
	});
	const since = (day: string) =>
		intl.dateTime(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(day));

	function scrollToMeasure(node: HTMLElement) {
		if (location.hash === `#${node.id}`) requestAnimationFrame(() => node.scrollIntoView());
	}
</script>

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<h1>{title}</h1>
			<a
				class="inline-flex min-h-11 items-center justify-self-start"
				href={localizeHref('/metrics/archive', locale, city)}
			>
				{t('Methodology for the archived record', 'Méthode du bilan archivé')}
			</a>
		</header>
		<section aria-label={title} class="grid min-w-0 gap-4">
			{#await catalog}
				{#key catalog}<RecordPending {locale} />{/key}
			{:then result}
				{#if result.kind !== 'answer'}
					<p>{recordConnection[result.kind][locale]}</p>
				{:else}
					{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
					{#if !result.answer.length}<p>
							{t('No measures are listed yet.', 'Aucune mesure n’est encore répertoriée.')}
						</p>{/if}
					{#if result.answer.length && period}
						<p>
							{t(
								'CSV downloads use the selected city and dates.',
								'Les fichiers CSV couvrent la ville et les dates sélectionnées.',
							)}
							{dateRange(period, locale)}.
						</p>
					{/if}
					{#each Object.entries(Object.groupBy(result.answer, (entry) => entry.family)) as [family, entries] (family)}
						{@const heading = entries?.[0]?.family_text?.[locale] ?? family}
						<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
							<section class="grid min-w-0 gap-5" aria-labelledby={`family-${family}`}>
								<h2 id={`family-${family}`}>{heading}</h2>
								{#each entries ?? [] as entry (entry.id)}
									{@const text = entry.text[locale]}
									{@const share = recordSectionLinks(canonical, entry.id).share}
									{@const columns = entry.csv_columns[locale]}
									<article
										id={entry.id}
										use:scrollToMeasure
										class="grid min-w-0 gap-3 border-t border-border pt-4"
										aria-labelledby={`measure-${entry.id}`}
									>
										<h3 id={`measure-${entry.id}`}>{text.definition}</h3>
										<dl class="grid gap-3">
											<div>
												<dt>
													{t(
														'What it counts and how it is calculated',
														'Ce que la mesure compte et comment elle est calculée',
													)}
												</dt>
												<dd>
													{text.counts}{#if text.histogram}
														{text.histogram}{/if}
												</dd>
											</div>
											<div>
												<dt>{t('What it leaves out', 'Ce que la mesure exclut')}</dt>
												<dd>{text.exclusions}</dd>
											</div>
											<div>
												<dt>{t('What it cannot tell', 'Ce que la mesure ne peut pas dire')}</dt>
												<dd>{text.limits}</dd>
											</div>
											<div>
												<dt>{t('Unit', 'Unité')}</dt>
												<dd>{text.unit}</dd>
											</div>
											<div>
												<dt>{t('Minimum sample', 'Échantillon minimal')}</dt>
												<dd>{tally(entry.minimum_sample, locale)}</dd>
											</div>
											{#if entry.ranking_minimum_sample !== undefined}
												<div>
													<dt>
														{t(
															'Minimum sample for rankings',
															'Échantillon minimal pour les classements',
														)}
													</dt>
													<dd>{tally(entry.ranking_minimum_sample, locale)}</dd>
												</div>
											{/if}
											<div>
												<dt>{t('Method version', 'Version de la méthode')}</dt>
												<dd>{entry.method_version}</dd>
											</div>
											<div>
												<dt>{t('Since', 'Depuis le')}</dt>
												<dd><time datetime={entry.since}>{since(entry.since)}</time></dd>
											</div>
										</dl>
										{#if columns.length}
											<details>
												<summary class="min-h-11 cursor-pointer py-3"
													>{t('CSV columns', 'Colonnes du CSV')}</summary
												>
												<ul class="list-disc ps-5">
													{#each columns as column, index (index)}<li>{column}</li>{/each}
												</ul>
											</details>
										{/if}
										<RecordActions
											{locale}
											title={text.definition}
											href={share}
											csv={period && columns.length
												? recordSectionLinks(csvScope, entry.id).csv
												: undefined}
											citation={`Transit. ${title}. ${text.definition} (${entry.method_version}, ${since(entry.since)}). ${share}`}
										/>
									</article>
								{/each}
							</section>
						</Card>
					{/each}
				{/if}
			{/await}
		</section>
	</div>
</Surface>

<style>
	dt {
		font-weight: 600;
	}
</style>
