import { join } from 'node:path';
import {
	baselineInventory,
	renderedBaseline,
	type CaptureConfiguration,
} from '../../network/reliability/sections/__fixtures__/renderedBaseline';
export { captureEnvironment } from '../../network/reliability/sections/__fixtures__/renderedBaseline';

const inventory = [
	'receipt-headline',
	'receipt-affected',
	'receipt-worst',
	'receipt-time-of-day',
	'receipt-state-cuts',
	'receipt-not-reported',
	'observation-copy',
];
const config: CaptureConfiguration = {
	sha: '39f3544ebe23387e6ffa3ec21c20e311ff064ea3',
	tree: '5a8b8015e3f41b6edb18006049dd1d3e9884e000',
	snapshot: join(
		process.cwd(),
		'src/lib/features/receipt/__fixtures__/receipt-render-baseline.jsonl',
	),
	modeEnvironment: 'RECEIPT_RENDER_MODE',
	artifactsEnvironment: 'RECEIPT_RENDER_ARTIFACTS',
	inventory,
	selector: inventory.map((name) => `[data-slot="${name}"]`).join(','),
	identity: 'data-slot',
};
export const receiptBaseline = (key: string, container: HTMLElement) =>
	renderedBaseline(key, container, config);
export const receiptInventory = (prefix: string, keys: string[]) =>
	baselineInventory(prefix, keys, config);
