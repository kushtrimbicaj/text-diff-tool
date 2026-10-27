/*
 * bootstrap.js — a tiny classic (non-module) script loaded in <head>.
 *
 * 1. Applies the saved or system colour theme before first paint (no flash).
 * 2. Shows a helpful notice if the ES-module app fails to start, which is what
 *    happens when index.html is opened from file:// (browsers block module
 *    imports there) instead of being served over http(s).
 *
 * It lives in its own file, not inline, so the page's Content-Security-Policy
 * can forbid inline scripts.
 */
(function () {
  var STORAGE_KEY = 'text-diff-tool:theme';
  var root = document.documentElement;

  var theme = null;
  try {
    theme = window.localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    theme = null; // Storage blocked (private mode, strict settings): fall back to system.
  }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  root.setAttribute('data-theme', theme);

  window.addEventListener('load', function () {
    window.setTimeout(function () {
      if (root.getAttribute('data-app') === 'ready') return;
      var notice = document.getElementById('startup-error');
      if (!notice) return;
      notice.hidden = false;
      var detail = notice.querySelector('[data-startup-detail]');
      if (detail && window.location.protocol === 'file:') {
        detail.textContent =
          'This page was opened directly from a file. Browsers block JavaScript modules on file:// ' +
          'URLs. Serve the folder over HTTP instead, for example by running "python3 -m http.server" ' +
          'in the project folder and opening http://localhost:8000.';
      }
    }, 600);
  });
})();
