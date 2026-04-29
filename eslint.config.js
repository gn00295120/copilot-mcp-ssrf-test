import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
];
