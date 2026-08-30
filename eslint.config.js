import js from '@eslint/js';
import globals from 'globals';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  { ignores: ['node_modules/', 'coverage/', 'dist/', 'package-lock.json'] },
  js.configs.recommended,
  prettierRecommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
