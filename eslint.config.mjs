import globals from 'globals';
export default [
  {
    files: ['src/main/**/*.js', 'bin/**/*.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024, sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-undef': 'error',
      // catch (_) は「握りつぶすことが意図」の慣用句なので対象外にする
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-cond-assign': 'error',
      'no-constant-condition': 'error',
      'no-fallthrough': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-shadow-restricted-names': 'error',
      'no-sparse-arrays': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-async-promise-executor': 'error',
      'require-atomic-updates': 'warn',
      'no-prototype-builtins': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.js', 'src/preload/**/*.js', 'src/shared/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024, sourceType: 'script',
      globals: { ...globals.browser, ...globals.node, module: 'writable', require: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
      // catch (_) は「握りつぶすことが意図」の慣用句なので対象外にする
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-cond-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
