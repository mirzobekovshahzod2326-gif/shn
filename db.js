/* Sh+N local database (IndexedDB) with versioned, non-destructive migrations.
   RULES for every future release:
   1. Never edit or delete an old migration. Add a new number.
   2. Never delete an object store or its data inside a migration unless data was copied first.
   3. Raise DB_VERSION together with adding the migration. */
(function () {
  'use strict';
  var DB_NAME = 'shn';
  var DB_VERSION = 1;

  var MIGRATIONS = {
    1: function (db) {
      db.createObjectStore('settings', { keyPath: 'key' });
    }
  };

  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB is not supported')); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        for (var v = e.oldVersion + 1; v <= e.newVersion; v++) {
          if (!MIGRATIONS[v]) throw new Error('Missing migration ' + v);
          MIGRATIONS[v](req.result, req.transaction);
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        // Another tab runs a newer version: close so its upgrade is not blocked.
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error); };
    }).catch(function (err) { dbPromise = null; throw err; });
    return dbPromise;
  }

  function run(store, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, mode);
        var result;
        tx.oncomplete = function () { resolve(result); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Transaction aborted')); };
        var req = fn(tx.objectStore(store));
        if (req) req.onsuccess = function () { result = req.result; };
      });
    });
  }

  function getSetting(key, fallback) {
    return run('settings', 'readonly', function (s) { return s.get(key); })
      .then(function (row) { return row ? row.value : fallback; });
  }

  function setSetting(key, value) {
    return run('settings', 'readwrite', function (s) { return s.put({ key: key, value: value }); });
  }

  /* Real round-trip check: write, read back, compare, delete. */
  function health() {
    var probe = String(Date.now());
    return setSetting('__probe', probe)
      .then(function () { return getSetting('__probe', null); })
      .then(function (v) {
        if (v !== probe) throw new Error('Read-back mismatch');
        return run('settings', 'readwrite', function (s) { return s.delete('__probe'); });
      })
      .then(function () { return true; });
  }

  window.ShnDB = { open: open, getSetting: getSetting, setSetting: setSetting, health: health, VERSION: DB_VERSION };
})();
