<script lang="ts">
	import { Surface } from '@yesid/ui/layout';
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordSection from '#lib/features/record/RecordSection.svelte';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import { choose, dateRange, tally } from '#lib/features/record/recordText.ts';
	import type { loadNetworkRecord } from '#lib/server/networkRecord.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import { networkMeasures, networkRows, networkUnmeasuredDays } from './networkRecordText.ts';

	let {
		record,
		subject,
		locale,
		url,
	}: {
		record: ReturnType<typeof loadNetworkRecord> | null;
		subject: string;
		locale: Locale;
		url: URL;
	} = $props();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const pinned = $derived.by(() => {
		const link = new URL(url.pathname, url);
		if (record) link.searchParams.set('provider', record.city);
		return new URL(
			frameHref(link, { mode: 'record', period: record && { ...record.period, preset: null } }),
			url,
		);
	});
	const liveHref = $derived(
		frameHref(pinned, {
			mode: 'live',
			period: record && { ...record.period, preset: null },
		}),
	);
</script>

<Surface>
	<div class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<h1>{t('Network health', 'Santé du réseau')}</h1>
			<a href={liveHref}>{t('See live network health', 'Voir la santé du réseau en direct')}</a>
			{#if record}<p>{subject} · {dateRange(record.period, locale)}</p>{/if}
		</header>
		{#if record}
			{#each record.sections as { measure, answer } (measure)}
				{@const copy = networkMeasures[measure]}
				{@const title = t(...copy.title)}
				<RecordSection section={measure} {title} {subject} {locale} url={pinned} {answer}>
					{#snippet controls()}<p>{t(...copy.description)}</p>{/snippet}
					{#snippet reading(result)}
						{@const table = networkRows(measure, result, locale)}
						{@const days = networkUnmeasuredDays(measure, result, locale)}
						{@const minimum = result.info.find((info) => info.id === measure)?.minimum_sample}
						<RecordTable {title} {...table} stack />
						{#if minimum != null}
							<p>
								{measure === 'prediction_error'
									? t(
											`At least ${tally(minimum, locale)} observed arrivals per lead time.`,
											`Au moins ${tally(minimum, locale)} arrivées observées par temps d’avance.`,
										)
									: t(
											`At least ${tally(minimum, locale)} samples per reading.`,
											`Au moins ${tally(minimum, locale)} observations par résultat.`,
										)}
							</p>
						{/if}
						{#if days.length}
							<details>
								<summary
									>{t('Days not measured', 'Jours non mesurés')} ({tally(
										days.length,
										locale,
									)})</summary
								>
								<RecordTable
									title={t('Days not measured', 'Jours non mesurés')}
									headers={[t('Service date', 'Date de service'), t('Reason', 'Raison')]}
									rows={days}
								/>
							</details>
						{/if}
					{/snippet}
				</RecordSection>
			{/each}
		{:else}
			<p>
				{t('No dates are available in the record yet.', 'Le bilan ne contient encore aucune date.')}
			</p>
		{/if}
	</div>
</Surface>
