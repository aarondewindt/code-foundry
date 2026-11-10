import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.yarn/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
];
