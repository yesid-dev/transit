<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import type { CsvDownload } from '../recordCsv';
	import type { ReliabilityCopy } from '../reliability.copy';
	let { file, label, copy }: { file: CsvDownload | null; label: string; copy: ReliabilityCopy } =
		$props();
</script>

{#if file}
	<div class="csv-download">
		<Button
			variant="outline"
			size="sm"
			class="min-h-11 max-w-full whitespace-normal"
			href={file.href}
			download={file.filename}
			aria-label={copy.csv.context(label)}
			data-slot="record-csv">{copy.csv.displayed}</Button
		>
	</div>
{/if}

<style>
	.csv-download {
		display: flex;
		min-width: 0;
	}
</style>
