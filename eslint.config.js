const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
];
