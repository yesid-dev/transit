export function mapLayerFor(params: URLSearchParams): 'live' | 'stops' | 'corridors' {
	const layer = params.get('mapLayer');
	if (layer === 'stops' || layer === 'corridors') return layer;
	if (layer === null && params.get('frameMode') === 'record') return 'stops';
	return 'live';
}
