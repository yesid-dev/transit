<script lang="ts">
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { page } from '$app/state';
	import { Surface, DashboardGrid } from '@yesid/ui/layout';
	import { getLocale, localizeHref } from '#lib/i18n/index.ts';
	import { downloadCoverage } from '#lib/features/record/downloadCoverage.ts';
	import {
		downloadLayouts,
		downloadTables,
		missingDayReasons,
	} from '#lib/features/record/downloadTables.ts';
	import {
		compactServiceDay,
		countedUnit,
		dateRange,
		fileSize,
		recordStamp,
		registryUnitText,
		versionNumber,
	} from '#lib/site/presenter.ts';
	import { recordConnection, tally } from '#lib/features/record/recordText.ts';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordCard from '#lib/features/record/RecordCard.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import type { PageData } from './$types';

	let {
		data,
	}: { data: Pick<PageData, 'providerId' | 'city' | 'period' | 'window' | 'listing' | 'methods'> } =
		$props();
	const locale = getLocale();
	const t = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const title = t('Download the data', 'Télécharger les données');
	const subtitle = $derived(
		data.city ? [data.city.operator, data.city.city].join(', ') : undefined,
	);
	const methodLink = $derived(localizeHref('/metrics', locale, data.providerId));
	const stamp = $derived(
		data.window ? { kind: 'record' as const, label: recordStamp(data.window, locale) } : undefined,
	);

	function daysHref(index: number) {
		const url = new URL(page.url.href);
		if (index) url.searchParams.set('daysPage', String(index));
		else url.searchParams.delete('daysPage');
		return url.pathname + url.search;
	}

	function coverageSentence(
		{ count, days, tables, missing }: ReturnType<typeof downloadCoverage>,
		unavailable: boolean,
	) {
		const coverage =
			count === 1
				? t('file covers these dates', 'fichier couvre ces dates')
				: t('files cover these dates', 'fichiers couvrent ces dates');
		if (missing) {
			const number = tally(missing, locale);
			return (
				coverage +
				(missing === 1
					? t(
							`; ${number} is missing, see the cards.`,
							` ; il en manque ${number}, consultez les fiches.`,
						)
					: t(
							`; ${number} are missing, see the cards.`,
							` ; il en manque ${number}, consultez les fiches.`,
						))
			);
		}
		if (unavailable) {
			return t(
				`${count === 1 ? 'file is' : 'files are'} confirmed for the dates shown. Some dates could not be checked.`,
				`${count === 1 ? 'fichier est confirmé' : 'fichiers sont confirmés'}. Certaines dates restent à vérifier.`,
			);
		}
		const tableCount = tally(tables.length, locale);
		const tableLabel =
			tables.length === 1
				? t(`${tableCount} clean table`, `${tableCount} table nettoyée`)
				: t(`${tableCount} clean tables`, `${tableCount} tables nettoyées`);
		if (count !== tables.length * days) {
			return (
				coverage +
				t(
					` across ${tableLabel}. Table availability varies by date.`,
					` dans ${tableLabel}. La liste varie selon la date.`,
				)
			);
		}
		return (
			coverage +
			(days === 1
				? t(
						`: ${tableLabel}, one file per table for that day.`,
						` : ${tableLabel}, un fichier par table ce jour-là.`,
					)
				: t(
						`: ${tableLabel}, one file for each of the ${tally(days, locale)} days.`,
						` : ${tableLabel}, un fichier par jour sur ${tally(days, locale)} jours.`,
					))
		);
	}

	const gapLabels = {
		missing: t('Missing', 'Manquant'),
		not_measured: t('Not measured', 'Non mesuré'),
		not_published: t('Not published', 'Non publié'),
		unavailable: t('Unavailable', 'Indisponible'),
	};
</script>

<Surface>
	<RecordScreen>
		<RecordGroup><ScreenTitle {title} {subtitle} compact /></RecordGroup>
		<div data-slot="screen-content">
			<RecordGroup class="grid gap-6">
				{#await data.listing}
					<div data-slot="screen-state">
						{#key data.listing}<RecordPending {locale} />{/key}
					</div>
				{:then result}
					{@const listings = result?.listings ?? []}
					{@const complete = listings.filter((day) => day.status === 'complete')}
					{@const coverage = downloadCoverage(data.window, listings)}
					{@const { count } = coverage}
					{@const notices = Object.values(
						Object.groupBy(listings, ({ licence: { changes: _changes, ...terms } }) =>
							JSON.stringify(terms),
						),
					)}
					<div data-slot="screen-answer">
						{#if !count && result?.busy}<RecordPending {locale} busy />
						{:else}<RecordAnswer
								{locale}
								time={stamp}
								value={count ? tally(count, locale) : null}
								state={count
									? undefined
									: result && !result.unavailable
										? 'not_measured'
										: 'unknown'}
								sentence={count
									? coverageSentence(coverage, result?.unavailable ?? false)
									: result && !result.unavailable
										? t(
												'No files were published for these dates.',
												'Aucun fichier n’a été publié pour ces dates.',
											)
										: recordConnection.unreachable[locale]}
							/>{/if}
					</div>

					{#if count && result?.unavailable}
						{#if result.busy}<RecordPending {locale} busy />
						{:else}<p>{recordConnection.unreachable[locale]}</p>{/if}
					{/if}
					{#if data.window && data.period && data.window.lastPage}
						<nav
							class="flex flex-wrap items-center gap-x-4"
							aria-label={t('Download dates', 'Dates des téléchargements')}
						>
							<span
								>{t('Selected period', 'Période sélectionnée')} · {dateRange(
									data.period,
									locale,
								)}</span
							>
							{#if data.window.page < data.window.lastPage}
								<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={daysHref(data.window.page + 1)}>{t('Earlier dates', 'Dates précédentes')}</a
								>
							{/if}
							{#if data.window.page > 0}
								<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={daysHref(data.window.page - 1)}>{t('Later dates', 'Dates suivantes')}</a
								>
							{/if}
						</nav>
					{/if}

					{#if coverage.tables.length}
						<div class="download-grid">
							{#each coverage.tables as { table: key, files: rows, gaps, sources } (key)}
								<RecordCard interactive title={downloadLayouts[key][locale]} {stamp}>
									<div class="grid min-w-0 grid-cols-1 gap-2">
										<p>{downloadTables[key][locale]}</p>
										{#if rows.length}<p class="text-sm text-muted-foreground">
												{countedUnit(rows.length, 'day', locale)} ·
												{fileSize(
													rows.reduce((total, { file }) => total + file.byte_size, 0),
													locale,
												)}
											</p>{/if}
										{#if gaps.length}
											<ul
												class="grid gap-1 text-sm"
												aria-label={t('Dates without files', 'Dates sans fichier')}
											>
												{#each gaps as { date, status } (date)}
													<li class="flex flex-wrap items-baseline gap-x-2">
														<time datetime={date}>{compactServiceDay(date, locale)}</time>
														<StateMark
															state={status === 'unavailable' ? 'unknown' : 'not_measured'}
															{locale}
															hiddenLabel
														/>
														<span>{gapLabels[status]}</span>
													</li>
												{/each}
											</ul>
										{/if}
										<details>
											<summary class="min-h-11 min-w-11 cursor-pointer py-3 text-primary underline"
												>{t(
													'See the layout and files',
													'Voir la structure et les fichiers',
												)}</summary
											>
											<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard access to columns that overflow at large text sizes.) -->
											<div
												class="code-scroll flex min-h-11 flex-wrap gap-x-2 gap-y-1 overflow-x-auto"
												tabindex="0"
												role="region"
												aria-label={t('Parquet columns', 'Colonnes du fichier Parquet')}
											>
												{#each downloadLayouts[key].columns as column (column)}
													<code>{column}</code>
												{/each}
											</div>
											{#if rows.length}<ul
													class="flex flex-wrap gap-x-4"
													aria-label={t('Files by service date', 'Fichiers par journée de service')}
												>
													{#each rows as { file, day } (file.url)}
														<li>
															<a
																class="inline-flex min-h-11 flex-wrap items-center gap-x-1 text-primary underline"
																href={file.url}
																aria-label={file.name +
																	' · ' +
																	compactServiceDay(day.service_date, locale) +
																	' · ' +
																	fileSize(file.byte_size, locale)}
															>
																<time datetime={day.service_date}
																	>{compactServiceDay(day.service_date, locale)}</time
																>
																<span class="whitespace-nowrap tabular-nums"
																	>· {fileSize(file.byte_size, locale)}</span
																>
															</a>
														</li>
													{/each}
												</ul>{/if}
										</details>
									</div>
									{#snippet footer()}
										<p class="font-mono text-sm text-muted-foreground">
											{[...new Set(sources.map((day) => day.licence.name[locale]))].join(' · ')}
											· {t('Cleaning', 'Nettoyage')}
											{[...new Set(sources.map((day) => versionNumber(day.cleaning_version)))].join(
												', ',
											)}
										</p>
									{/snippet}
								</RecordCard>
							{/each}
						</div>
					{/if}

					{#if listings.some((day) => day.alerts_not_tracked)}
						<p>
							{t(
								'Service alerts are not tracked for this city.',
								'Les avis de service ne sont pas suivis pour cette ville.',
							)}
						</p>
					{/if}
					{#if !count}
						{#each [...new Set(listings.flatMap((day) => day.reason ?? []))] as reason (reason)}
							<p>{missingDayReasons[reason][locale]}</p>
						{/each}
					{/if}

					{#if notices.length}
						<RecordCard interactive title={t('Licence and attribution', 'Licence et attribution')}>
							<div class="grid gap-3">
								{#each notices as group (group![0].service_date)}
									{@const licence = group![0].licence}
									{@const changes = [
										...new Set(
											group!
												.filter((day) => day.status === 'complete')
												.map((day) => day.licence.changes[locale]),
										),
									]}
									<div class="grid gap-2">
										<p>
											<a
												class="inline-flex min-h-11 items-center text-primary underline"
												href={licence.url[locale]}>{licence.attribution[locale]}</a
											>
										</p>
										{#if changes.length === 1}
											<p>{changes[0]}</p>
										{:else if changes.length}
											<details>
												<summary
													class="min-h-11 min-w-11 cursor-pointer py-3 text-primary underline"
													>{t(
														'Changes to the source data',
														'Modifications aux données sources',
													)}</summary
												>
												<ul class="grid gap-2">
													{#each changes as change (change)}<li>{change}</li>{/each}
												</ul>
											</details>
										{/if}
										<p>{licence.non_endorsement[locale]} {licence.limits[locale]}</p>
										<p>
											{licence.name[locale]} · {t('Licence checked on', 'Licence vérifiée le')}
											<time datetime={licence.checked_on}>{licence.checked_on}</time>
										</p>
										<p>
											{t('Removal requests', 'Demandes de retrait')}
											<a class="text-primary underline" href={'mailto:' + licence.contact}
												>{licence.contact}</a
											>
										</p>
									</div>
								{/each}
								{#if complete.some((day) => day.readme_url)}
									<details>
										<summary class="min-h-11 min-w-11 cursor-pointer py-3 text-primary underline">
											{t(
												'Download README with licence and checksums',
												'Télécharger le fichier README avec la licence et les sommes de contrôle',
											)}
										</summary>
										<ul class="flex flex-wrap gap-x-4">
											{#each complete as day (day.service_date)}
												{#if day.readme_url}
													<li>
														<a
															class="inline-flex min-h-11 min-w-11 items-center text-primary underline"
															href={day.readme_url}>{compactServiceDay(day.service_date, locale)}</a
														>
													</li>
												{/if}
											{/each}
										</ul>
									</details>
								{/if}
							</div>
						</RecordCard>
					{/if}
				{/await}
			</RecordGroup>
			<RecordGroup>
				<DashboardGrid gutter={false} minTile="20rem">
					<RecordCard title={t('Read a Parquet file', 'Lire un fichier Parquet')}>
						<div class="grid min-w-0 grid-cols-1 gap-2 text-sm">
							<p>
								{t(
									'Open DuckDB in the folder with your download and use its filename in the query.',
									'Ouvrez DuckDB dans le dossier du téléchargement et utilisez le nom du fichier dans la requête.',
								)}
							</p>
							<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard access to the horizontally scrollable SQL query.) -->
							<pre
								class="code-scroll sql-example overflow-x-auto rounded-md border border-border p-3"
								tabindex="0"
								role="region"
								aria-label={t('DuckDB query', 'Requête DuckDB')}><code
									>SELECT * FROM read_parquet('file.parquet') LIMIT 10;</code
								></pre>
						</div>
					</RecordCard>
					<RecordCard interactive title={t('About these files', 'À propos de ces fichiers')}>
						<div class="grid gap-2">
							<p>
								{t(
									'The files identify the provider and cleaning version. Service dates follow the agency’s operating day, which may extend past midnight. Columns ending in _utc contain UTC timestamps.',
									'Les fichiers indiquent le fournisseur et la version du nettoyage. La date de service suit la journée d’exploitation de l’agence, qui peut se prolonger après minuit. Les colonnes qui se terminent par _utc contiennent des horodatages UTC.',
								)}
							</p>
							<ul class="flex flex-wrap gap-x-4">
								<li>
									<a
										class="inline-flex min-h-11 items-center text-primary underline"
										href={methodLink}>{t('How we measure', 'Comment on mesure')}</a
									>
								</li>
								<li>
									<a
										class="inline-flex min-h-11 items-center text-primary underline"
										href={localizeHref('/status', locale, data.providerId)}
										>{t('Data health', 'Santé des données')}</a
									>
								</li>
							</ul>
							<details id="measure-columns">
								<summary class="min-h-11 min-w-11 cursor-pointer py-3 text-primary underline"
									>{t('Measure CSV columns', 'Colonnes des CSV de mesures')}</summary
								>
								{#await data.methods}
									<p>{t('Loading…', 'Chargement…')}</p>
								{:then result}
									{#if result?.kind === 'answer'}
										<dl class="grid gap-3">
											{#each result.answer.filter((entry) => entry.csv_columns[locale].length) as entry (entry.id)}
												<div>
													<dt class="font-semibold">{entry.text[locale].definition}</dt>
													<dd>
														{entry.csv_columns[locale]
															.map((column) => registryUnitText(column, locale))
															.join(', ')}
													</dd>
												</div>
											{/each}
										</dl>
									{:else}
										<p>{recordConnection.unreachable[locale]}</p>
									{/if}
								{/await}
							</details>
						</div>
					</RecordCard>
				</DashboardGrid>
			</RecordGroup>
		</div>
	</RecordScreen>
</Surface>

<style>
	.download-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
		gap: var(--space-card-gap);
	}
	.code-scroll code {
		white-space: nowrap;
		word-break: normal;
		overflow-wrap: normal;
	}
	.sql-example code {
		white-space: pre-wrap;
	}
</style>
