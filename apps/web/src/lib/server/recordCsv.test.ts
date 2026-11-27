import { expect, it } from 'vitest';
import { appendCsvColumn } from './recordCsv.ts';

async function transform(
	chunks: string[],
	header = 'Data source and licence',
	value = 'STM open data, CC BY 4.0, computed by Transit',
) {
	const encoder = new TextEncoder();
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(source.pipeThrough(appendCsvColumn(header, value))).text();
}

const cell = '"STM open data, CC BY 4.0, computed by Transit"';

it('adds the source column to the header and to every row', async () => {
	expect(await transform(['Measure,Value\npoll_success,2026-11-11\n'])).toBe(
		`Measure,Value,Data source and licence\npoll_success,2026-11-11,${cell}\n`,
	);
});

it('keeps a quoted line break inside a field and the file’s CRLF endings', async () => {
	const csv = 'Notice,Text\r\n1,"Detour\r\nvia ""Main"", then back"\r\n2,Plain\r\n';
	expect(await transform([csv])).toBe(
		`Notice,Text,Data source and licence\r\n1,"Detour\r\nvia ""Main"", then back",${cell}\r\n2,Plain,${cell}\r\n`,
	);
});

it('reads records across chunk boundaries, even inside a CRLF or a quote', async () => {
	expect(await transform(['Line,Na', 'me\r', '\n51,"Édouard', '-Montpetit"\r', '\n'])).toBe(
		`Line,Name,Data source and licence\r\n51,"Édouard-Montpetit",${cell}\r\n`,
	);
});

it('ends the last row even without a final line break, and adds nothing to an empty file', async () => {
	expect(await transform(['Measure\npunctuality'])).toBe(
		`Measure,Data source and licence\npunctuality,${cell}`,
	);
	expect(await transform([])).toBe('');
});
