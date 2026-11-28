import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/** Flat config / SvelteKit 3 / Svelte 5 (runes) / TypeScript. */
export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs['flat/recommended'],
	prettier,
	...svelte.configs['flat/prettier'],
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
		},
		rules: {
			// Allow intentional throwaways with a leading underscore.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
			],
			'@typescript-eslint/no-explicit-any': 'warn',
			// Internal navigation is centralized: i18n paths go through
			// $lib/i18n localizeHref() and the $lib/nav intent layer; ui/button
			// is a generic primitive accepting arbitrary (incl. external) hrefs.
			// resolve() does not fit computed i18n hrefs, so this rule is off.
			'svelte/no-navigation-without-resolve': 'off',
		},
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts'],
		languageOptions: {
			parserOptions: { parser: ts.parser },
		},
	},
	{
		// The v1 index re-exports every published file schema. A value read through it makes the
		// browser build all of them before the live map can start (about 300 ms of a 4x-throttled
		// phone's first visit); a type costs nothing. Import a schema from the module that defines it.
		files: ['src/**/*.ts', 'src/**/*.svelte'],
		ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'src/tests/**'],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				...['#lib/v1/schemas/index.ts', '#lib/v1/schemas', '#lib/v1/index.ts', '#lib/v1'].map(
					(name) => ({
						name,
						allowTypeImports: true,
						message: 'Import values from the module that defines them; this index is for types.',
					}),
				),
			],
		},
	},
	{
		ignores: [
			'.svelte-kit/',
			'.vitest/',
			'build/',
			'dist/',
			'node_modules/',
			'**/.wrangler/',
			'src/lib/v1/schemas/json/',
			'src/lib/v1/schemas/generated/',
			'.scratch-s1/',
			'vendor/',
		],
	},
);
