<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import * as Sheet from '@yesid/ui/sheet';
	import { Separator } from '@yesid/ui/separator';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';

	let {
		locale,
		href,
		files,
		groupLabel,
		createDownload,
		citation,
		figures,
		print,
		printNote,
	}: {
		locale: Locale;
		href: string;
		files: readonly {
			href?: string;
			label: string;
			download?: string;
			columns?: readonly string[];
			/** The file's size, written for people, when it is known before the download. */
			size?: string | null;
		}[];
		groupLabel?: string;
		createDownload?: () => { href: string; filename: string } | null;
		/** The page's citation, one CiteBlock, shown first. */
		citation: Snippet;
		/** One CiteBlock per card, under "Cite one figure". */
		figures?: Snippet;
		print?: () => void;
		/** What printing gives, read with the Print button and shown on hover. */
		printNote?: string;
	} = $props();
	const fr = $derived(locale === 'fr');
	const uid = $props.id();
	const figuresId = `${uid}-figures`;
	const printNoteId = `${uid}-print`;
	function download(): void {
		const file = createDownload?.();
		if (!file) return;
		const link = document.createElement('a');
		link.href = file.href;
		link.download = file.filename;
		link.hidden = true;
		document.body.append(link);
		try {
			link.click();
		} finally {
			link.remove();
		}
	}
</script>

{#key href}
	<div
		class="flex min-w-0 flex-wrap items-start gap-2"
		role="group"
		aria-label={groupLabel ?? (fr ? 'Actions du bilan' : 'Record actions')}
	>
		<CopyAction
			size="cta-sm"
			text={href}
			label={fr ? 'Copier le lien' : 'Copy link'}
			done={fr ? 'Lien copié.' : 'Link copied.'}
			fallback={fr ? 'Copiez le lien ci-dessous.' : 'Copy the link below.'}
			fallbackLabel={fr ? 'Lien vers cette vue' : 'Link to this view'}
		/>
		{#if createDownload}
			<Button onclick={download} variant="outline" size="cta-sm" class="min-h-11"
				>{fr ? 'Télécharger' : 'Download'}</Button
			>
		{:else if files.length}
			<Sheet.Root>
				<Sheet.Trigger>
					{#snippet child({ props })}<Button
							{...props}
							variant="outline"
							size="cta-sm"
							class="min-h-11">{fr ? 'Télécharger' : 'Download'}</Button
						>{/snippet}
				</Sheet.Trigger>
				<Sheet.Content side="bottom" showCloseButton={false} class="max-h-[90dvh] overflow-y-auto">
					<Sheet.Header>
						<Sheet.Title
							>{fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files'}</Sheet.Title
						>
					</Sheet.Header>
					<ul
						class="grid min-w-0 gap-1 px-4 wrap-break-word"
						role="list"
						data-slot="download-files"
					>
						{#each files as file, index (index)}
							<li class="min-w-0" data-slot="download-file">
								<div class="flex min-w-0 flex-wrap items-center justify-between gap-x-4">
									{#if file.href}<a
											class="inline-flex min-h-11 min-w-0 items-center text-primary underline"
											href={file.href}
											download={file.download ?? true}>{file.label}</a
										>{:else}<p class="m-0 inline-flex min-h-11 items-center">{file.label}</p>{/if}
									{#if file.size}<span
											class="font-mono text-caption text-muted-foreground tabular-nums"
											data-slot="download-file-size">{file.size}</span
										>{/if}
								</div>
								{#if file.columns?.length}
									<details>
										<summary class="min-h-11 cursor-pointer py-3">
											{fr ? 'Colonnes du CSV' : 'CSV columns'}
											<span class="sr-only">{file.label}</span>
										</summary>
										<ul class="list-disc ps-5">
											{#each file.columns as column, columnIndex (columnIndex)}<li>
													{column}
												</li>{/each}
										</ul>
									</details>
								{/if}
							</li>
						{/each}
					</ul>
					<Sheet.Footer>
						<Sheet.Close>
							{#snippet child({ props })}<Button
									{...props}
									variant="outline"
									size="cta-sm"
									class="min-h-11">{fr ? 'Fermer' : 'Close'}</Button
								>{/snippet}
						</Sheet.Close>
					</Sheet.Footer>
				</Sheet.Content>
			</Sheet.Root>
		{/if}
		<Sheet.Root>
			<Sheet.Trigger>
				{#snippet child({ props })}<Button
						{...props}
						variant="outline"
						size="cta-sm"
						class="min-h-11">{fr ? 'Citer' : 'Cite'}</Button
					>{/snippet}
			</Sheet.Trigger>
			<Sheet.Content side="bottom" showCloseButton={false} class="max-h-[90dvh] overflow-y-auto">
				<Sheet.Header>
					<Sheet.Title>{fr ? 'Citer' : 'Cite'}</Sheet.Title>
				</Sheet.Header>
				<div class="grid min-w-0 gap-6 px-4 wrap-break-word" data-slot="cite-sheet-body">
					<div class="grid min-w-0 gap-4" data-slot="cite-page">{@render citation()}</div>
					{#if figures}
						<section
							class="grid min-w-0 gap-4"
							aria-labelledby={figuresId}
							data-slot="cite-figures"
						>
							<Separator decorative />
							<h3 id={figuresId} class="m-0 text-body font-semibold">
								{fr ? 'Citer un seul chiffre' : 'Cite one figure'}
							</h3>
							{@render figures()}
						</section>
					{/if}
				</div>
				<Sheet.Footer>
					<Sheet.Close>
						{#snippet child({ props })}<Button
								{...props}
								variant="outline"
								size="cta-sm"
								class="min-h-11">{fr ? 'Fermer' : 'Close'}</Button
							>{/snippet}
					</Sheet.Close>
				</Sheet.Footer>
			</Sheet.Content>
		</Sheet.Root>
		{#if print}<Button
				variant="outline"
				size="cta-sm"
				class="min-h-11"
				onclick={print}
				title={printNote}
				aria-describedby={printNote ? printNoteId : undefined}>{fr ? 'Imprimer' : 'Print'}</Button
			>{#if printNote}<span id={printNoteId} class="sr-only">{printNote}</span>{/if}{/if}
	</div>
{/key}
