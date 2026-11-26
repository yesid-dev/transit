import * as env from '$app/env/public';

const DEFAULT_PROVIDER = 'stm';

export function v1Provider(url?: URL): string {
	const raw = url?.searchParams.get('provider') ?? env.PUBLIC_V1_PROVIDER ?? DEFAULT_PROVIDER;
	return /^[a-z0-9][a-z0-9_-]*$/.test(raw) ? raw : DEFAULT_PROVIDER;
}
