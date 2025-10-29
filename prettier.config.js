export default {
	useTabs: true,
	singleQuote: true,
	trailingComma: 'none',
	printWidth: 100,
	importOrder: ['<THIRD_PARTY_MODULES>', '^./utils/(.*)$', '^./(?!types)', '/types'],
	importOrderSeparation: true,
	importOrderSortSpecifiers: true,
	overrides: [
		{
			files: ['*.ts', '*.css']
		}
	]
};
