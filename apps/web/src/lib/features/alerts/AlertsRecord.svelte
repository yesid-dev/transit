<script lang="ts">
	import { page } from '$app/state';
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import RecordSection from '#lib/features/record/RecordSection.svelte';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import { healthReason } from '#lib/features/record/dataHealthText.ts';
	import { choose, dateRange, recordMessage } from '#lib/features/record/recordText.ts';
	import type { loadAlertRecord } from '#lib/server/alertRecord.ts';
	import type { RecordAnswer } from '#lib/server/engine.ts';
	import { frameHref } from '#lib/site/frameState.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import type { DateWindow } from '#lib/v1/history/window.ts';
	import {
		alertDay,
		alertDetailsAllowed,
		alertDetailsLimit,
		alertMetrics,
		alertReadings,
		alertRecordRows,
		alertSections,
	} from './alertRecord.ts';

	let {
		data,
		locale,
	}: {
		data: {
			period: DateWindow | null;
			tracked: boolean;
			officialAlertsUrl?: string;
			city: string;
			cityName: string;
			sections: ReturnType<typeof loadAlertRecord>;
		};
		locale: Locale;
	} = $props();

	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const title = $derived(t('Service alerts', 'Avis de service'));
	const subject = $derived(`${title}, ${data.cityName}`);
	const pinned = $derived.by(() => {
		const url = new URL(page.url.href);
		url.searchParams.set('provider', data.city);
		return new URL(
			frameHref(url, {
				mode: 'record',
				period: data.period && { ...data.period, preset: null },
			}),
			url,
		);
	});
	const groupLabels = $derived({
		day: t('Local date', 'Date locale'),
		hour: t('Local hour', 'Heure locale'),
		line: t('Line', 'Ligne'),
		stop: t('Stop', 'Arrêt'),
		effect: t('Published effect', 'Effet publié'),
		cause: t('Published cause', 'Cause publiée'),
	});
	const other = $derived(locale === 'fr' ? 'en' : 'fr');
	const timestamp = $derived(
		intl.dateTime(locale, {
			timeZone: 'America/Toronto',
			dateStyle: 'medium',
			timeStyle: 'short',
		}),
	);
	const notTracked = $derived(t('Not tracked', 'Non suivi'));

	function answerStatement(answer: RecordAnswer) {
		if (!('value' in answer) || answer.state !== 'measured') return '';
		return alertReadings(answer, locale)
			.map(({ label, reading }) => `${label}: ${reading}.`)
			.join(' ');
	}
</script>

<Surface>
	<article class="grid min-w-0 gap-4">
		<header class="grid gap-2">
			<h1>{title}</h1>
			<p>
				{data.cityName}{#if data.period}
					· {dateRange(data.period, locale)}{/if}
			</p>
		</header>
		{#if !data.tracked}
			<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
				<div class="grid gap-2">
					<h2>{notTracked}</h2>
					<p>
						{t(
							'Transit does not track service alerts for this network.',
							'Transit ne suit pas les avis de service de ce réseau.',
						)}
					</p>
					{#if data.officialAlertsUrl}
						<a href={data.officialAlertsUrl}
							>{t('Check official service alerts', 'Consulter les avis officiels')}</a
						>
					{/if}
				</div>
			</Card>
		{:else if !data.period}
			<p>
				{t('Choose a period to see the record.', 'Choisissez une période pour consulter le bilan.')}
			</p>
		{:else}
			{#each data.sections as { section, answer } (section)}
				{@const heading = alertSections[section][locale]}
				<RecordSection
					{section}
					title={heading}
					{subject}
					{locale}
					url={pinned}
					{answer}
					statement={section === 'answer' ? answerStatement : undefined}
				>
					{#snippet reading(result)}
						{#if section === 'answer' && 'value' in result}
							{#if result.state === 'measured'}
								<dl class="flex flex-wrap gap-4">
									{#each alertReadings(result, locale) as { id, label, reading } (id)}
										<div>
											<dt>{label}</dt>
											<dd>{reading}</dd>
										</div>
									{/each}
								</dl>
								{@const method = result.info?.[0]?.text?.[locale]}
								{#if method}
									<p>{method.counts}</p>
									<p>{method.limits}</p>
								{/if}
							{:else}
								<p>{result.state_text[locale]}</p>
							{/if}
							{#if result.evidence.days_not_measured.length}
								<h3>{t('Days not measured', 'Jours non mesurés')}</h3>
								<ul class="list-disc pl-5">
									{#each result.evidence.days_not_measured as day (day)}
										<li>
											{alertDay(day, locale)} · {healthReason(
												result.evidence.days_not_measured_reasons?.[day],
												locale,
											)}
										</li>
									{/each}
								</ul>
							{/if}
							{#if result.evidence.days_not_tracked?.length}
								<h3>{t('Days not tracked', 'Jours sans suivi')}</h3>
								<ul class="list-disc pl-5">
									{#each result.evidence.days_not_tracked as day (day)}
										<li>{alertDay(day, locale)}</li>
									{/each}
								</ul>
							{/if}
						{:else if section === 'messages' && 'value' in result}
							{#if result.state !== 'measured'}
								<p>{result.state_text[locale]}</p>
							{:else if result.evidence.alert_messages?.length}
								<ul class="grid gap-4">
									{#each result.evidence.alert_messages as message (JSON.stringify( [message.source, message.id, message.version], ))}
										{@const header = message.header[locale] || message.header[other]}
										{@const description = message.description[locale] || message.description[other]}
										<li class="grid gap-1 wrap-anywhere">
											<h3 lang={header && !message.header[locale] ? other : undefined}>
												{header || t(`Alert ${message.id}`, `Avis ${message.id}`)}
											</h3>
											{#if description}
												<p
													class="whitespace-pre-wrap"
													lang={message.description[locale] ? undefined : other}
												>
													{description}
												</p>
											{/if}
											{#if message.periods?.length}
												<dl>
													<dt>
														{t('Active periods in local time', 'Périodes actives en heure locale')}
													</dt>
													{#each message.periods as { start, end } (`${start}/${end}`)}
														<dd>{timestamp.formatRange(new Date(start), new Date(end))}</dd>
													{/each}
												</dl>
											{/if}
											{#if message.routes.length}
												<p>
													{t('Lines', 'Lignes')} · {message.routes.map(display.line).join(', ')}
												</p>
											{/if}
											{#if message.stops.length}
												<p>{t('Stops', 'Arrêts')} · {message.stops.join(', ')}</p>
											{/if}
										</li>
									{/each}
								</ul>
							{:else if result.value.alerts === 0}
								<p>
									{t(
										'No alerts in the tracked record for these dates.',
										'Aucun avis dans le bilan suivi à ces dates.',
									)}
								</p>
							{:else}
								<p>{t('Message text is unavailable.', 'Le texte des avis est indisponible.')}</p>
							{/if}
						{:else if section !== 'answer' && section !== 'messages' && 'cells' in result}
							{#if result.cells.length}
								<RecordTable
									title={heading}
									headers={[
										groupLabels[section],
										...Object.values(alertMetrics).map((label) => label[locale]),
									]}
									rows={alertRecordRows(
										result,
										section,
										locale,
										(id) => display.lineName(id).spoken,
									)}
									stack
								/>
							{:else if result.state === 'measured'}
								<p>
									{t(
										'No matching alerts in the tracked record for these dates.',
										'Aucun avis correspondant dans le bilan suivi à ces dates.',
									)}
								</p>
							{:else}
								<p>{recordMessage({ kind: 'answer', answer: result }, locale)}</p>
							{/if}
						{/if}
					{/snippet}
				</RecordSection>
			{/each}
			{#if !alertDetailsAllowed(data.period)}
				<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
					<section id="messages" aria-labelledby="messages-title" class="grid gap-3">
						<h2 id="messages-title">{alertSections.messages[locale]}</h2>
						<p>{alertDetailsLimit[locale]}</p>
					</section>
				</Card>
			{/if}
		{/if}
	</article>
</Surface>
