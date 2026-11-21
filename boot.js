/* Sh+N boot — runs before first paint so the saved theme/language apply without a flash.
   Only non-sensitive UI preferences are mirrored in localStorage. Everything else lives in IndexedDB. */
(function () {
  try {
    var theme = localStorage.getItem('shn.theme');
    var lang = localStorage.getItem('shn.lang');
    var root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    if (lang === 'uz' || lang === 'ru' || lang === 'tg') root.setAttribute('lang', lang);
  } catch (e) { /* storage blocked: defaults apply */ }
})();
