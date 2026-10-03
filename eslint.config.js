import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '**/target/**', '**/build/**', 'apps/desktop/src-tauri/gen/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { console: 'readonly' } } },
  { files: ['scripts/**/*.mjs'], languageOptions: { globals: {
    process: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', setTimeout: 'readonly',
  } } },
);
