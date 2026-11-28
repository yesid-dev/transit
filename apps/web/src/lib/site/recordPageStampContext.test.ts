import { expect, it } from 'vitest';
import { recordPrints } from './recordPageStampContext.ts';

const stamp = 'Record · 20 to 26 Nov 2026';
const at = (path: string) => new URL(path, 'https://transit.example');

it.each([
	['a report reached by a bare link', at('/network?provider=stm'), stamp, true],
	['a French report reached by a bare link', at('/fr/status'), stamp, true],
	['the Overview', at('/'), stamp, true],
	['a report in Live view', at('/alerts?frameMode=live'), undefined, false],
	['another Record page by a bare link', at('/stops'), stamp, false],
	['any page whose address names the Record frame', at('/stops?frameMode=record'), stamp, true],
] as const)('offers Print on %s: %s', (_, url, recordStamp, prints) => {
	expect(recordPrints(url, recordStamp)).toBe(prints);
});
