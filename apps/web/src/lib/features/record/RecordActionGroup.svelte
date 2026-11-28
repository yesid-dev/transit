<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '@yesid/ui/button';
	import * as Collapsible from '@yesid/ui/collapsible';
	import * as Sheet from '@yesid/ui/sheet';
	import { Separator } from '@yesid/ui/separator';
	import type { Snippet } from 'svelte';
	import { actionSheetLayout } from '#lib/components/shared/actionSheetLayout.svelte.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { localizeHref } from '#lib/i18n/routing.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { readRecordPageStamp, recordPrints } from '#lib/site/recordPageStampContext.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';

	let {
		locale,
		href,
		files,
		reserveDownload = false,
		groupLabel,
		createDownload,
		citation,
		figures,
		print,
		printDisabled = false,
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
		reserveDownload?: boolean;
		groupLabel?: string;
		createDownload?: () => { href: string; filename: string } | null;
		/** The page's citation, one CiteBlock, shown first. */
		citation: Snippet;
		/** One CiteBlock per card, under "Cite one figure". */
		figures?: Snippet;
		print?: () => void;
		printDisabled?: boolean;
		/** What printing gives, read with the Print button and shown on hover. */
		printNote?: string;
	} = $props();
	const fr = $derived(locale === 'fr');
	const printPage = () => window.print();
	// A report's Record view prints, also when its address does not name the Record frame.
	const pageStamp = readRecordPageStamp();
	const printAction = $derived(
		print ?? (recordPrints(page.url, pageStamp()) ? printPage : undefined),
	);
	const windowLayout = actionSheetLayout();
	const closeLabel = $derived(fr ? 'Fermer' : 'Close');
	const citeLabel = $derived(fr ? 'Citer' : 'Cite');
	const citeSheetTitle = $derived(fr ? 'Citer ce bilan' : 'Cite this record');
	let downloadTitle = $state<HTMLElement | null>(null);
	let citeTitle = $state<HTMLElement | null>(null);
	const uid = $props.id();
	const figuresId = `${uid}-figures`;
	// Download sits in a form that leads to the same dates' files on the Download page, so a press
	// before the page has hydrated still leads somewhere. Once hydrated, it opens the window instead.
	const downloadPage = $derived.by(() => {
		const pinned = new URL(href, 'https://transit.invalid');
		const page = localizeHref(
			'/download',
			locale,
			pinned.searchParams.get('provider') ?? undefined,
		);
		const target = new URL(carryFrameState(page, pinned), 'https://transit.invalid');
		return { action: target.pathname + '#daily-files', fields: [...target.searchParams] };
	});
	function openInPlace(event: MouseEvent, open: unknown) {
		// Open first: the window's own handler skips an event whose default is already prevented.
		if (typeof open === 'function') open(event);
		event.preventDefault();
	}
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

{#snippet closeFooter()}
	<Sheet.Footer class={windowLayout.centered ? 'items-end' : undefined}>
		<Sheet.Close>
			{#snippet child({ props })}
				<Button {...props} variant="outline" size="cta-sm" class="min-h-11">
					{closeLabel}
				</Button>
			{/snippet}
		</Sheet.Close>
	</Sheet.Footer>
{/snippet}

{#snippet columnList(columns: readonly string[])}
	<ul class="list-disc ps-5">
		{#each columns as column, index (index)}<li>{column}</li>{/each}
	</ul>
{/snippet}

{#key href}
	<div
		class="flex min-w-0 flex-wrap items-start gap-2 lg:w-max lg:max-w-full"
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
			<form class="contents" method="get" action={downloadPage.action}>
				{#each downloadPage.fields as [name, value] (name)}<input
						type="hidden"
						{name}
						{value}
					/>{/each}
				<Sheet.Root>
					<Sheet.Trigger {...windowLayout.trigger}>
						{#snippet child({ props })}<Button
								{...props}
								type="submit"
								onclick={(event: MouseEvent) => openInPlace(event, props.onclick)}
								variant="outline"
								size="cta-sm"
								class="min-h-11">{fr ? 'Télécharger' : 'Download'}</Button
							>{/snippet}
					</Sheet.Trigger>
					<Sheet.Content
						side={windowLayout.side}
						showCloseButton={windowLayout.centered}
						{closeLabel}
						class={windowLayout.centered ? undefined : 'max-h-[90dvh] overflow-y-auto'}
						onOpenAutoFocus={(event) => windowLayout.focusTitle(event, downloadTitle)}
					>
						<Sheet.Header>
							<Sheet.Title
								bind:ref={downloadTitle}
								tabindex={windowLayout.centered ? -1 : undefined}
								class={windowLayout.titleClass}
								>{fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files'}</Sheet.Title
							>
						</Sheet.Header>
						<Sheet.Body>
							<ul class="grid min-w-0 gap-1 wrap-break-word" role="list" data-slot="download-files">
								{#each files as file, index (index)}
									<li class="min-w-0" data-slot="download-file">
										<div
											class={[
												'flex min-w-0 items-center justify-between gap-x-4',
												!windowLayout.centered && 'flex-wrap',
											]}
										>
											{#if file.href}<a
													class="inline-flex min-h-11 min-w-0 items-center text-primary underline"
													href={file.href}
													download={file.download ?? true}>{file.label}</a
												>{:else}<p class="m-0 inline-flex min-h-11 items-center">
													{file.label}
												</p>{/if}
											{#if file.size}<span
													class="shrink-0 font-mono text-caption text-muted-foreground tabular-nums"
													data-slot="download-file-size">{file.size}</span
												>{/if}
										</div>
										{#if file.columns?.length && windowLayout.centered}
											<Collapsible.Root>
												<Collapsible.Trigger class="min-h-11 cursor-pointer text-start underline">
													{fr ? 'Colonnes du CSV' : 'CSV columns'}
													<span class="sr-only">{file.label}</span>
												</Collapsible.Trigger>
												<Collapsible.Content>
													{@render columnList(file.columns)}
												</Collapsible.Content>
											</Collapsible.Root>
										{:else if file.columns?.length}
											<details>
												<summary class="min-h-11 cursor-pointer py-3">
													{fr ? 'Colonnes du CSV' : 'CSV columns'}
													<span class="sr-only">{file.label}</span>
												</summary>
												{@render columnList(file.columns)}
											</details>
										{/if}
									</li>
								{/each}
							</ul>
						</Sheet.Body>
						{@render closeFooter()}
					</Sheet.Content>
				</Sheet.Root>
			</form>
		{:else if reserveDownload}
			<Button variant="outline" size="cta-sm" class="invisible min-h-11" aria-hidden="true" disabled
				>{fr ? 'Télécharger' : 'Download'}</Button
			>
		{/if}
		<Sheet.Root>
			<Sheet.Trigger {...windowLayout.trigger}>
				{#snippet child({ props })}<Button
						{...props}
						variant="outline"
						size="cta-sm"
						class="min-h-11">{citeLabel}</Button
					>{/snippet}
			</Sheet.Trigger>
			<Sheet.Content
				side={windowLayout.side}
				showCloseButton={windowLayout.centered}
				{closeLabel}
				style="--sheet-center-width: 48rem"
				class={windowLayout.centered ? undefined : 'max-h-[90dvh] overflow-y-auto'}
				onOpenAutoFocus={(event) => windowLayout.focusTitle(event, citeTitle)}
			>
				<Sheet.Header>
					<Sheet.Title
						bind:ref={citeTitle}
						tabindex={windowLayout.centered ? -1 : undefined}
						class={windowLayout.titleClass}
					>
						{citeSheetTitle}
					</Sheet.Title>
				</Sheet.Header>
				<Sheet.Body>
					<div
						class="group/cite grid min-w-0 gap-6 wrap-break-word"
						data-slot="cite-sheet-body"
						data-cite-window={windowLayout.centered ? '' : undefined}
					>
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
				</Sheet.Body>
				{@render closeFooter()}
			</Sheet.Content>
		</Sheet.Root>
		{#if printAction}<Button
				variant="outline"
				size="cta-sm"
				class="min-h-11"
				onclick={printAction}
				disabled={printDisabled}
				title={printNote}
				aria-describedby={printNote ? printNoteId : undefined}>{fr ? 'Imprimer' : 'Print'}</Button
			>{#if printNote}<span id={printNoteId} class="sr-only">{printNote}</span>{/if}{/if}
	</div>
{/key}
