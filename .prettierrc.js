module.exports = {
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  proseWrap: 'never',
  endOfLine: 'lf',
  plugins: ['prettier-plugin-organize-imports'],
  overrides: [
    {
      files: '.prettierrc',
      options: {
        parser: 'json',
      },
    },
    {
      files: 'ai/**/*.yaml',
      options: {
        parser: 'json',
      },
    },
  ],
};
