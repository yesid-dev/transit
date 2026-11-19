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
	sha: 'c9fba120aee1e8d4e1b5ea0952d91dcb413598ac',
	tree: '363279723c988bf45583bec4aaa7865df77b5cad',
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
