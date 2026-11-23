<script lang="ts">
	import { page } from '$app/state';
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { localizeHref } from '#lib/i18n/index.ts';
	import { alertDetailsLimit } from '#lib/features/alerts/alertRecord.ts';
	import RecordSection from '#lib/features/record/RecordSection.svelte';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import AccountabilityReceipt from '#lib/features/receipt/AccountabilityReceipt.svelte';
	import {
		dailyPeriodRows,
		dailyTitles,
		onTimeStatement,
	} from '#lib/features/record/departureDailyText.ts';
	import {
		choose,
		dateRange,
		percent,
		recordMessage,
		tally,
	} from '#lib/features/record/recordText.ts';
	import { carryFrameState, frameHref } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { RecordAnswer } from '#lib/server/engine.ts';
	import type { PageData } from './$types';

	let { data: routeData }: { data: PageData } = $props();
	const data = $derived(routeData.report);
	const display = transitDisplay();
	const lang = $derived(routeData.report?.lang ?? routeData.lang);
	const t = (en: string, fr: string) => choose(lang, en, fr);
	const n = (count: number) => tally(count, lang);
	const title = $derived(t('Daily report', 'Rapport quotidien'));
	const deliveryLabels = $derived({
		scheduled: t('Scheduled trips', 'Trajets prévus'),
		eligible: t('Known status', 'État connu'),
		ran: t('Ran', 'Effectués'),
		cancelled: t('Cancelled', 'Annulés'),
		missing: t('Missing', 'Manquants'),
	});
	const subject = $derived(data ? `${title}, ${data.cityName}` : title);
	const pinned = $derived.by(() => {
		const url = new URL(page.url.href);
		if (!data) return url;
		url.searchParams.set('provider', data.city);
		return new URL(
			frameHref(url, { mode: 'record', period: data.period && { ...data.period, preset: null } }),
			url,
		);
	});
	const statement = (answer: RecordAnswer) =>
		'value' in answer ? onTimeStatement(answer, lang) : '';
</script>

{#if data}
	<Surface>
		<article class="daily-report grid min-w-0 gap-4">
			<header class="grid gap-2">
				<h1>{title}</h1>
				<p>
					{data.cityName}{#if data.period}
						· {dateRange(data.period, data.lang)}{/if}
				</p>
				<button
					class="w-fit min-h-11 rounded border px-3"
					data-report-controls
					onclick={() => window.print()}
				>
					{t('Print report', 'Imprimer le rapport')}
				</button>
			</header>
			{#each data.sections as { section, answer } (section)}
				{@const heading = dailyTitles[section][lang === 'fr' ? 1 : 0]}
				<RecordSection
					{section}
					title={heading}
					{subject}
					locale={data.lang}
					url={pinned}
					{answer}
					statement={section === 'punctuality' ? statement : undefined}
					printable
				>
					{#snippet reading(result)}
						{#if section === 'punctuality' && 'value' in result}
							<p>{statement(result)}</p>
						{:else if section === 'delivery' && 'value' in result}
							{@const counts = result.evidence.counts}
							{@const rate = result.value.trips_run}
							{#if result.state !== 'measured' || rate == null}
								<p>{result.state_text[data.lang]}</p>
							{:else}
								<p>
									{t(
										`${percent(rate, data.lang)} of scheduled trips with known status ran.`,
										`${percent(rate, data.lang)} des trajets prévus dont l’état est connu ont été effectués.`,
									)}
								</p>
							{/if}
							<dl class="flex flex-wrap gap-4">
								{#each Object.entries(deliveryLabels) as [key, label] (key)}
									{@const value = counts[key]}
									<div>
										<dt>{label}</dt>
										<dd>
											{value == null ||
											(value === 0 && !(counts.eligible ?? 0) && key !== 'scheduled')
												? result.state_text[data.lang]
												: n(value)}
										</dd>
									</div>
								{/each}
							</dl>
						{:else if section === 'periods' && 'cells' in result}
							<p>
								{t(
									'Each period ends just before the next. Times are local scheduled stop times, including overnight service. The CSV gives the counts by hour.',
									'Chaque période se termine juste avant la suivante. Les heures sont celles des passages prévus, en heure locale, y compris la nuit. Le CSV donne les totaux par heure.',
								)}
							</p>
							<RecordTable
								title={heading}
								headers={[
									t('Period', 'Période'),
									t('Late share', 'Part en retard'),
									t('Late / observed', 'En retard / observés'),
								]}
								rows={dailyPeriodRows(result, data.lang)}
							/>
						{:else if (section === 'lines' || section === 'stops') && 'rows' in result}
							{#if result.rows.length}
								<p>
									{t(
										'Lowest on-time share among entries with enough observations.',
										'Plus faibles parts à l’heure parmi les résultats suffisamment observés.',
									)}
								</p>
								<ol class="grid gap-2 pl-5">
									{#each result.rows as row (row.id)}
										{@const path = section === 'lines' ? '/lines' : '/stop'}
										<li>
											<a
												href={carryFrameState(
													localizeHref(
														`${path}/${encodeURIComponent(row.id)}`,
														data.lang,
														data.city,
													),
													pinned,
												)}
											>
												{section === 'lines'
													? display.lineName(row.id).spoken
													: t(`Stop ${row.id}`, `Arrêt ${row.id}`)}
											</a>
											<span>
												· {percent(row.value, data.lang)} ({n(row.sample)}
												{t('observed', 'observés')})</span
											>
										</li>
									{/each}
								</ol>
							{:else}
								<p>{recordMessage({ kind: 'answer', answer: result }, data.lang)}</p>
							{/if}
						{:else if section === 'messages' && 'value' in result}
							{#if result.state === 'measured' && result.evidence.counts.alerts != null}
								<p>
									{t(
										`Distinct alerts: ${n(result.evidence.counts.alerts)}.`,
										`Avis distincts : ${n(result.evidence.counts.alerts)}.`,
									)}
								</p>
								{#if result.evidence.alert_messages?.length}
									<ul class="grid gap-3">
										{#each result.evidence.alert_messages as message (JSON.stringify( [message.source, message.id, message.version], ))}
											{@const other = data.lang === 'fr' ? 'en' : 'fr'}
											{@const header = message.header[data.lang] || message.header[other]}
											{@const description =
												message.description[data.lang] || message.description[other]}
											<li class="grid gap-1 wrap-anywhere">
												<h3 lang={message.header[data.lang] || !header ? undefined : other}>
													{header || t(`Alert ${message.id}`, `Avis ${message.id}`)}
												</h3>
												{#if description}<p
														lang={message.description[data.lang] ? undefined : other}
													>
														{description}
													</p>{/if}
												{#if message.routes.length}<p>
														{t('Lines', 'Lignes')}
														{message.routes.map(display.line).join(', ')}
													</p>{/if}
											</li>
										{/each}
									</ul>
								{:else if result.evidence.counts.alerts > 0}
									<p>{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}</p>
								{:else}
									<p>
										{t(
											'No alerts in the tracked record for these dates.',
											'Aucun avis dans le bilan suivi à ces dates.',
										)}
									</p>
								{/if}
							{:else}
								<p>{result.state_text[data.lang]}</p>
							{/if}
						{/if}
					{/snippet}
				</RecordSection>
			{/each}
			{#if data.messagesLimited}
				<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
					<section id="messages" aria-labelledby="messages-title" class="grid min-w-0 gap-3">
						<h2 id="messages-title">{t(...dailyTitles.messages)}</h2>
						<p>
							{alertDetailsLimit[lang]}
						</p>
					</section>
				</Card>
			{/if}
		</article>
	</Surface>
{:else}
	<AccountabilityReceipt />
{/if}

<style>
	@media print {
		:global(
			body:has(.daily-report)
				:is(
					[data-slot='app-shell-chrome'],
					[data-slot='frame-nav'],
					[data-slot='footer'],
					[data-report-controls]
				)
		) {
			display: none !important;
		}
		:global(
			body:has(.daily-report)
				:is(
					[data-slot='app-shell'],
					[data-slot='app-shell-row'],
					[data-slot='map-stage'],
					#main-flow,
					#main
				)
		) {
			display: block;
			min-height: 0;
			overflow: visible;
			background: white;
			color: black;
		}
		.daily-report {
			color: black;
			gap: 0.5rem;
		}
		.daily-report :global([data-slot='card']) {
			background: white;
			color: black;
			box-shadow: none;
		}
		.daily-report :global(h2),
		.daily-report :global(h3) {
			break-after: avoid;
		}
		.daily-report :global(tr) {
			break-inside: avoid;
		}
	}
</style>
