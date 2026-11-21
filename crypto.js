/* Sh+N crypto — Web Crypto only, no third-party code.
   Design: a random 256-bit data key (DEK) encrypts all diary data (AES-GCM).
   The DEK is stored only in wrapped (encrypted) form: once under the password (PBKDF2),
   once under the Recovery Key, and optionally once under the PIN (device-only).
   Passwords, PIN, Recovery Key and DEK are never stored in plain form. */
(function () {
  'use strict';
  var subtle = window.crypto && window.crypto.subtle;
  var enc = new TextEncoder(), dec = new TextDecoder();
  var PW_ITER = 600000, PIN_ITER = 300000;

  /* 2048 pronounceable words = 11 bits each (consonant-vowel-consonant-vowel). 24 words = 256-bit key + 8-bit checksum.
     This is Sh+N's own list, NOT the BIP39 list. */
  var C = 'bdfgklmnprstvzhj'.split(''), V = ['a', 'e', 'i', 'o'], E = ['a', 'o'];
  var WORDS = [], INDEX = Object.create(null);
  for (var i = 0; i < 2048; i++) {
    var w = C[i >> 7] + V[(i >> 5) & 3] + C[(i >> 1) & 15] + E[i & 1];
    WORDS.push(w); INDEX[w] = i;
  }

  function b64(buf) { var s = ''; new Uint8Array(buf).forEach(function (x) { s += String.fromCharCode(x); }); return btoa(s); }
  function unb64(s) { var b = atob(s), u = new Uint8Array(b.length); for (var k = 0; k < b.length; k++) u[k] = b.charCodeAt(k); return u; }
  function rand(n) { return crypto.getRandomValues(new Uint8Array(n)); }
  function sha8(bytes) { return subtle.digest('SHA-256', bytes).then(function (d) { return new Uint8Array(d)[0]; }); }
  function fail(msg) { return Promise.reject(new Error(msg)); }

  function bytesToWords(bytes) {
    var out = [], acc = 0, n = 0;
    for (var k = 0; k < bytes.length; k++) {
      acc = (acc << 8) | bytes[k]; n += 8;
      while (n >= 11) { out.push(WORDS[(acc >> (n - 11)) & 2047]); n -= 11; acc &= (1 << n) - 1; }
    }
    return out;
  }
  function wordsToBytes(idx) {
    var out = [], acc = 0, n = 0;
    idx.forEach(function (x) {
      acc = (acc << 11) | x; n += 11;
      while (n >= 8) { out.push((acc >> (n - 8)) & 255); n -= 8; acc &= (1 << n) - 1; }
    });
    return new Uint8Array(out);
  }
  function encodeRecovery(key) {
    return sha8(key).then(function (c) { var f = new Uint8Array(33); f.set(key); f[32] = c; return bytesToWords(f); });
  }
  function decodeRecovery(text) {
    var ws = String(text).toLowerCase().trim().split(/\s+/), idx = [];
    if (ws.length !== 24) return fail('words');
    for (var k = 0; k < 24; k++) { if (!(ws[k] in INDEX)) return fail('words'); idx.push(INDEX[ws[k]]); }
    var bytes = wordsToBytes(idx), key = bytes.slice(0, 32);
    return sha8(key).then(function (c) { if (c !== bytes[32]) throw new Error('checksum'); return key; });
  }

  function derive(secret, salt, iter) {
    return subtle.importKey('raw', enc.encode(String(secret).normalize('NFKC')), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: iter }, base,
          { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }
  function wrap(kek, raw, label) {
    var iv = rand(12);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(label) }, kek, raw)
      .then(function (ct) { return { iv: b64(iv), ct: b64(ct) }; });
  }
  function unwrap(kek, w, label) {
    return subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv), additionalData: enc.encode(label) }, kek, unb64(w.ct))
      .then(function (raw) { return new Uint8Array(raw); }, function () { throw new Error('wrong'); });
  }
  function importDek(raw) { return subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  function importRec(rec) { return subtle.importKey('raw', rec, 'AES-GCM', false, ['encrypt', 'decrypt']); }
  function pinWrap(pin, raw) {
    var salt = rand(16);
    return derive(pin, salt, PIN_ITER).then(function (k) { return wrap(k, raw, 'pin'); })
      .then(function (w) { return { salt: b64(salt), iter: PIN_ITER, wrap: w, fails: 0 }; });
  }

  function createVault(password, pin) {
    var raw = rand(32), salt = rand(16), rec = rand(32);
    return Promise.all([derive(password, salt, PW_ITER), importRec(rec), encodeRecovery(rec)]).then(function (r) {
      return Promise.all([wrap(r[0], raw, 'pw'), wrap(r[1], raw, 'rec'), pin ? pinWrap(pin, raw) : null, importDek(raw)])
        .then(function (x) {
          return { vault: { v: 1, iter: PW_ITER, salt: b64(salt), wrapPw: x[0], wrapRec: x[1], pin: x[2] }, words: r[2], dek: x[3] };
        });
    });
  }
  function unlockPassword(v, pw) {
    return derive(pw, unb64(v.salt), v.iter).then(function (k) { return unwrap(k, v.wrapPw, 'pw'); }).then(importDek);
  }
  function unlockPin(v, pin) {
    if (!v.pin) return fail('wrong');
    return derive(pin, unb64(v.pin.salt), v.pin.iter).then(function (k) { return unwrap(k, v.pin.wrap, 'pin'); }).then(importDek);
  }
  function recover(v, words, newPw) {
    return decodeRecovery(words).then(importRec).then(function (k) { return unwrap(k, v.wrapRec, 'rec'); }).then(function (raw) {
      var salt = rand(16);
      return derive(newPw, salt, PW_ITER).then(function (k) { return wrap(k, raw, 'pw'); }).then(function (w) {
        return importDek(raw).then(function (dek) {
          var nv = JSON.parse(JSON.stringify(v));
          nv.salt = b64(salt); nv.iter = PW_ITER; nv.wrapPw = w;
          if (nv.pin) nv.pin.fails = 0;
          return { vault: nv, dek: dek };
        });
      });
    });
  }

  function encrypt(dek, obj) {
    var iv = rand(12);
    return subtle.encrypt({ name: 'AES-GCM', iv: iv }, dek, enc.encode(JSON.stringify(obj)))
      .then(function (ct) { return { iv: b64(iv), ct: b64(ct) }; });
  }
  function decrypt(dek, blob) {
    return subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, dek, unb64(blob.ct))
      .then(function (p) { return JSON.parse(dec.decode(p)); }, function () { throw new Error('wrong'); });
  }

  window.ShnCrypto = {
    available: !!subtle, WORDS: WORDS, PW_ITER: PW_ITER,
    encodeRecovery: encodeRecovery, decodeRecovery: decodeRecovery,
    createVault: createVault, unlockPassword: unlockPassword, unlockPin: unlockPin, recover: recover,
    encrypt: encrypt, decrypt: decrypt
  };
})();
