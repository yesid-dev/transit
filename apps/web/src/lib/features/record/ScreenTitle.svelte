<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';

	let {
		title,
		subtitle,
		plate,
		back,
	}: {
		title: string;
		subtitle?: string;
		plate?: string;
		back?: { href: string; label: string };
	} = $props();
</script>

<header class="flex min-w-0 flex-wrap items-start justify-between gap-3">
	<hgroup class="min-w-0">
		<h1 class="flex flex-wrap items-center gap-2 wrap-break-word">
			{#if plate}<RoutePlate code={plate} size="lg" />{/if}
			{title}
		</h1>
		{#if subtitle}<p class="text-muted-foreground">{subtitle}</p>{/if}
	</hgroup>
	{#if back}<a class="record-link" href={back.href}>{back.label}</a>{/if}
</header>

<style>
	.record-link {
		display: inline-flex;
		align-items: center;
		min-block-size: 44px;
		color: var(--primary);
		text-decoration: underline;
	}
</style>
