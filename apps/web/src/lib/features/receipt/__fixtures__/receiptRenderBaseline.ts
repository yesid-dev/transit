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
	sha: '19821f8efd699fe89d1bbcb7ad776e72ff6b4cb2',
	tree: '4fe966a60ab2a745884c8f8e348c8cca95d96a14',
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
