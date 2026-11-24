<script lang="ts">
	import { fileSize, versionNumber } from '#lib/site/presenter.ts';
	import { Card } from '@yesid/ui/card';
	import { Surface } from '@yesid/ui/layout';
	import { getLocale, localizeHref } from '#lib/i18n/index.ts';
	import { downloadTables, missingDayReasons } from '#lib/features/record/downloadTables.ts';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import type { PageData } from './$types';

	let {
		data,
	}: { data: Pick<PageData, 'providerId' | 'providers' | 'date' | 'invalidDate' | 'listing'> } =
		$props();
	const locale = getLocale();
	const t = (en: string, fr: string) => (locale === 'fr' ? fr : en);
	const title = $derived(t('Download the data', 'Télécharger les données'));
	const { segment_runs: segmentRuns, ...existingTables } = downloadTables;
</script>

{#snippet tableDescription(name: string, description: string)}
	<div class="grid gap-1 border-t border-border pt-3">
		<dt><code>{name}</code></dt>
		<dd>{description}</dd>
	</div>
{/snippet}

<Surface>
	<div class="grid min-w-0 gap-6">
		<header class="grid gap-2">
			<h1>{title}</h1>
			<p>
				{t(
					'Download the clean tables behind Transit’s measures, one service date at a time.',
					'Téléchargez les tables nettoyées qui servent aux mesures de Transit, une journée de service à la fois.',
				)}
			</p>
			<ul class="flex flex-wrap gap-x-6">
				<li>
					<a
						class="inline-flex min-h-11 items-center"
						href={localizeHref('/metrics', locale, data.providerId)}
						>{t('How we measure', 'Comment on mesure')}</a
					>
				</li>
				<li>
					<a
						class="inline-flex min-h-11 items-center"
						href={localizeHref('/status', locale, data.providerId)}
						>{t('Data health', 'Santé des données')}</a
					>
				</li>
			</ul>
		</header>

		<Card edge="neutral" textSize="inherit" class="min-w-0 px-4 sm:px-6">
			<section class="grid min-w-0 gap-4" aria-labelledby="files-heading">
				<h2 id="files-heading">{t('Files by service date', 'Fichiers par journée de service')}</h2>
				{#await data.listing}
					<RecordPending {locale} />
				{:then result}
					{@const listing = result?.kind === 'answer' ? result.answer : null}
					{#if data.providers.length}
						{#key data.providerId + (data.date ?? '')}
							<form method="GET" class="flex flex-wrap items-end gap-3">
								<label class="grid gap-1">
									{t('City', 'Ville')}
									<select
										name="provider"
										class="min-h-11 rounded-md border border-border bg-background px-3"
									>
										{#each data.providers as city (city.id)}
											<option value={city.id} selected={city.id === data.providerId}
												>{city.labels[locale].city}</option
											>
										{/each}
									</select>
								</label>
								<label class="grid gap-1">
									{t('Service date', 'Date de service')}
									<input
										name="date"
										type="date"
										value={data.date ?? listing?.service_date ?? ''}
										required
										class="min-h-11 rounded-md border border-border bg-background px-3"
									/>
								</label>
								<button
									type="submit"
									class="min-h-11 rounded-md border border-border px-3 underline"
									>{t('Find files', 'Trouver les fichiers')}</button
								>
							</form>
						{/key}
					{/if}

					{#if data.invalidDate}
						<p>{t('Choose a valid service date.', 'Choisissez une date de service valide.')}</p>
					{:else if !listing}
						<p>
							{result?.kind === 'busy'
								? t(
										'The download service is busy. Try again shortly.',
										'Le service de téléchargement est occupé. Réessayez dans un instant.',
									)
								: t(
										'The file listing is temporarily unavailable.',
										'La liste des fichiers est temporairement indisponible.',
									)}
						</p>
					{:else}
						<p>
							<time datetime={listing.service_date}>{listing.service_date}</time>
							<span>
								· {t('Cleaning version', 'Version du nettoyage')}
								{versionNumber(listing.cleaning_version)}</span
							>
						</p>
						{#if listing.status === 'complete'}
							<ul class="grid min-w-0 gap-1">
								{#each listing.files as file (file.name)}
									<li class="flex flex-wrap items-baseline gap-x-3 border-t border-border">
										<a class="inline-flex min-h-11 items-center break-all" href={file.url}
											>{file.name}</a
										>
										<span>{fileSize(file.byte_size, locale)}</span>
									</li>
								{/each}
							</ul>
						{:else if listing.reason}
							<p>
								{listing.status === 'not_measured'
									? t('Day not measured.', 'Journée non mesurée.')
									: t('Files unavailable.', 'Fichiers indisponibles.')}
								{missingDayReasons[listing.reason][locale]}
							</p>
						{/if}
						{#if listing.alerts_not_tracked}
							<p>
								{t(
									'Service alerts are not tracked for this city.',
									'Les avis de service ne sont pas suivis pour cette ville.',
								)}
							</p>
						{/if}

						{@const licence = listing.licence}
						<div class="grid gap-2 border-t border-border pt-4">
							<h3>{t('Licence and attribution', 'Licence et attribution')}</h3>
							<p><a href={licence.url[locale]}>{licence.attribution[locale]}</a></p>
							{#if listing.status === 'complete'}<p>{licence.changes[locale]}</p>{/if}
							<p>{licence.non_endorsement[locale]} {licence.limits[locale]}</p>
							<p>
								{licence.name[locale]} · {t('Licence checked on', 'Licence vérifiée le')}
								<time datetime={licence.checked_on}>{licence.checked_on}</time>
							</p>
							<p>
								{t('Removal requests', 'Demandes de retrait')}
								<a href={'mailto:' + licence.contact}>{licence.contact}</a>
							</p>
							{#if listing.readme_url}
								<a
									class="inline-flex min-h-11 items-center justify-self-start"
									href={listing.readme_url}
									>{t(
										'Download README with licence and checksums',
										'Télécharger le fichier README avec la licence et les sommes de contrôle',
									)}</a
								>
							{/if}
						</div>
					{/if}
				{/await}
			</section>
		</Card>

		<section class="grid min-w-0 gap-3" aria-labelledby="tables-heading">
			<h2 id="tables-heading">{t('What the tables contain', 'Ce que contiennent les tables')}</h2>
			<p>
				{t(
					'The files identify the provider and cleaning version. Service dates follow the agency’s operating day, which may extend past midnight. Columns ending in _utc contain UTC timestamps.',
					'Les fichiers indiquent le fournisseur et la version du nettoyage. La date de service suit la journée d’exploitation de l’agence, qui peut se prolonger après minuit. Les colonnes qui se terminent par _utc contiennent des horodatages UTC.',
				)}
			</p>
			<dl class="grid gap-3">
				{#each Object.entries(existingTables) as [name, description] (name)}
					{@render tableDescription(name, description[locale])}
				{/each}
				{#await data.listing then result}
					{#if result?.kind === 'answer' && Number(result.answer.cleaning_version) >= 12}
						{@render tableDescription('segment_runs', segmentRuns[locale])}
					{/if}
				{/await}
			</dl>
		</section>

		<section class="grid min-w-0 gap-2" aria-labelledby="parquet-heading">
			<h2 id="parquet-heading">{t('Read a Parquet file', 'Lire un fichier Parquet')}</h2>
			<p>
				{t(
					'Open DuckDB in the folder with your download and use its filename in the query.',
					'Ouvrez DuckDB dans le dossier du téléchargement et utilisez le nom du fichier dans la requête.',
				)}
			</p>
			<pre class="overflow-x-auto rounded-md border border-border p-3"><code
					>SELECT * FROM read_parquet('file.parquet') LIMIT 10;</code
				></pre>
		</section>
	</div>
</Surface>
