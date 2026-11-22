/* Sh+N — stage 1: app shell, theme, language, status, install and update flow.
   Text is always inserted as text nodes (never parsed as HTML), so user content can never inject markup. */
(function () {
  'use strict';

  var APP_VERSION = '0.4.0';
  var LANGS = [['uz', 'O‘zbekcha'], ['ru', 'Русский'], ['tg', 'Тоҷикӣ']];
  var THEMES = ['system', 'light', 'dark'];
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var state = {
    lang: 'uz', theme: 'system', route: 'home', first: true,
    vault: 'checking',              // checking | none | locked | open | error
    cal: null, entries: { q: '', filter: 'all', cat: '' }, editing: null, dirty: false, saveTimer: 0,
    vaultData: null, dek: null, setup: null, usePw: false, recoverMode: false, hiddenAt: 0,
    storage: 'checking',            // checking | ok | fail
    persist: 'no',                  // yes | no | unsupported
    installEvent: null, installed: false,
    // Inside the Android APK (Capacitor) files are bundled, so no service worker / install / browser-update UI.
    native: !!window.Capacitor,
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
    if (state.native || !state.swSupported) return;
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
      state.native ? null : statusRow(t('status.persist'), 'status.persist.' + state.persist, state.persist === 'unsupported' ? 'warn' : persistLevel),
      h('div', { class: 'row' }, h('dt', {}, t('status.entries')), h('dd', {}, String(ShnEntries.counts().all))),
      statusRow(t('status.vault'), 'status.vault.open', 'ok'),
      h('div', { class: 'row' }, h('dt', {}, t('status.version')), h('dd', {}, APP_VERSION))
    ];
  }
  /* Update only the status list so the page (and its one-time intro animation) is not rebuilt. */
  function refreshStatus() {
    var el = document.getElementById('status-rows');
    if (state.route === 'settings' && el) el.replaceChildren.apply(el, statusRows());
    else if (state.vault === 'open') render();
  }

  function choice(id, label, checked, onclick) {
    return h('button', { type: 'button', role: 'radio', 'aria-checked': checked ? 'true' : 'false', id: id, class: 'choice', onclick: onclick },
      h('span', {}, label),
      checked ? svg([['path', { d: 'M5 12.5l4.5 4.5L19 7.5' }]], 'check') : null);
  }

  function installBlock() {
    if (state.native) return null;
    if (state.installed || isStandalone()) return h('p', { class: 'note' }, t('install.done'));
    if (state.installEvent) return h('button', { type: 'button', class: 'btn', id: 'btn-install', onclick: install }, t('install.button'));
    return h('p', { class: 'note' }, isIOS() ? t('install.ios') : t('install.menu'));
  }

  function updateBlock() {
    if (state.native) return null;
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
      state.native ? null : h('section', { class: 'group', 'aria-labelledby': 'g-app' },
        h('h2', { id: 'g-app' }, t('settings.app')),
        installBlock(),
        state.native ? null : h('div', { class: 'group-gap' }, updateBlock())),
      h('section', { class: 'group', 'aria-labelledby': 'g-status' },
        h('h2', { id: 'g-status' }, t('status.title')),
        h('dl', { class: 'rows', id: 'status-rows' }, statusRows())),
      h('section', { class: 'group', 'aria-labelledby': 'g-about' },
        h('h2', { id: 'g-about' }, t('settings.about')),
        h('p', { class: 'about' }, t('about.text')))
    ];
  }

  function navView() {
    function link(route, label, icon) {
      return h('a', { href: '#' + route, 'aria-current': (state.route === route || (route === 'entries' && state.route === 'edit')) ? 'page' : null }, icon, h('span', {}, label));
    }
    return h('nav', { class: 'nav', 'aria-label': 'Sh+N' },
      h('div', { class: 'nav-inner' },
        link('home', t('nav.home'), svg([['path', { d: 'M3.5 11L12 3.5 20.5 11V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z' }]])),
        link('calendar', t('nav.calendar'), svg([['rect', { x: '4', y: '5', width: '16', height: '15', rx: '2' }], ['path', { d: 'M4 10h16M9 3v4M15 3v4' }]])),
        link('stats', t('nav.stats'), svg([['path', { d: 'M5 20V12M12 20V5M19 20v-9' }]])),
        link('entries', t('nav.entries'), svg([['path', { d: 'M6 4h10a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2z' }], ['path', { d: 'M9.5 9h5M9.5 13h5' }]])),
        link('settings', t('nav.settings'), svg([
          ['path', { d: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1' }],
          ['circle', { cx: '15', cy: '6', r: '2' }], ['circle', { cx: '9', cy: '12', r: '2' }], ['circle', { cx: '17', cy: '18', r: '2' }]]))));
  }



  /* ---------- mood, home, calendar, statistics ---------- */
  function monthNom() {   // MONTHS is declared further down, so resolve it lazily
    return state.lang === 'ru' ? 'январь февраль март апрель май июнь июль август сентябрь октябрь ноябрь декабрь'.split(' ') : MONTHS[state.lang];
  }
  var WEEKDAYS = { uz: 'Ya Du Se Ch Pa Ju Sh', ru: 'Вс Пн Вт Ср Чт Пт Сб', tg: 'Яш Дш Сш Чш Пш Ҷм Шн' };   // Sunday first (Date.getDay)
  var MOOD_MOUTH = ['M8 16q4-3.5 8 0', 'M8 15.5q4-1.5 8 0', 'M8.5 15h7', 'M8 14q4 3 8 0', 'M7.5 13.5q4.5 5 9 0'];
  function faceIcon(n) {
    return svg([['circle', { cx: '12', cy: '12', r: '9.5' }], ['path', { d: 'M9 10h.01M15 10h.01' }], ['path', { d: MOOD_MOUTH[n - 1] }]], 'face');
  }
  function moodRow(day, after) {
    var cur = ShnEntries.moodOf(day);
    return h('div', { class: 'moods', role: 'group', 'aria-label': t('mood.title') }, [1, 2, 3, 4, 5].map(function (n) {
      return h('button', { type: 'button', id: 'm-' + n, class: 'mood m' + n, 'aria-pressed': cur === n ? 'true' : 'false', onclick: function () {
        (cur === n ? ShnEntries.clearMood(day) : ShnEntries.setMood(day, n)).then(null, function () {});
        after('m-' + n);
      } }, faceIcon(n), h('span', {}, t('mood.' + n)));
    }));
  }
  function keyDate(key) { var p = key.split('-'); return new Date(+p[0], +p[1] - 1, +p[2], 12); }

  function homeView() {
    var today = ShnEntries.dayKey(Date.now()), st = ShnEntries.stats(), recent = ShnEntries.list({ filter: 'all', q: '', cat: '' }).slice(0, 3);
    return [
      h('div', { class: 'home-top' },
        h('p', { class: 'brand', 'aria-label': 'Sh+N' }, 'Sh', h('span', { class: 'plus' }, '+'), 'N'),
        h('button', { type: 'button', class: 'icon-btn', id: 'btn-lock', 'aria-label': t('lock.now'), onclick: lockNow },
          svg([['rect', { x: '5', y: '11', width: '14', height: '9', rx: '2' }], ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }]]))),
      h('p', { class: 'greet' }, greeting()),
      h('h1', { class: 'home-q', tabindex: '-1', id: 'page-title' }, t('home.q')),
      moodRow(today, function (id) { render(id); }),
      h('div', { class: 'top-actions' }, h('button', { type: 'button', class: 'btn', id: 'btn-new-home', onclick: function () { openEditor(null); } }, t('entries.new'))),
      st.streak ? h('p', { class: 'chip-line' }, t('home.streak').replace('{n}', st.streak)) : null,
      h('section', { 'aria-labelledby': 'rc-title' }, h('h2', { id: 'rc-title' }, t('home.recent')),
        recent.length ? h('div', { role: 'list' }, recent.map(entryButton)) : h('p', { class: 'note' }, t('entries.empty'))),
      h('p', { class: 'tagline' }, 'Your Life. Your Memories. Your Secret.')
    ];
  }

  function calendarView() {
    if (!state.cal) { var n = new Date(); state.cal = { y: n.getFullYear(), m: n.getMonth(), sel: ShnEntries.dayKey(n) }; }
    var c = state.cal, todayKey = ShnEntries.dayKey(Date.now());
    var lead = (new Date(c.y, c.m, 1).getDay() + 6) % 7, days = new Date(c.y, c.m + 1, 0).getDate();
    var prefix = c.y + '-' + ('0' + (c.m + 1)).slice(-2), counts = ShnEntries.entryDays(prefix), cells = [], i;
    for (i = 0; i < lead; i++) cells.push(h('span', { class: 'cal-blank' }));
    function dayCell(d) {
      var key = prefix + '-' + ('0' + d).slice(-2), lvl = ShnEntries.moodOf(key), cnt = counts[key] || 0;
      var label = d + ' ' + MONTHS[state.lang][c.m] + (lvl ? ', ' + t('mood.' + lvl) : '') + (cnt ? ', ' + t('cal.entries').replace('{n}', cnt) : '');
      return h('button', { type: 'button', class: 'cal-day' + (key === todayKey ? ' today' : ''), 'aria-pressed': c.sel === key ? 'true' : 'false', 'aria-label': label,
        onclick: function () { c.sel = key; render('cal-sel'); } },
        h('span', {}, d), lvl ? h('i', { class: 'cal-dot m' + lvl }) : null, cnt ? h('b', { class: 'cal-bar' }) : null);
    }
    for (i = 1; i <= days; i++) cells.push(dayCell(i));
    function shift(dm) {
      var d = new Date(c.y, c.m + dm, 1); c.y = d.getFullYear(); c.m = d.getMonth();
      var pre = c.y + '-' + ('0' + (c.m + 1)).slice(-2); c.sel = todayKey.indexOf(pre) === 0 ? todayKey : pre + '-01';
      render('cal-title');
    }
    var wd = WEEKDAYS[state.lang].split(' '), order = [1, 2, 3, 4, 5, 6, 0];
    var sel = c.sel, future = sel > todayKey, list = future ? [] : ShnEntries.entriesOn(sel);
    return [
      h('div', { class: 'cal-head' },
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '←', onclick: function () { shift(-1); } }, svg([['path', { d: 'M14.5 6l-6 6 6 6' }]])),
        h('h1', { class: 'cal-title', tabindex: '-1', id: 'cal-title' }, monthNom()[c.m] + ' ' + c.y),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': '→', onclick: function () { shift(1); } }, svg([['path', { d: 'M9.5 6l6 6-6 6' }]]))),
      h('div', { class: 'cal-grid cal-wd', 'aria-hidden': 'true' }, order.map(function (x) { return h('span', {}, wd[x]); })),
      h('div', { class: 'cal-grid' }, cells),
      h('section', { class: 'day-panel', 'aria-label': fmtDate(keyDate(sel).getTime()) },
        h('h2', { id: 'cal-sel', tabindex: '-1' }, fmtDate(keyDate(sel).getTime())),
        future ? h('p', { class: 'note' }, t('cal.future')) : [
          moodRow(sel, function (id) { render(id); }),
          list.length ? h('div', { role: 'list' }, list.map(entryButton)) : h('p', { class: 'note' }, t('cal.none')),
          h('button', { type: 'button', class: 'btn quiet', id: 'btn-new-day', onclick: function () {
            var e = ShnEntries.blank(); if (sel !== todayKey) e.created = keyDate(sel).getTime(); openEditor(e); } }, t('cal.new'))])
    ];
  }

  function tile(v, key) { return h('div', { class: 'tile' }, h('b', {}, String(v)), h('span', {}, t(key))); }
  function bar(cls, pct) { var b = h('span', { class: cls }); b.style.width = pct + '%'; return b; }
  function statsView() {
    var s = ShnEntries.stats(), wd = WEEKDAYS[state.lang].split(' '), max = Math.max.apply(null, s.dist.concat([1]));
    return [
      title('stats.title'),
      h('div', { class: 'tiles' }, tile(s.total, 'stats.total'), tile(s.month, 'stats.month'), tile(s.streak, 'stats.streak'), tile(s.best, 'stats.best')),
      h('section', { class: 'group', 'aria-labelledby': 's-week' }, h('h2', { id: 's-week' }, t('stats.week')),
        h('div', { class: 'wk' }, s.week.map(function (w) {
          return h('div', { class: 'wk-col' },
            h('div', { class: 'wk-track' }, h('span', { class: 'wk-bar ' + (w.level ? 'm' + w.level + ' h' + w.level : 'empty'), title: w.level ? t('mood.' + w.level) : '' })),
            h('span', { class: 'wk-day' }, wd[keyDate(w.day).getDay()]));
        }))),
      h('section', { class: 'group', 'aria-labelledby': 's-dist' }, h('h2', { id: 's-dist' }, t('stats.dist')),
        s.moodDays ? [h('div', {}, [5, 4, 3, 2, 1].map(function (n) {
          return h('div', { class: 'dist-row' }, h('span', { class: 'dist-l m' + n }, faceIcon(n), t('mood.' + n)),
            h('span', { class: 'dist-t' }, bar('dist-b m' + n, Math.round(s.dist[n - 1] / max * 100))), h('span', { class: 'dist-n' }, String(s.dist[n - 1])));
        })), h('p', { class: 'note' }, t('stats.avg') + ': ' + s.avg.toFixed(1) + ' / 5')] : h('p', { class: 'note' }, t('stats.none')))
    ];
  }

  /* ---------- vault: setup, lock, recovery ---------- */
  var AUTOLOCK_MS = 60000, MAX_PIN_FAILS = 5;
  function el(id) { return document.getElementById(id); }
  function setErr(key) { var e = el('err'); if (e) e.textContent = key ? t(key) : ''; }
  function brandEl() { return h('p', { class: 'brand', 'aria-label': 'Sh+N' }, 'Sh', h('span', { class: 'plus' }, '+'), 'N'); }
  function title(key) { return h('h1', { class: 'page-title', tabindex: '-1', id: 'page-title' }, t(key)); }
  function field(id, label, attrs) {
    return h('div', { class: 'field' }, h('label', { for: id }, label),
      h('input', Object.assign({ id: id, class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }, attrs || {})));
  }
  function primary(label, fn) { return h('button', { type: 'button', class: 'btn', 'data-label': label, onclick: fn }, label); }
  function linkBtn(label, fn) { return h('button', { type: 'button', class: 'link', onclick: fn }, label); }
  function busy(b, on) { b.disabled = on; b.textContent = on ? t('ui.busy') : b.getAttribute('data-label'); }
  function saveVault(v) { return ShnDB.setSetting('vault', v); }
  function openVault(dek) {
    ShnEntries.load(dek).then(function () {
      state.dek = dek; state.vault = 'open'; state.usePw = false; state.recoverMode = false; state.first = true;
      render('page-title');
    }).catch(function () { state.vault = 'error'; render(); });
  }
  function lockNow() {
    flushEditor().then(null, function () {}).then(function () {
      ShnEntries.clear(); state.dek = null; state.editing = null; state.dirty = false;
      if (state.route === 'edit') { state.route = 'entries'; history.replaceState(null, '', '#entries'); }
      state.entries = { q: '', filter: 'all', cat: '' }; state.cal = null;
      state.vault = 'locked'; state.usePw = false; state.recoverMode = false; render('page-title');
    });
  }
  function pickThree() {
    var out = [];
    while (out.length < 3) { var n = crypto.getRandomValues(new Uint8Array(1))[0] % 24; if (out.indexOf(n) === -1) out.push(n); }
    return out.sort(function (a, b) { return a - b; });
  }

  function gateView() {
    if (state.vault === 'none') return state.setup ? recoveryView() : setupView();
    if (state.vault === 'locked') return state.recoverMode ? recoverView() : lockView();
    if (state.vault === 'error') return [brandEl(), h('p', { class: 'error', role: 'alert' }, t('error.nostorage'))];
    return [brandEl()];
  }

  function setupView() {
    return [brandEl(), title('setup.title'), h('p', { class: 'lead' }, t('setup.lead')),
      field('pw', t('setup.pw'), { autocomplete: 'new-password' }),
      field('pw2', t('setup.again'), { autocomplete: 'new-password' }),
      field('pin', t('setup.pin'), { inputmode: 'numeric', maxlength: '4' }),
      h('p', { class: 'error', id: 'err', role: 'alert' }), primary(t('setup.create'), doSetup)];
  }
  function doSetup(ev) {
    var b = ev.currentTarget, pw = el('pw').value, pin = el('pin').value;
    if (pw.length < 8) return setErr('err.short');
    if (pw !== el('pw2').value) return setErr('err.mismatch');
    if (!/^\d{4}$/.test(pin)) return setErr('err.pin');
    setErr(''); busy(b, true);
    ShnCrypto.createVault(pw, pin).then(function (r) {
      state.setup = { vault: r.vault, dek: r.dek, words: r.words, idx: pickThree() };
      render('page-title');
    }).catch(function () { busy(b, false); setErr('err.generic'); });
  }

  function recoveryView() {
    var s = state.setup;
    return [brandEl(), title('rec.title'), h('p', { class: 'lead' }, t('rec.lead')),
      h('ol', { class: 'words' }, s.words.map(function (w, i) { return h('li', {}, h('span', { class: 'n' }, i + 1), w); })),
      h('p', { class: 'lead' }, t('rec.confirm')),
      s.idx.map(function (n, i) { return field('c' + i, t('rec.word').replace('{n}', n + 1), { type: 'text' }); }),
      h('p', { class: 'error', id: 'err', role: 'alert' }), primary(t('rec.done'), doConfirm)];
  }
  function doConfirm(ev) {
    var s = state.setup, b = ev.currentTarget;
    var ok = s.idx.every(function (n, i) { return el('c' + i).value.trim().toLowerCase() === s.words[n]; });
    if (!ok) return setErr('err.rec');
    busy(b, true);
    // The vault is saved only now, after the user proved they wrote the Recovery Key down.
    saveVault(s.vault).then(function () {
      state.vaultData = s.vault; state.setup = null; openVault(s.dek);
    }).catch(function () { busy(b, false); setErr('err.generic'); });
  }

  function lockView() {
    var v = state.vaultData, pinLocked = !!(v.pin && v.pin.fails >= MAX_PIN_FAILS);
    var usePin = !!v.pin && !pinLocked && !state.usePw;
    return [brandEl(), title('lock.title'),
      usePin ? field('pin', t('lock.pin'), { inputmode: 'numeric', maxlength: String(v.pin.len || 6), autocomplete: 'off', oninput: onPinInput })
             : field('pw', t('lock.pw'), { autocomplete: 'current-password' }),
      pinLocked ? h('p', { class: 'note' }, t('lock.pinlocked')) : null,
      h('p', { class: 'error', id: 'err', role: 'alert' }),
      primary(t('lock.unlock'), usePin ? doPin : doPw),
      usePin ? linkBtn(t('lock.usepw'), function () { state.usePw = true; render('pw'); }) : null,
      linkBtn(t('lock.forgot'), function () { state.recoverMode = true; render('page-title'); })];
  }
  function onPinInput(e) { if (e.target.value.length === (state.vaultData.pin.len || 6) && /^\d+$/.test(e.target.value)) doPin(); }
  function doPw(ev) {
    var b = ev && ev.currentTarget ? ev.currentTarget : null, v = state.vaultData;
    if (b) busy(b, true);
    ShnCrypto.unlockPassword(v, el('pw').value).then(function (dek) {
      if (v.pin && v.pin.fails) { v.pin.fails = 0; return saveVault(v).then(function () { openVault(dek); }); }
      openVault(dek);
    }).catch(function () { if (b) busy(b, false); setErr('lock.wrong'); });
  }
  var pinBusy = false;
  function doPin() {
    var v = state.vaultData, input = el('pin');
    if (pinBusy || !input || input.value.length !== (v.pin.len || 6) || !/^\d+$/.test(input.value) || v.pin.fails >= MAX_PIN_FAILS) return;
    pinBusy = true;
    ShnCrypto.unlockPin(v, input.value).then(function (dek) {
      if (v.pin.fails) { v.pin.fails = 0; return saveVault(v).then(function () { openVault(dek); }); }
      openVault(dek);
    }).catch(function () {
      v.pin.fails += 1;   // counted and saved BEFORE the answer, so closing the app does not reset it
      return saveVault(v).then(function () {
        if (v.pin.fails >= MAX_PIN_FAILS) render('pw'); else { input.value = ''; setErr('lock.pinwrong'); }
      });
    }).then(function () { pinBusy = false; }, function () { pinBusy = false; });
  }

  function recoverView() {
    return [brandEl(), title('recover.title'),
      h('div', { class: 'field' }, h('label', { for: 'words' }, t('recover.words')),
        h('textarea', { id: 'words', class: 'input', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })),
      field('npw', t('recover.newpw'), { autocomplete: 'new-password' }),
      h('p', { class: 'error', id: 'err', role: 'alert' }),
      primary(t('recover.go'), doRecover),
      linkBtn(t('ui.back'), function () { state.recoverMode = false; render('page-title'); })];
  }
  function doRecover(ev) {
    var b = ev.currentTarget, npw = el('npw').value;
    if (npw.length < 8) return setErr('err.short');
    setErr(''); busy(b, true);
    ShnCrypto.recover(state.vaultData, el('words').value, npw).then(function (r) {
      return saveVault(r.vault).then(function () { state.vaultData = r.vault; openVault(r.dek); });
    }).catch(function (e) {
      busy(b, false); setErr(e && e.message === 'checksum' ? 'err.checksum' : 'err.rec');
    });
  }

  // Lock automatically after the app was in the background for a minute.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { state.hiddenAt = Date.now(); if (state.vault === 'open') flushEditor(); }
    else if (state.vault === 'open' && state.hiddenAt && Date.now() - state.hiddenAt > AUTOLOCK_MS) lockNow();
  });
  document.addEventListener('keydown', function (e) {
    // Enter submits only the setup / lock / recovery forms, never the diary screens (the first button there is not 'submit').
    if (e.key !== 'Enter' || state.vault === 'open' || !e.target || e.target.tagName !== 'INPUT') return;
    var b = document.querySelector('#main .btn');
    if (b && !b.disabled) b.click();
  });


  /* ---------- entries: list, editor, autosave ---------- */
  var CATS = [['', 'cat.none'], ['diary', 'cat.diary'], ['work', 'cat.work'], ['family', 'cat.family'], ['travel', 'cat.travel'], ['idea', 'cat.idea']];
  var FILTERS = [['all', 'filter.all'], ['fav', 'filter.fav'], ['trash', 'filter.trash']];
  function catLabel(id) { for (var i = 0; i < CATS.length; i++) if (CATS[i][0] === id) return t(CATS[i][1]); return ''; }
  // Own month names: browsers often lack Uzbek/Tajik date data and print "2026 M11 21".
  var MONTHS = {
    uz: 'yanvar fevral mart aprel may iyun iyul avgust sentabr oktabr noyabr dekabr'.split(' '),
    ru: 'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' '),
    tg: 'январ феврал март апрел май июн июл август сентябр октябр ноябр декабр'.split(' ')
  };
  function fmtDate(ts) { var d = new Date(ts); return d.getDate() + ' ' + MONTHS[state.lang][d.getMonth()] + ' ' + d.getFullYear(); }
  function entryTitle(e) { return e.title.trim() || e.body.trim().split('\n')[0].slice(0, 60) || t('entry.untitled'); }

  function saveNow() {
    var e = state.editing;
    clearTimeout(state.saveTimer);
    if (!e || !state.dirty) return ShnEntries.flush();
    state.dirty = false;
    if (!e.title.trim() && !e.body.trim() && !ShnEntries.get(e.id)) return Promise.resolve();   // never store an empty draft
    setSave('entry.saving');
    return ShnEntries.commit(e).then(function () { setSave('entry.saved'); }, function () { setSave('err.generic'); });
  }
  function flushEditor() { return saveNow().then(function () { return ShnEntries.flush(); }); }
  function setSave(key) { var n = el('savestate'); if (n) n.textContent = t(key); }
  function touch() { state.dirty = true; clearTimeout(state.saveTimer); state.saveTimer = setTimeout(saveNow, 700); }

  function openEditor(entry) { state.editing = entry || ShnEntries.blank(); state.dirty = false; location.hash = '#edit'; }
  function leaveEditor() { location.hash = '#entries'; }

  function entryBody(e) {
    var meta = fmtDate(e.created) + (e.cat ? ' · ' + catLabel(e.cat) : '') + (e.fav ? ' · ★ ' + t('filter.fav') : '');
    return [h('span', { class: 'e-title' }, entryTitle(e)), h('span', { class: 'e-meta' }, meta),
      e.title.trim() && e.body.trim() ? h('span', { class: 'e-snip' }, e.body.trim().split('\n')[0].slice(0, 90)) : null];
  }
  function entryButton(e) { return h('button', { type: 'button', class: 'entry', onclick: function () { openEditor(e); } }, entryBody(e)); }

  function listItems() {
    var f = state.entries, rows = ShnEntries.list(f);
    if (!rows.length) return [h('p', { class: 'note' }, f.q ? t('entries.nomatch') : (f.filter === 'trash' ? t('trash.empty') : t('entries.empty')))];
    return rows.map(function (e) {
      var body = entryBody(e);
      if (f.filter !== 'trash') return entryButton(e);
      return h('div', { class: 'trash-row' }, body, h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'btn quiet', onclick: function () { ShnEntries.restore(e.id).then(function () { renderList(); }); } }, t('trash.restore')),
        sureButton(t('trash.purge'), function () { return ShnEntries.purge(e.id).then(function () { renderList(); }); })));
    });
  }
  function sureButton(label, action) {
    var armed = false, b = h('button', { type: 'button', class: 'btn quiet', onclick: function () {
      if (!armed) { armed = true; b.textContent = t('trash.sure'); return; }
      action();
    } }, label);
    return b;
  }
  function renderList() { var n = el('list'); if (n) n.replaceChildren.apply(n, listItems()); }

  function entriesView() {
    var f = state.entries, c = ShnEntries.counts(), bad = ShnEntries.unreadable();
    return [title('entries.title'),
      h('div', { class: 'top-actions' }, h('button', { type: 'button', class: 'btn', id: 'btn-new', onclick: function () { openEditor(null); } }, t('entries.new'))),
      h('div', { class: 'tools' },
        h('input', { id: 'q', class: 'input', type: 'search', placeholder: t('entries.search'), 'aria-label': t('entries.search'), value: f.q, autocomplete: 'off',
          oninput: function (ev) { f.q = ev.target.value; renderList(); } }),
        h('div', { class: 'chips', role: 'group' }, FILTERS.map(function (x) {
          var n = x[0] === 'all' ? c.all : (x[0] === 'fav' ? c.fav : c.trash);
          return h('button', { type: 'button', class: 'chip', id: 'f-' + x[0], 'aria-pressed': f.filter === x[0] ? 'true' : 'false',
            onclick: function () { f.filter = x[0]; render('f-' + x[0]); } }, t(x[1]) + ' ' + n);
        })),
        h('select', { id: 'cf', class: 'input', 'aria-label': t('entry.category'), onchange: function (ev) { f.cat = ev.target.value; renderList(); } },
          CATS.map(function (x) { return h('option', { value: x[0], selected: f.cat === x[0] ? 'selected' : null }, x[0] ? t(x[1]) : t('cat.all')); }))),
      h('div', { id: 'list', role: 'list' }, listItems()),
      bad ? h('p', { class: 'note', role: 'alert' }, bad + ' ' + t('entries.bad')) : null];
  }

  function editView() {
    var e = state.editing;
    return [
      h('div', { class: 'top-actions' }, h('button', { type: 'button', class: 'link', id: 'e-back', onclick: leaveEditor }, '← ' + t('entry.back'))),
      h('input', { id: 'e-title', class: 'input e-input', type: 'text', value: e.title, placeholder: t('entry.title'), 'aria-label': t('entry.title'), autocomplete: 'off',
        oninput: function (ev) { e.title = ev.target.value; touch(); } }),
      h('div', { class: 'e-bar' },
        h('select', { id: 'e-cat', class: 'input', 'aria-label': t('entry.category'), onchange: function (ev) { e.cat = ev.target.value; touch(); } },
          CATS.map(function (x) { return h('option', { value: x[0], selected: e.cat === x[0] ? 'selected' : null }, t(x[1])); })),
        h('button', { type: 'button', class: 'chip', id: 'e-fav', 'aria-pressed': e.fav ? 'true' : 'false', onclick: function (ev) {
          e.fav = e.fav ? 0 : 1; ev.currentTarget.setAttribute('aria-pressed', e.fav ? 'true' : 'false');
          ev.currentTarget.textContent = '★ ' + t(e.fav ? 'entry.unfav' : 'entry.fav'); touch(); } }, '★ ' + t(e.fav ? 'entry.unfav' : 'entry.fav'))),
      h('textarea', { id: 'e-body', class: 'input e-body', placeholder: t('entry.body'), 'aria-label': t('entry.body'),
        oninput: function (ev) { e.body = ev.target.value; touch(); } }, e.body),
      h('p', { class: 'save-state', id: 'savestate', role: 'status' }),
      h('button', { type: 'button', class: 'btn quiet', id: 'e-del', onclick: function () {
        var inDb = !!ShnEntries.get(e.id);
        saveNow().then(function () { return inDb || ShnEntries.get(e.id) ? ShnEntries.softDelete(e.id) : null; }).then(leaveEditor);
      } }, t('entry.delete'))];
  }

  /* ---------- render & routing ---------- */
  var root = document.getElementById('app');
  function render(focusId) {
    var open = state.vault === 'open';
    if (state.route === 'edit' && !state.editing) state.route = 'entries';
    var view = open ? (state.route === 'settings' ? settingsView() : state.route === 'entries' ? entriesView() : state.route === 'calendar' ? calendarView() : state.route === 'stats' ? statsView() : state.route === 'edit' ? editView() : homeView()) : gateView();
    var kids = [];
    if (open && state.updateReady && state.route === 'home') {
      kids.push(h('div', { class: 'banner', role: 'status' }, h('span', {}, t('update.ready')),
        h('button', { type: 'button', class: 'btn', onclick: applyUpdate }, t('update.apply'))));
    }
    kids.push(h('main', { id: 'main' }, view));
    if (open) kids.push(navView());
    root.replaceChildren.apply(root, kids);
    root.classList.toggle('intro', open && state.first && state.route === 'home');
    if (focusId) {
      var el = document.getElementById(focusId);
      if (el) el.focus();
    }
  }
  function route() {
    var r = (location.hash || '#home').slice(1);
    var changed = r !== state.route;
    var prev = state.route;
    state.route = (r === 'settings' || r === 'entries' || r === 'calendar' || r === 'stats') ? r : (r === 'edit' && state.editing ? 'edit' : (r === 'edit' ? 'entries' : 'home'));
    if (prev === 'edit' && state.route !== 'edit') { flushEditor(); state.editing = null; }
    if (changed) state.first = false;
    render(changed ? (state.route === 'edit' ? 'e-title' : state.route === 'calendar' ? 'cal-title' : 'page-title') : null);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('online', refreshStatus);
  window.addEventListener('offline', refreshStatus);

  /* ---------- start ---------- */
  function start() {
    var hash = (location.hash || '#home').slice(1);
    state.route = (hash === 'settings' || hash === 'entries' || hash === 'calendar' || hash === 'stats') ? hash : 'home';
    applyLang(); applyTheme(); render();

    ShnDB.open()
      .then(function () {
        return Promise.all([ShnDB.getSetting('lang', null), ShnDB.getSetting('theme', null), ShnDB.health(), ShnDB.getSetting('vault', null)]);
      })
      .then(function (r) {
        if (r[0] && window.SHN_I18N[r[0]]) { state.lang = r[0]; lsSet('shn.lang', r[0]); }
        if (r[1] && THEMES.indexOf(r[1]) !== -1) { state.theme = r[1]; lsSet('shn.theme', r[1]); }
        state.storage = 'ok';
        if (!ShnCrypto.available) { state.vault = 'error'; } else {
          state.vaultData = r[3]; state.vault = r[3] ? 'locked' : 'none';
        }
        applyLang(); applyTheme(); render('page-title');
        return requestPersistence();
      })
      .catch(function () { state.storage = 'fail'; state.vault = 'error'; render(); });

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
