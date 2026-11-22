/* Sh+N diary records. Each record is encrypted with the data key (AES-GCM, id bound as AAD).
   IndexedDB sees only: id, type, iv, ct. Title, text, dates, category and flags are inside the ciphertext.
   Decrypted records live only in memory while the app is unlocked and are dropped on lock. */
(function () {
  'use strict';
  var items = [], unreadable = 0, dek = null, chain = Promise.resolve();
  var moods = {}, moodIds = {};   // 'YYYY-MM-DD' -> level 1..5, and -> random record id (ids never reveal dates)

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)), h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function snapshot(e) {
    return { title: e.title, body: e.body, cat: e.cat, fav: e.fav ? 1 : 0, created: e.created, updated: e.updated, deleted: e.deleted || 0, rev: e.rev || 0 };
  }
  function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/[ʻʼ‘’`´]/g, "'"); }

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function load(key) {
    dek = key; items = []; unreadable = 0; moods = {}; moodIds = {};
    return ShnDB.getAll('items').then(function (rows) {
      return Promise.all(rows.map(function (r) {
        return ShnCrypto.decrypt(dek, { iv: r.iv, ct: r.ct }, r.id).then(
          function (p) { return { type: r.type, id: r.id, p: p }; },
          function () { unreadable++; return null; });
      }));
    }).then(function (list) {
      list.forEach(function (x) {
        if (!x) return;
        if (x.type === 'mood') { moods[x.p.day] = x.p.level; moodIds[x.p.day] = x.id; }
        else items.push(Object.assign({ id: x.id }, x.p));
      });
    });
  }
  function clear() { items = []; unreadable = 0; dek = null; moods = {}; moodIds = {}; }

  function blank() {
    var now = Date.now();
    return { id: uuid(), title: '', body: '', cat: '', fav: 0, created: now, updated: now, deleted: 0, rev: 0 };
  }
  function save(e) {
    e.updated = Date.now(); e.rev = (e.rev || 0) + 1;
    var id = e.id, snap = snapshot(e), key = dek;       // snapshot now: later edits cannot change this write
    var p = chain.then(function () {
      return ShnCrypto.encrypt(key, snap, id).then(function (blob) {
        return ShnDB.put('items', { id: id, type: 'entry', v: 1, iv: blob.iv, ct: blob.ct });
      });
    });
    chain = p.catch(function () {});
    return p;
  }
  function commit(e) { if (items.indexOf(e) === -1) items.push(e); return save(e); }
  function flush() { return chain; }
  function get(id) { return items.filter(function (e) { return e.id === id; })[0] || null; }
  function setDeleted(id, ts) { var e = get(id); if (!e) return Promise.resolve(); e.deleted = ts; return save(e); }
  function softDelete(id) { return setDeleted(id, Date.now()); }
  function restore(id) { return setDeleted(id, 0); }
  function purge(id) {
    items = items.filter(function (e) { return e.id !== id; });
    var p = chain.then(function () { return ShnDB.del('items', id); });
    chain = p.catch(function () {});
    return p;
  }

  /* filter: all | fav | trash. Search covers title and text. */
  function list(opt) {
    var q = norm(opt.q).trim(), out = items.filter(function (e) {
      if (opt.filter === 'trash') { if (!e.deleted) return false; } else if (e.deleted) return false;
      if (opt.filter === 'fav' && !e.fav) return false;
      if (opt.cat && e.cat !== opt.cat) return false;
      return !q || norm(e.title).indexOf(q) !== -1 || norm(e.body).indexOf(q) !== -1;
    });
    out.sort(function (a, b) { return opt.filter === 'trash' ? b.deleted - a.deleted : b.updated - a.updated; });
    return out;
  }
  function counts() {
    var live = items.filter(function (e) { return !e.deleted; });
    return { all: live.length, fav: live.filter(function (e) { return e.fav; }).length, trash: items.length - live.length };
  }


  function enqueue(job) { var p = chain.then(job); chain = p.catch(function () {}); return p; }
  function setMood(day, level) {
    var id = moodIds[day] || (moodIds[day] = uuid()), key = dek, snap = { day: day, level: level, updated: Date.now() };
    moods[day] = level;
    return enqueue(function () {
      return ShnCrypto.encrypt(key, snap, id).then(function (b) { return ShnDB.put('items', { id: id, type: 'mood', v: 1, iv: b.iv, ct: b.ct }); });
    });
  }
  function clearMood(day) {
    var id = moodIds[day]; delete moods[day]; delete moodIds[day];
    return id ? enqueue(function () { return ShnDB.del('items', id); }) : Promise.resolve();
  }
  function moodOf(day) { return moods[day] || 0; }
  function live() { return items.filter(function (e) { return !e.deleted; }); }
  function entriesOn(day) {
    return live().filter(function (e) { return dayKey(e.created) === day; }).sort(function (a, b) { return a.created - b.created; });
  }
  function entryDays(prefix) {
    var out = {};
    live().forEach(function (e) { var k = dayKey(e.created); if (k.indexOf(prefix) === 0) out[k] = (out[k] || 0) + 1; });
    return out;
  }
  function stats() {
    var L = live(), act = {}, today = new Date(); today.setHours(12, 0, 0, 0);
    L.forEach(function (e) { act[dayKey(e.created)] = 1; });
    Object.keys(moods).forEach(function (d) { act[d] = 1; });
    function key(off) { var d = new Date(today); d.setDate(d.getDate() - off); return dayKey(d); }
    var streak = 0, start = act[key(0)] ? 0 : 1;
    while (act[key(start + streak)]) streak++;
    var best = 0, run = 0, prev = null;
    Object.keys(act).sort().forEach(function (k) {
      if (prev && Math.round((new Date(k + 'T12:00') - new Date(prev + 'T12:00')) / 86400000) === 1) run++; else run = 1;
      if (run > best) best = run; prev = k;
    });
    var week = [], dist = [0, 0, 0, 0, 0], sum = 0, n = 0, i;
    for (i = 6; i >= 0; i--) { var wk = key(i); week.push({ day: wk, level: moods[wk] || 0 }); }
    for (i = 0; i < 30; i++) { var m = moods[key(i)]; if (m) { dist[m - 1]++; sum += m; n++; } }
    var month = dayKey(today).slice(0, 7);
    return { total: L.length, streak: streak, best: best, week: week, dist: dist, moodDays: n, avg: n ? Math.round(sum / n * 10) / 10 : 0,
      month: L.filter(function (e) { return dayKey(e.created).slice(0, 7) === month; }).length };
  }

  window.ShnEntries = { dayKey: dayKey, setMood: setMood, clearMood: clearMood, moodOf: moodOf, entriesOn: entriesOn, entryDays: entryDays, stats: stats, load: load, clear: clear, blank: blank, commit: commit, flush: flush, get: get,
    softDelete: softDelete, restore: restore, purge: purge, list: list, counts: counts,
    unreadable: function () { return unreadable; } };
})();
