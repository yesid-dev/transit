<script lang="ts">
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { page } from '$app/state';
	import { ChevronToggle } from '@yesid/ui/brand';
	import * as Collapsible from '@yesid/ui/collapsible';
	import { Surface } from '@yesid/ui/layout';
	import { onMount, type Snippet } from 'svelte';
	import { getLocale, localizeHref } from '#lib/i18n/index.ts';
	import { recoverReadings } from '#lib/features/record/recordRecovery.svelte.ts';
	import { downloadCoverage } from '#lib/features/record/downloadCoverage.ts';
	import { downloadLayouts, downloadTables } from '#lib/features/record/downloadTables.ts';
	import { healthReason, tableName } from '#lib/features/record/dataHealthText.ts';
	import {
		compactServiceDay,
		countedUnit,
		dateRange,
		fileSize,
		longDate,
		recordStamp,
		registryUnitText,
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
	const readings = recoverReadings(
		() => data,
		({ period, providerId }) =>
			period
				? {
						...period,
						screen: 'download',
						city: providerId,
						page: page.url.searchParams.toString(),
					}
				: null,
	);
	const listing = $derived(readings()?.listing ?? data.listing);
	const methods = $derived(readings()?.methods ?? data.methods);
	const t = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const title = t('Download the data', 'Télécharger les données');
	const subtitle = $derived(
		data.city ? [data.city.operator, data.city.city].join(', ') : undefined,
	);
	const methodLink = $derived(localizeHref('/metrics', locale, data.providerId));
	const stamp = $derived(
		data.window ? { kind: 'record' as const, label: recordStamp(data.window, locale) } : undefined,
	);
	// The server does not receive the fragment, so reveal the columns after hydration.
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

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
				`${count < 2 ? 'fichier est confirmé' : 'fichiers sont confirmés'} pour les dates affichées. Certaines dates n’ont pas pu être vérifiées.`,
			);
		}
		const tableCount = tally(tables.length, locale);
		const tableLabel =
			tables.length === 1
				? t(`${tableCount} table`, `${tableCount} table`)
				: t(`${tableCount} tables`, `${tableCount} tables`);
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

{#snippet disclosure(label: string, content: Snippet, id?: string)}
	<Collapsible.Root {id} class="@container" open={!!id && mounted && page.url.hash === `#${id}`}>
		<Collapsible.Trigger>
			{#snippet child({ props })}
				<button
					{...props}
					class="grid min-h-11 min-w-11 max-w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 py-2 text-start text-primary underline @max-[9rem]:gap-x-1 @max-[9rem]:text-small"
				>
					<ChevronToggle
						open={props['aria-expanded'] === 'true'}
						size="sm"
						class="mt-1 @max-[9rem]:size-3"
					/>
					<span class="[overflow-wrap:normal]">{label}</span>
				</button>
			{/snippet}
		</Collapsible.Trigger>
		<Collapsible.Content hiddenUntilFound>{@render content()}</Collapsible.Content>
	</Collapsible.Root>
{/snippet}

{#snippet contents()}
	<nav aria-label={t('On this page', 'Sur cette page')} class="flex flex-wrap gap-x-4">
		<a class="inline-flex min-h-11 items-center text-primary underline" href="#daily-files"
			>{t('Daily files', 'Fichiers quotidiens')}</a
		><a class="inline-flex min-h-11 items-center text-primary underline" href="#reading-files"
			>{t('Read a Parquet file', 'Lire un fichier Parquet')}</a
		>
	</nav>
{/snippet}

<Surface>
	<RecordScreen>
		<div data-slot="screen-content">
			<RecordGroup class="@container/daily-files"
				><div class="reading-column" data-screen-intro>
					<ScreenTitle {title} {subtitle} compact />
				</div>

				{#await listing}
					<div data-slot="screen-state" class="reading-column">
						{#key listing}<RecordPending shape="answer" {locale} />{/key}
					</div>
					{@render contents()}
					<RecordCard
						class="reading-column"
						title={t('Licence and attribution', 'Licence et attribution')}
						><RecordPending shape="card" {locale} /></RecordCard
					>
					<div id="daily-files" class="download-grid scroll-mt-8">
						{#each Object.keys(downloadLayouts) as key (key)}<RecordCard
								title={tableName(key, locale)}
								{stamp}
								stampRule
								><RecordPending
									shape={{ shape: 'tiles', count: 1, size: 'file' }}
									{locale}
								/></RecordCard
							>{/each}
					</div>
				{:then result}
					{@const listings = result?.listings ?? []}
					{@const complete = listings.filter((day) => day.status === 'complete')}
					{@const coverage = downloadCoverage(data.window, listings)}
					{@const { count } = coverage}
					{@const files = coverage.tables.flatMap(({ files }) => files.map(({ file }) => file))}
					{@const totalBytes = files.reduce((total, file) => total + file.byte_size, 0)}
					{@const notices = Object.values(
						Object.groupBy(listings, ({ licence: { changes: _changes, ...terms } }) =>
							JSON.stringify(terms),
						),
					)}
					<div data-slot="screen-answer" class="reading-column">
						{#if result?.kind === 'busy'}<RecordPending {locale} shape="answer" busy />
						{:else}<RecordAnswer
								{locale}
								time={stamp}
								value={count ? tally(count, locale) : null}
								state={count
									? undefined
									: result?.kind === 'answer' && !result.unavailable
										? 'not_measured'
										: 'unknown'}
								sentence={count
									? coverageSentence(coverage, result?.unavailable ?? false)
									: result?.kind === 'answer' && !result.unavailable
										? t(
												'No files were published for these dates.',
												'Aucun fichier n’a été publié pour ces dates.',
											)
										: recordConnection.unreachable[locale]}
							/>{/if}
					</div>

					<div class="reading-column grid min-w-0 gap-2">
						<p>
							{t(
								'These Parquet files are for data tools such as DuckDB, Python or R. For a spreadsheet, use Download on a page that shows figures.',
								'Ces fichiers Parquet sont destinés à des outils comme DuckDB, Python ou R. Pour un tableur, utilisez Télécharger sur une page qui affiche des chiffres.',
							)}
						</p>
						{#if count}<p>
								<a
									class="inline-flex min-h-11 items-center text-primary underline"
									download="transit-file-addresses.txt"
									href={'data:text/plain;charset=utf-8,' +
										encodeURIComponent(files.map(({ url }) => url).join('\n') + '\n')}
									>{t(
										'Download the list of file addresses',
										'Télécharger la liste des adresses des fichiers',
									)}</a
								>
								· {fileSize(totalBytes, locale)}
							</p>{/if}
						{@render contents()}
					</div>
					{#if count && result?.unavailable}
						<p>{recordConnection.unreachable[locale]}</p>
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

					{#if notices.length}
						<RecordCard
							interactive
							class="reading-column"
							title={t('Licence and attribution', 'Licence et attribution')}
						>
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
										{#if changes.length}
											<div class="grid gap-1" data-slot="source-changes">
												<h3 class="m-0 text-body font-semibold">
													{t('Changes to the source data', 'Modifications aux données sources')}
												</h3>
												<p>
													{t(
														'Transit cleaned and joined the agency’s files: it matched the live readings to the timetable, built the tables below for each service day and wrote times in UTC.',
														'Transit a nettoyé et joint les fichiers de la société de transport\u00a0: il a rapproché les relevés en temps réel de l’horaire, bâti les tables ci-dessous pour chaque journée de service et inscrit les heures en UTC.',
													)}
												</p>
												<p>
													{t(
														'The data was modified and is unofficial.',
														'Les données ont été modifiées et sont non officielles.',
													)}
												</p>
											</div>
										{/if}
										<p>{licence.non_endorsement[locale]} {licence.limits[locale]}</p>
										<p>
											{licence.name[locale]} · {t('Licence checked on', 'Licence vérifiée le')}
											<time datetime={licence.checked_on}
												>{longDate(licence.checked_on, locale)}</time
											>
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
									{#snippet readmeFiles()}
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
									{/snippet}
									{@render disclosure(
										t(
											'Download README with licence and checksums',
											'Télécharger le fichier README avec la licence et les sommes de contrôle',
										),
										readmeFiles,
									)}
								{/if}
							</div>
						</RecordCard>
					{/if}

					{#if coverage.tables.length}
						<div id="daily-files" class="download-grid scroll-mt-8">
							{#each coverage.tables as { table: key, files: rows, gaps } (key)}
								<RecordCard interactive title={tableName(key, locale)} {stamp} stampRule>
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
										{#snippet layoutAndFiles()}
											<div
												class="download-columns flex min-w-0 flex-wrap gap-x-2 gap-y-1"
												role="region"
												aria-label={t('Parquet columns', 'Colonnes du fichier Parquet')}
											>
												{#each downloadLayouts[key].columns as column (column)}
													<code
														>{#each column.split(/(?<=_)/u) as part, index (index)}{#if index}<wbr
																/>{/if}{part}{/each}</code
													>
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
										{/snippet}
										{@render disclosure(
											t('See the layout and files', 'Voir la structure et les fichiers'),
											layoutAndFiles,
										)}
									</div>
								</RecordCard>
							{/each}
						</div>
					{/if}

					{#if listings.some((day) => day.alerts_not_tracked)}
						<p>
							{t(
								'Notices are not tracked for this city.',
								'Les avis ne sont pas suivis pour cette ville.',
							)}
						</p>
					{/if}
					{#if !count}
						{#each [...new Set(listings.flatMap((day) => day.reason ?? []))] as reason (reason)}
							<p>{healthReason(reason, locale)}.</p>
						{/each}
					{/if}
				{/await}
			</RecordGroup>
			<RecordGroup>
				<div id="reading-files" class="reading-column download-grid scroll-mt-8">
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
								class="sql-example overflow-x-auto rounded-md border border-border p-3"
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
									'Each file names its city and the version of the method that built it. Service dates follow the agency’s operating day, which may extend past midnight. Columns ending in _utc contain UTC timestamps.',
									'Chaque fichier indique sa ville et la version de la méthode qui l’a produit. La date de service suit la journée d’exploitation de la société de transport, qui peut se prolonger après minuit. Les colonnes qui se terminent par _utc contiennent des horodatages UTC.',
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
							{#snippet measureColumns()}
								{#await methods}
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
							{/snippet}
							{@render disclosure(
								t('Measure CSV columns', 'Colonnes des CSV de mesures'),
								measureColumns,
								'measure-columns',
							)}
						</div>
					</RecordCard>
				</div>
			</RecordGroup>
		</div>
	</RecordScreen>
</Surface>

<style>
	.download-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
		gap: var(--space-card-gap);
	}
	@media screen and (min-width: 80rem) {
		@container daily-files (min-width: 54rem) {
			#daily-files {
				grid-template-columns: repeat(4, minmax(0, 1fr));
			}
		}
	}
	.download-columns {
		container-type: inline-size;
	}
	.download-columns code {
		max-inline-size: 100%;
		font-size: min(1em, 11cqi);
		overflow-wrap: normal;
	}
	.sql-example code {
		white-space: pre-wrap;
		word-break: normal;
		overflow-wrap: normal;
	}
</style>
