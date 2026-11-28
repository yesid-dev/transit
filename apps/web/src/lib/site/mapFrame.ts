export type RecordMapLayer = 'live' | 'stops' | 'corridors' | 'clear-run' | 'waits';

export function isReadingsLayer(layer: string | null): layer is 'clear-run' | 'waits' {
	return layer === 'clear-run' || layer === 'waits';
}

export function mapLayerFor(params: Pick<URLSearchParams, 'get'>): RecordMapLayer {
	const layer = params.get('mapLayer');
	if (layer === 'stops' || layer === 'corridors' || layer === 'clear-run' || layer === 'waits')
		return layer;
	if (layer === null && params.get('frameMode') === 'record') return 'stops';
	return 'live';
}
