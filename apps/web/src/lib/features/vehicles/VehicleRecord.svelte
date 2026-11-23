<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordActions from '#lib/features/record/RecordActions.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import RecordTable from '#lib/features/record/RecordTable.svelte';
	import { recordSectionLinks } from '#lib/features/record/recordLinks.ts';
	import {
		choose,
		dateRange,
		lastGoodNote,
		methodEvidence,
		recordMessage,
		pooledDays,
		punctualityWeighting,
		timingBasis,
		coverageText,
		tally,
	} from '#lib/features/record/recordText.ts';
	import type { loadVehiclePage } from '#lib/server/vehicleRecord.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import {
		assignmentCaution,
		sectionTitles,
		vehicleReading,
		vehicleRecordState,
	} from './vehicleText.ts';
	import VehicleFleetRows from './VehicleFleetRows.svelte';
	import { vehicleHref } from './vehicleLinks.ts';

	let {
		data,
		url,
		locale,
		title,
	}: {
		data: ReturnType<typeof loadVehiclePage>;
		url: URL;
		locale: Locale;
		title: string;
	} = $props();

	let search = $state('');
	const display = transitDisplay();
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const number = (value: number | null | undefined) =>
		value == null ? t('Unknown', 'Inconnu') : tally(value, locale);
	const serviceMetrics = $derived([
		['vehicle_days_in_service', t('Days in service', 'Jours en service')],
		['vehicle_hours_in_service', t('Hours in service', 'Heures en service')],
		['vehicle_lines_run', t('Distinct lines', 'Lignes distinctes')],
		['vehicle_trips_run', t('Trips run', 'Voyages effectués')],
	] as const);
</script>

{#each data.sections as { section, answer } (section)}
	{@const heading = sectionTitles[section][locale === 'fr' ? 1 : 0]}
	{@const links = recordSectionLinks(url, section)}
	<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
		<section id={section} aria-labelledby={`${section}-title`} class="grid min-w-0 gap-3">
			<h2 id={`${section}-title`}>{heading}</h2>
			{#if section === 'punctuality'}<p>{assignmentCaution[locale]}</p>{/if}
			{#await answer}
				{#key answer}<RecordPending {locale} />{/key}
			{:then result}
				{@const message = recordMessage(result, locale)}
				{#if result.kind === 'answer'}
					{@const reading = result.answer}
					{@const included = reading.evidence.days_included.length}
					{#if result.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
					{#if section === 'completion'}
						<p>{t('Not tracked', 'Non suivi')}</p>
						<p>
							{t(
								'The live feeds do not show reliably when a trip ends early, so trips not finished are not tracked.',
								'Les flux en direct ne montrent pas de façon fiable quand un trajet se termine tôt, alors les trajets non terminés ne sont pas suivis.',
							)}
						</p>
					{:else if message}
						<p>
							{vehicleRecordState('state' in reading ? reading.state : undefined, message, locale)}
						</p>
					{:else if 'cells' in reading}
						{#if section === 'fleet'}
							<label class="grid max-w-sm gap-1">
								{t('Find by vehicle number', 'Rechercher par numéro de véhicule')}
								<input
									class="min-h-11 rounded-md border border-border px-3"
									type="search"
									bind:value={search}
								/>
							</label>
							{#snippet vehicleLink(id: string)}
								<a
									class="inline-flex min-h-11 items-center"
									href={vehicleHref(`/vehicle/${encodeURIComponent(id)}`, url, locale, data.city)}
									>{id}</a
								>
							{/snippet}
							<VehicleFleetRows cells={reading.cells} {search} {locale} rowLabel={vehicleLink} />
						{:else}
							<RecordTable
								title={heading}
								headers={[t('Line', 'Ligne'), t('Trips run', 'Voyages effectués')]}
								rows={reading.cells.flatMap((cell) =>
									typeof cell.key.line === 'string'
										? [
												[
													display.lineName(cell.key.line).label,
													cell.state === 'measured'
														? number(cell.value.vehicle_trips_run)
														: cell.state_text[locale],
												],
											]
										: [],
								)}
							/>
						{/if}
					{:else if 'value' in reading}
						{@const counts = reading.evidence.counts}
						{#if section === 'service'}
							<dl class="flex flex-wrap gap-4">
								{#each serviceMetrics as [measure, label] (measure)}
									<div>
										<dt>{label}</dt>
										<dd>{vehicleReading(reading, measure, locale)}</dd>
									</div>
								{/each}
							</dl>
							<p>
								{t(
									'Days count dates with a position reported on a trip.',
									'Les jours comptés sont ceux où une position a été signalée pendant un voyage.',
								)}
							</p>
						{:else if section === 'reporting'}
							<p>
								{vehicleReading(reading, 'vehicle_reporting_gaps_per_100_hours', locale)}
								{t(
									'interruptions per 100 hours in service',
									'interruptions par 100 heures en service',
								)}
							</p>
							{#if counts.reporting_gaps != null && counts.hours_in_service != null}
								<p>
									{t(
										`${number(counts.reporting_gaps)} interruptions over ${number(counts.hours_in_service)} hours in service.`,
										`${number(counts.reporting_gaps)} interruptions sur ${number(counts.hours_in_service)} heures en service.`,
									)}
								</p>
							{/if}
							<p>
								{t(
									`The feed cannot tell whether the vehicle kept running.`,
									`Le flux n’indique pas si le véhicule a continué de rouler.`,
								)}
							</p>
						{:else if section === 'punctuality'}
							{@const basis = timingBasis(counts, locale)}
							{@const coverage = coverageText(reading.evidence, locale)}
							<p>
								{vehicleReading(reading, 'vehicle_on_time', locale)}
								{t(
									`on time (${number(counts.punctuality_on_time)} of ${number(counts.punctuality_classified)} observed stop events)`,
									`à l’heure (${number(counts.punctuality_on_time)} sur ${number(counts.punctuality_classified)} passages observés)`,
								)}
								{#if coverage}
									· {coverage}{/if}
							</p>
							{#if basis}<p>{basis}</p>{/if}
							<p>{punctualityWeighting[locale]}</p>
							{#if reading.evidence.start_date !== reading.evidence.end_date}<p>
									{pooledDays[locale]}
								</p>{/if}
						{/if}
					{/if}
					{#if section !== 'completion'}
						{#if reading.coverage_note}<p>{reading.coverage_note[locale]}</p>{/if}
						<p>
							{included === 1
								? t('1 day included.', '1 jour retenu.')
								: t(`${number(included)} days included.`, `${number(included)} jours retenus.`)}
							{methodEvidence(reading.evidence, locale)}
						</p>
					{/if}
					<RecordActions
						{locale}
						title={heading}
						href={links.share}
						csv={links.csv}
						citation={`Transit. ${title}. ${heading}. ${data.period ? dateRange(data.period, locale) : ''}. ${methodEvidence(reading.evidence, locale)} ${links.share}`}
					/>
				{:else if message}
					<p>{message}</p>
				{/if}
			{/await}
		</section>
	</Card>
{:else}
	<p>{t('Choose dates to see the record.', 'Choisissez des dates pour voir le bilan.')}</p>
{/each}
