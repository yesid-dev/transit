<script lang="ts">
	import { PageSections, type PageSectionsProps } from '@yesid/ui/layout';

	let { children, ...rest }: Omit<PageSectionsProps, 'divider'> = $props();
</script>

<!-- Place once inside Surface. RecordGroup owns each logical section of the screen. -->
<PageSections {...rest} divider="hand-drawn" data-record-screen>
	{@render children()}
</PageSections>
