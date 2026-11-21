/* Sh+N diary records. Each record is encrypted with the data key (AES-GCM, id bound as AAD).
   IndexedDB sees only: id, type, iv, ct. Title, text, dates, category and flags are inside the ciphertext.
   Decrypted records live only in memory while the app is unlocked and are dropped on lock. */
(function () {
  'use strict';
  var items = [], unreadable = 0, dek = null, chain = Promise.resolve();

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = crypto.getRandomValues(new Uint8Array(16)), h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function snapshot(e) {
    return { title: e.title, body: e.body, cat: e.cat, fav: e.fav ? 1 : 0, created: e.created, updated: e.updated, deleted: e.deleted || 0, rev: e.rev || 0 };
  }
  function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/[ʻʼ‘’`´]/g, "'"); }

  function load(key) {
    dek = key; items = []; unreadable = 0;
    return ShnDB.getAll('items').then(function (rows) {
      return Promise.all(rows.map(function (r) {
        return ShnCrypto.decrypt(dek, { iv: r.iv, ct: r.ct }, r.id).then(
          function (p) { return Object.assign({ id: r.id }, p); },
          function () { unreadable++; return null; });
      }));
    }).then(function (list) { items = list.filter(Boolean); });
  }
  function clear() { items = []; unreadable = 0; dek = null; }

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

  window.ShnEntries = { load: load, clear: clear, blank: blank, commit: commit, flush: flush, get: get,
    softDelete: softDelete, restore: restore, purge: purge, list: list, counts: counts,
    unreadable: function () { return unreadable; } };
})();
