// Lint config for the Time Attendance app.
//
// Purpose: catch the bug class that bit us on 2026-09-21 — `buildAttendancePrintView()` read
// `canLongDistTarget`, a const belonging to `renderAttendanceTable()`, and threw ReferenceError
// on every render. Nothing caught it because the app has no build step and no linter.
//
// So `no-undef` is the rule that matters here and is an error. Style rules are deliberately left
// off: this is a large existing codebase and a wall of formatting noise would bury real findings.
//
// The app ships as plain <script> files with no bundler, so every function and const at the top
// level of app.js is a real browser global shared across files. `globals.browser` plus the
// third-party libraries loaded from index.html cover the rest.

const globals = require('globals');

const thirdParty = {
  flatpickr: 'readonly',     // cdn: flatpickr 4.6.13
  maplibregl: 'readonly',    // cdn: maplibre-gl 4.7.1
  L: 'writable',             // legacy Leaflet global; also the app's own L(en, th) i18n helper
  Chart: 'readonly',
  XLSX: 'readonly',
  html2canvas: 'readonly',
  jspdf: 'readonly',
};

module.exports = [
  {
    // Frontend: browser scripts, no modules, shared global scope across files.
    files: ['attendance/js/**/*.js', 'attendance/lang/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...thirdParty,
        LANG_JA: 'readonly',   // defined in lang/ja.js, consumed by app.js
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-cond-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-unsafe-negation': 'error',
      'no-unused-vars': 'off',   // too noisy on this codebase; revisit separately
    },
  },
  {
    // Service worker: its own global scope.
    files: ['attendance/sw.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: { 'no-undef': 'error', 'no-dupe-keys': 'error', 'no-unused-vars': 'off' },
  },
  {
    // Backend: plain CommonJS Node.
    files: ['attendance-server/backend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-cond-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-unsafe-negation': 'error',
      'no-unused-vars': 'off',
    },
  },
];
