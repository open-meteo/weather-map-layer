import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

export default defineConfig([
	globalIgnores(['node_modules', 'dist', 'coverage', '.vscode', '.gitignore']),
	...ts.configs.recommended,
	prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				projectService: {
					allowDefaultProject: ['*.js', '*.ts', 'scripts/*.ts']
				},
				ecmaVersion: 'latest',
				sourceType: 'module'
			}
		},
		files: ['**/*.{js,ts,mjs,cjs}']
	},
	{
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					args: 'all',
					argsIgnorePattern: '^_',
					caughtErrors: 'all',
					caughtErrorsIgnorePattern: '^_',
					destructuredArrayIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					ignoreRestSiblings: true
				}
			]
		}
	}
]);
