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
	sha: '468aac8d7baf6838f1c14bfe3c8dda7abad4a7ca',
	tree: 'eadd041133808d4bf17e4453a5f9dad0bc1c65b4',
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
