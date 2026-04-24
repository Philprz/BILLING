module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
    browser: false,
  },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    'no-console': 'off',
  },
  overrides: [
    {
      files: ['apps/web/**/*.{ts,tsx}'],
      env: {
        browser: true,
        node: false,
      },
      extends: [
        'eslint:recommended',
        'plugin:@typescript-eslint/recommended',
      ],
    },
  ],
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', '*.js', '*.mjs'],
};
