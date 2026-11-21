/* Sh+N — stage 1: app shell, theme, language, status, install and update flow.
   Text is always inserted as text nodes (never parsed as HTML), so user content can never inject markup. */
(function () {
  'use strict';

  var APP_VERSION = '0.1.0';
  var LANGS = [['uz', 'O‘zbekcha'], ['ru', 'Русский'], ['tg', 'Тоҷикӣ']];
  var THEMES = ['system', 'light', 'dark'];
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var state = {
    lang: 'uz', theme: 'system', route: 'home', first: true,
    storage: 'checking',            // checking | ok | fail
    persist: 'no',                  // yes | no | unsupported
    installEvent: null, installed: false,
    swReg: null, swSupported: 'serviceWorker' in navigator,
    updateReady: false, updateMsg: ''
  };

  /* ---------- helpers ---------- */
  function t(key) {
    var d = window.SHN_I18N;
    return (d[state.lang] && d[state.lang][key]) || d.uz[key] || key;
  }

  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  function svg(parts, cls) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    parts.forEach(function (p) {
      var e = document.createElementNS(SVG_NS, p[0]);
      Object.keys(p[1]).forEach(function (k) { e.setAttribute(k, p[1][k]); });
      s.appendChild(e);
    });
    return s;
  }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  /* ---------- theme & language ---------- */
  function applyTheme() {
    var root = document.documentElement;
    if (state.theme === 'light' || state.theme === 'dark') root.setAttribute('data-theme', state.theme);
    else root.removeAttribute('data-theme');
    var bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bg) meta.setAttribute('content', bg);
  }
  function applyLang() {
    document.documentElement.setAttribute('lang', state.lang);
    document.title = 'Sh+N';
  }
  function setLang(code) {
    state.lang = code; lsSet('shn.lang', code); applyLang();
    ShnDB.setSetting('lang', code).catch(function () {});
    render('lang-' + code);
  }
  function setTheme(name) {
    state.theme = name; lsSet('shn.theme', name); applyTheme();
    ShnDB.setSetting('theme', name).catch(function () {});
    render('theme-' + name);
  }
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (state.theme === 'system') applyTheme();
    });
  }

  /* ---------- install & update ---------- */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }
  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); state.installEvent = e; state.first = false; render();
  });
  window.addEventListener('appinstalled', function () {
    state.installEvent = null; state.installed = true; state.first = false; render();
  });
  function install() {
    var ev = state.installEvent;
    if (!ev) return;
    ev.prompt();
    ev.userChoice.then(function () { state.installEvent = null; render(); });
  }

  function registerWorker() {
    if (!state.swSupported) return;
    var hadController = !!navigator.serviceWorker.controller;
    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // Reload only after a deliberate update, never on the very first install.
      if (!hadController || reloading) return;
      reloading = true; location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      state.swReg = reg;
      if (reg.waiting && navigator.serviceWorker.controller) { state.updateReady = true; state.first = false; render(); }
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', function () {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            state.updateReady = true; state.updateMsg = ''; state.first = false; render();
          }
        });
      });
    }).catch(function () { state.swSupported = false; render(); });
  }
  function applyUpdate() {
    var reg = state.swReg;
    if (reg && reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
  function checkUpdate() {
    var reg = state.swReg;
    if (!reg) return;
    reg.update().then(function () {
      if (reg.waiting) state.updateReady = true;
      else if (reg.installing) state.updateMsg = 'update.loading';
      else state.updateMsg = 'update.latest';
      render('btn-check');
    }).catch(function () { state.updateMsg = 'update.latest'; render('btn-check'); });
  }

  /* ---------- views ---------- */
  function greeting() {
    var hr = new Date().getHours();
    if (hr >= 5 && hr < 12) return t('greet.morning');
    if (hr >= 12 && hr < 18) return t('greet.day');
    if (hr >= 18 && hr < 23) return t('greet.evening');
    return t('greet.night');
  }

  function statusRow(label, valueKey, level) {
    return h('div', { class: 'row' },
      h('dt', {}, label),
      h('dd', {}, h('span', { class: 'dot ' + level, 'aria-hidden': 'true' }), t(valueKey)));
  }

  function statusRows() {
    var storageKey = 'status.storage.' + state.storage;
    var storageLevel = state.storage === 'ok' ? 'ok' : (state.storage === 'fail' ? 'warn' : '');
    var persistLevel = state.persist === 'yes' ? 'ok' : 'warn';
    var online = navigator.onLine;
    return [
      statusRow(t('status.storage'), storageKey, storageLevel),
      statusRow(t('status.network'), online ? 'status.network.online' : 'status.network.offline', online ? 'ok' : 'warn'),
      statusRow(t('status.persist'), 'status.persist.' + state.persist, state.persist === 'unsupported' ? 'warn' : persistLevel),
      h('div', { class: 'row' }, h('dt', {}, t('status.version')), h('dd', {}, APP_VERSION))
    ];
  }
  /* Update only the status list so the page (and its one-time intro animation) is not rebuilt. */
  function refreshStatus() {
    var el = document.getElementById('status-rows');
    if (state.route === 'home' && el) el.replaceChildren.apply(el, statusRows());
    else render();
  }

  function homeView() {
    return [
      h('p', { class: 'brand', 'aria-label': 'Sh+N' }, 'Sh', h('span', { class: 'plus' }, '+'), 'N'),
      h('section', { class: 'hero' },
        h('p', { class: 'greet' }, greeting()),
        h('h1', { class: 'slogan', tabindex: '-1', id: 'page-title' },
          h('span', {}, 'Your Life.'),
          h('span', {}, 'Your Memories.'),
          h('span', { class: 'last' }, 'Your Secret.', h('span', { class: 'seal', 'aria-hidden': 'true' }, '+'))),
        h('p', { class: 'lead' }, t('home.lead'))),
      h('section', { 'aria-labelledby': 'st-title' },
        h('h2', { id: 'st-title' }, t('status.title')),
        h('dl', { class: 'rows', id: 'status-rows' }, statusRows()))
    ];
  }

  function choice(id, label, checked, onclick) {
    return h('button', { type: 'button', role: 'radio', 'aria-checked': checked ? 'true' : 'false', id: id, class: 'choice', onclick: onclick },
      h('span', {}, label),
      checked ? svg([['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]], 'check') : null);
  }

  function installBlock() {
    if (state.installed || isStandalone()) return h('p', { class: 'note' }, t('install.done'));
    if (state.installEvent) return h('button', { type: 'button', class: 'btn', id: 'btn-install', onclick: install }, t('install.button'));
    return h('p', { class: 'note' }, isIOS() ? t('install.ios') : t('install.menu'));
  }

  function updateBlock() {
    if (!state.swSupported) return h('p', { class: 'note' }, t('update.unsupported'));
    return h('div', {},
      state.updateReady
        ? h('button', { type: 'button', class: 'btn', id: 'btn-apply', onclick: applyUpdate }, t('update.apply'))
        : h('button', { type: 'button', class: 'btn quiet', id: 'btn-check', onclick: checkUpdate }, t('update.check')),
      state.updateMsg && !state.updateReady ? h('p', { class: 'note', role: 'status' }, t(state.updateMsg)) : null);
  }

  function settingsView() {
    return [
      h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, t('settings.title')),
      state.storage === 'fail' ? h('p', { class: 'note', role: 'alert' }, t('error.storage')) : null,
      h('section', { class: 'group', 'aria-labelledby': 'g-lang' },
        h('h2', { id: 'g-lang' }, t('settings.language')),
        h('div', { class: 'choices', role: 'radiogroup', 'aria-labelledby': 'g-lang' },
          LANGS.map(function (l) { return choice('lang-' + l[0], l[1], state.lang === l[0], function () { setLang(l[0]); }); }))),
      h('section', { class: 'group', 'aria-labelledby': 'g-theme' },
        h('h2', { id: 'g-theme' }, t('settings.theme')),
        h('div', { class: 'choices inline', role: 'radiogroup', 'aria-labelledby': 'g-theme' },
          THEMES.map(function (n) {
            return h('button', { type: 'button', role: 'radio', id: 'theme-' + n, class: 'choice',
              'aria-checked': state.theme === n ? 'true' : 'false', onclick: function () { setTheme(n); } }, t('theme.' + n));
          }))),
      h('section', { class: 'group', 'aria-labelledby': 'g-app' },
        h('h2', { id: 'g-app' }, t('settings.app')),
        installBlock(),
        h('div', { class: 'group-gap' }, updateBlock())),
      h('section', { class: 'group', 'aria-labelledby': 'g-about' },
        h('h2', { id: 'g-about' }, t('settings.about')),
        h('p', { class: 'about' }, t('about.text')))
    ];
  }

  function navView() {
    function link(route, label, icon) {
      return h('a', { href: '#' + route, 'aria-current': state.route === route ? 'page' : null }, icon, h('span', {}, label));
    }
    return h('nav', { class: 'nav', 'aria-label': 'Sh+N' },
      h('div', { class: 'nav-inner' },
        link('home', t('nav.home'), svg([['path', { d: 'M3.5 11L12 3.5 20.5 11V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z' }]])),
        link('settings', t('nav.settings'), svg([
          ['path', { d: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1' }],
          ['circle', { cx: '15', cy: '6', r: '2' }], ['circle', { cx: '9', cy: '12', r: '2' }], ['circle', { cx: '17', cy: '18', r: '2' }]]))));
  }

  /* ---------- render & routing ---------- */
  var root = document.getElementById('app');
  function render(focusId) {
    var view = state.route === 'settings' ? settingsView() : homeView();
    var kids = [];
    if (state.updateReady && state.route !== 'settings') {
      kids.push(h('div', { class: 'banner', role: 'status' }, h('span', {}, t('update.ready')),
        h('button', { type: 'button', class: 'btn', onclick: applyUpdate }, t('update.apply'))));
    }
    kids.push(h('main', { id: 'main' }, view), navView());
    root.replaceChildren.apply(root, kids);
    root.classList.toggle('intro', state.first && state.route === 'home');
    if (focusId) {
      var el = document.getElementById(focusId);
      if (el) el.focus();
    }
  }
  function route() {
    var r = (location.hash || '#home').slice(1);
    var changed = r !== state.route;
    state.route = (r === 'settings') ? 'settings' : 'home';
    if (changed) state.first = false;
    render(changed ? 'page-title' : null);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('online', refreshStatus);
  window.addEventListener('offline', refreshStatus);

  /* ---------- start ---------- */
  function start() {
    var hash = (location.hash || '#home').slice(1);
    state.route = hash === 'settings' ? 'settings' : 'home';
    applyLang(); applyTheme(); render();

    ShnDB.open()
      .then(function () {
        return Promise.all([ShnDB.getSetting('lang', null), ShnDB.getSetting('theme', null), ShnDB.health()]);
      })
      .then(function (r) {
        var changed = false;
        if (r[0] && window.SHN_I18N[r[0]] && r[0] !== state.lang) { state.lang = r[0]; lsSet('shn.lang', r[0]); changed = true; }
        if (r[1] && THEMES.indexOf(r[1]) !== -1 && r[1] !== state.theme) { state.theme = r[1]; lsSet('shn.theme', r[1]); changed = true; }
        state.storage = 'ok';
        if (changed) { state.first = false; applyLang(); applyTheme(); render(); } else refreshStatus();
        return requestPersistence();
      })
      .catch(function () { state.storage = 'fail'; refreshStatus(); });

    registerWorker();
  }

  function requestPersistence() {
    if (!(navigator.storage && navigator.storage.persist)) { state.persist = 'unsupported'; refreshStatus(); return; }
    return navigator.storage.persisted().then(function (p) {
      return p ? true : navigator.storage.persist();
    }).then(function (granted) {
      state.persist = granted ? 'yes' : 'no'; refreshStatus();
    }).catch(function () { state.persist = 'unsupported'; refreshStatus(); });
  }

  // Pick the saved language before first paint from the boot.js mirror.
  try {
    var l = localStorage.getItem('shn.lang'); var th = localStorage.getItem('shn.theme');
    if (l && window.SHN_I18N[l]) state.lang = l;
    if (th && THEMES.indexOf(th) !== -1) state.theme = th;
  } catch (e) { /* ignore */ }
  start();
})();
