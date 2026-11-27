(() => {
	const notice = document.getElementById('app-reload-notice');
	const message = notice?.querySelector('[data-reload-message]');
	const reload = notice?.querySelector('button');
	if (!notice || !message || !reload) return;
	const { version: pageVersion, versionUrl } = notice.dataset;
	if (!pageVersion || !versionUrl) return;

	let newer = false;
	let checked = false;
	/** @param {boolean} hasNewVersion */
	const show = (hasNewVersion) => {
		newer ||= hasNewVersion;
		const french = document.documentElement.lang === 'fr';
		message.textContent = newer
			? french
				? 'Une nouvelle version est disponible.'
				: 'A newer version is available.'
			: french
				? 'Cette page n’a pas pu se charger.'
				: 'This page could not load.';
		reload.textContent = french ? 'Recharger' : 'Reload';
		notice.hidden = false;
	};

	const loadFailed = async () => {
		show(false);
		if (checked || newer) return;
		checked = true;
		try {
			const response = await fetch(versionUrl, { cache: 'no-store' });
			if (!response.ok) return;
			const { version } = await response.json();
			if (typeof version === 'string' && version !== decodeURIComponent(pageVersion)) show(true);
		} catch {
			// Keep the generic reload action when the deployed version cannot be checked.
		}
	};

	reload.addEventListener('click', () => location.reload());
	window.addEventListener('transit:new-version', () => show(true));
	window.addEventListener('vite:preloadError', loadFailed);
	window.addEventListener('unhandledrejection', (event) => {
		const detail = event.reason?.message;
		if (
			typeof detail === 'string' &&
			/dynamically imported module|error loading module|importing a module script failed/iu.test(
				detail,
			)
		)
			void loadFailed();
	});
	window.addEventListener(
		'error',
		({ target }) => {
			const url =
				target instanceof HTMLScriptElement
					? target.src
					: target instanceof HTMLLinkElement && target.rel === 'modulepreload'
						? target.href
						: '';
			if (url.includes('/_app/immutable/')) void loadFailed();
		},
		true,
	);
})();
