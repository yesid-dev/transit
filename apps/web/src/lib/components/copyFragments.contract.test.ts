import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { reliabilityCopy } from '../features/lines/reliability/reliability.copy';
import { metricsCopy } from '../features/metrics/metrics.copy';
import { networkReliabilityCopy } from '../features/network/reliability/network-reliability.copy';
import * as layout from './layout';
import * as surface from './surface';

const FRAGMENTS = {
	article: {
		metricsFr: metricsCopy.fr.article,
		metricsEn: metricsCopy.en.article,
		networkFr: networkReliabilityCopy.fr.article,
		networkEn: networkReliabilityCopy.en.article,
	},
	history: {
		lineFr: reliabilityCopy.fr.history.navigator,
		lineEn: reliabilityCopy.en.history.navigator,
		networkFr: networkReliabilityCopy.fr.history.navigator,
		networkEn: networkReliabilityCopy.en.history.navigator,
	},
} as const;

function serialize(value: unknown): string {
	if (typeof value === 'function') {
		return `function(${value.length}):${Function.prototype.toString.call(value)}`;
	}
	if (Array.isArray(value)) return `array:[${value.map(serialize).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		return `object:{${Object.entries(value)
			.map(([key, item]) => `${JSON.stringify(key)}:${serialize(item)}`)
			.join(',')}}`;
	}
	return `${typeof value}:${JSON.stringify(value)}`;
}

function fingerprints(fragments: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(fragments).map(([key, value]) => [
			key,
			createHash('sha256').update(serialize(value)).digest('hex'),
		]),
	);
}

describe('shared copy fragment characterization', () => {
	test('exports each fragment builder beside its component owner', () => {
		expect(layout).toHaveProperty('articleCopy');
		expect(surface).toHaveProperty('historyCopy');
	});

	test('locks HistoryNavigator copy values, functions, shapes, and key order', () => {
		expect(fingerprints(FRAGMENTS.history)).toEqual({
			lineEn: '1f052828d1622166f5fa4bc7c5acbbfb050987ba2e3b42df24a0c520e4110e6a',
			lineFr: '6238ee96f5bdf9762200f746035319845b95edb9886ad27f582e1869f096ed26',
			networkEn: 'bc3092953ff1688e88af70b87f9623a2bf5ef7c0fd45c8a2057621dc50131aee',
			networkFr: 'd9f6f2afaa567e7c96a479c94101616197d2b72e3080b881534b0cb16e320ed2',
		});
	});
});
