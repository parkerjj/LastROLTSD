import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { globalIgnores } from 'eslint/config';

export default tseslint.config(globalIgnores(['**/dist/**', 'node_modules/**', '.wrangler/**', '**/*.tsbuildinfo']), eslint.configs.recommended, ...tseslint.configs.recommended, {
  rules: {
    'no-undef': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': 'off',
    '@typescript-eslint/no-empty-object-type': 'off',
  },
});
