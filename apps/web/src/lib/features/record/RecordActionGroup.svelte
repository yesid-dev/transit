<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import * as Sheet from '@yesid/ui/sheet';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import CopyAction from '#lib/features/hotspots/sections/CopyAction.svelte';

	let {
		locale,
		href,
		files,
		citation,
	}: {
		locale: Locale;
		href: string;
		files: readonly { href?: string; label: string; columns?: readonly string[] }[];
		citation: Snippet;
	} = $props();
	const fr = $derived(locale === 'fr');
</script>

{#key href}
	<div
		class="flex min-w-0 flex-wrap items-start gap-2"
		role="group"
		aria-label={fr ? 'Actions du bilan' : 'Record actions'}
	>
		<CopyAction
			text={href}
			label={fr ? 'Copier le lien' : 'Copy link'}
			done={fr ? 'Lien copié.' : 'Link copied.'}
			fallback={fr ? 'Copiez le lien ci-dessous.' : 'Copy the link below.'}
			fallbackLabel={fr ? 'Lien vers cette vue' : 'Link to this view'}
		/>
		<Sheet.Root>
			<Sheet.Trigger>
				{#snippet child({ props })}<Button {...props} variant="outline" size="sm" class="min-h-11"
						>{fr ? 'Télécharger' : 'Download'}</Button
					>{/snippet}
			</Sheet.Trigger>
			<Sheet.Content side="bottom" showCloseButton={false} class="max-h-[90dvh] overflow-y-auto">
				<Sheet.Title>{fr ? 'Télécharger les fichiers CSV' : 'Download the CSV files'}</Sheet.Title>
				<ul>
					{#each files as file, index (index)}
						<li class="min-w-0">
							{#if file.href}<a
									class="inline-flex min-h-11 items-center text-primary underline"
									href={file.href}
									download>{file.label}</a
								>{:else}<p>{file.label}</p>{/if}
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
				<Sheet.Close>
					{#snippet child({ props })}<Button {...props} variant="outline" size="sm" class="min-h-11"
							>{fr ? 'Fermer' : 'Close'}</Button
						>{/snippet}
				</Sheet.Close>
			</Sheet.Content>
		</Sheet.Root>
		<Sheet.Root>
			<Sheet.Trigger>
				{#snippet child({ props })}<Button {...props} variant="outline" size="sm" class="min-h-11"
						>{fr ? 'Citer' : 'Cite'}</Button
					>{/snippet}
			</Sheet.Trigger>
			<Sheet.Content side="bottom" showCloseButton={false} class="max-h-[90dvh] overflow-y-auto">
				<Sheet.Title>{fr ? 'Citer' : 'Cite'}</Sheet.Title>
				<div class="grid gap-2 wrap-break-word">{@render citation()}</div>
				<Sheet.Close>
					{#snippet child({ props })}<Button {...props} variant="outline" size="sm" class="min-h-11"
							>{fr ? 'Fermer' : 'Close'}</Button
						>{/snippet}
				</Sheet.Close>
			</Sheet.Content>
		</Sheet.Root>
	</div>
{/key}
