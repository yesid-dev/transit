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

	// A script that fails to load during a deploy belongs to the page's version; a fresh load gets a
	// consistent one. Reload once by itself; within a minute on the same address, offer the button.
	const reloadOnce = () => {
		const key = 'transit:load-failed-reload';
		try {
			const last = JSON.parse(sessionStorage.getItem(key) ?? 'null');
			if (last?.url === location.href && Date.now() - last.at < 60_000) return false;
			sessionStorage.setItem(key, JSON.stringify({ url: location.href, at: Date.now() }));
		} catch {
			return false;
		}
		location.reload();
		return true;
	};

	// Leaving the page aborts its pending loads, and some browsers report them as failures. Those
	// are not a broken page: reloading would cancel the reader's next page.
	let leaving = false;
	const leave = () => {
		leaving = true;
	};
	window.addEventListener('pagehide', leave);
	window.addEventListener('beforeunload', leave);
	window.addEventListener('pageshow', (event) => {
		if (event.persisted) leaving = false;
	});

	/** @param {string | undefined} url The app's own content-named file, or nothing. */
	const immutable = (url) => {
		try {
			const file = new URL(url ?? '', location.href);
			return file.origin === location.origin && file.pathname.startsWith('/_app/immutable/')
				? file.href
				: undefined;
		} catch {
			return undefined;
		}
	};

	const deployedVersionDiffers = async () => {
		try {
			const response = await fetch(versionUrl, { cache: 'no-store' });
			if (!response.ok) return false;
			const { version } = await response.json();
			return typeof version === 'string' && version !== decodeURIComponent(pageVersion);
		} catch {
			return false;
		}
	};

	/** @param {string | undefined} url */
	const fileIsGone = async (url) => {
		if (!url) return false;
		try {
			return (await fetch(url, { method: 'HEAD', cache: 'no-store' })).status === 404;
		} catch {
			return false;
		}
	};

	let checking = false;
	/** @param {string | undefined} url The file that failed, when the browser names it. */
	const loadFailed = async (url) => {
		if (leaving || checking) return;
		if (checked) {
			show(newer);
			return;
		}
		checking = true;
		try {
			// Reload only for a page that is really out of date: a newer deploy, or its file is gone.
			const newerVersion = await deployedVersionDiffers();
			const gone = !newerVersion && (await fileIsGone(url));
			if (leaving) return;
			checked = true;
			if ((newerVersion || gone) && reloadOnce()) return;
			show(newerVersion);
		} finally {
			checking = false;
		}
	};

	reload.addEventListener('click', () => location.reload());
	window.addEventListener('transit:new-version', () => show(true));
	window.addEventListener('vite:preloadError', (event) =>
		loadFailed(
			immutable(/** @type {any} */ (event).payload?.message?.match(/\S+\/_app\/\S+/)?.[0]),
		),
	);
	window.addEventListener('unhandledrejection', (event) => {
		const detail = event.reason?.message;
		if (
			typeof detail === 'string' &&
			/dynamically imported module|error loading module|importing a module script failed/iu.test(
				detail,
			)
		)
			void loadFailed(immutable(detail.match(/https?:\/\/\S+/)?.[0]));
	});
	window.addEventListener(
		'error',
		({ target }) => {
			const url = immutable(
				target instanceof HTMLScriptElement
					? target.src
					: target instanceof HTMLLinkElement && target.rel === 'modulepreload'
						? target.href
						: undefined,
			);
			if (url) void loadFailed(url);
		},
		true,
	);
})();
