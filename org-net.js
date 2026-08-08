/* Org Campaign multiplayer — Bring Your Own Firebase.
 * Each org runs its own free Firebase Realtime Database; this site ships no
 * backend. A join code carries {apiKey, databaseURL, path}; the campaign is an
 * append-only event log under <path>/events, folded client-side by org-state.js.
 * The Firebase SDK loads on demand — the local demo never touches the network.
 */
(function () {
  'use strict';

  const SDK_VERSION = '10.14.1';
  const SDK = ['firebase-app-compat.js', 'firebase-auth-compat.js', 'firebase-database-compat.js']
    .map(f => `https://www.gstatic.com/firebasejs/${SDK_VERSION}/${f}`);

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('failed to load ' + src));
      document.head.appendChild(s);
    });
  }
  async function loadSDK() {
    if (window.firebase && window.firebase.database) return;
    for (const src of SDK) await loadScript(src);
  }

  // ── Join codes ──────────────────────────────────────────────────────────
  // Compact form: SMR1~<apiKey>~<dbHost>~<campaignId> (~90 chars) — the known
  // Firebase host suffix is stripped and rebuilt, the path prefix is implied.
  // The apiKey itself is Google's ~39-char credential and cannot be shortened.
  // Legacy base64-JSON codes still decode, so nothing already shared breaks.
  const enc = (obj) => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/=+$/, '');
  const dec = (code) => JSON.parse(decodeURIComponent(escape(atob(code))));

  const hostShort = (databaseURL) => {
    const host = String(databaseURL).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (host.endsWith('.firebaseio.com')) return host.slice(0, -'.firebaseio.com'.length);
    if (host.endsWith('.firebasedatabase.app')) return host.slice(0, -'.firebasedatabase.app'.length);
    return null; // unusual host — fall back to the verbose format
  };
  const hostFull = (short) =>
    'https://' + short + (short.includes('.') ? '.firebasedatabase.app' : '.firebaseio.com');

  function makeCode(cfg, path) {
    const short = hostShort(cfg.databaseURL);
    const id = /^campaigns\/([A-Za-z0-9_-]+)$/.exec(String(path));
    if (short && id && /^[A-Za-z0-9_-]+$/.test(cfg.apiKey)) {
      return `SMR1~${cfg.apiKey}~${short}~${id[1]}`;
    }
    return enc({ v: 1, cfg: { apiKey: cfg.apiKey, databaseURL: cfg.databaseURL }, path });
  }
  function readCode(code) {
    const c = String(code).replace(/\s+/g, ''); // Discord line-wraps happen
    if (c.startsWith('SMR1~')) {
      const parts = c.split('~');
      if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) throw new Error('not a valid join code');
      return { v: 1, cfg: { apiKey: parts[1], databaseURL: hostFull(parts[2]) }, path: 'campaigns/' + parts[3] };
    }
    const d = dec(c);
    if (!d || d.v !== 1 || !d.cfg || !d.cfg.apiKey || !d.cfg.databaseURL || !d.path) {
      throw new Error('not a valid join code');
    }
    return d;
  }

  // same surface as OrgState.createDemoStore — the board can't tell them apart
  async function createStore(code, hooks) {
    const { cfg, path } = readCode(code);
    const note = (s) => { if (hooks && hooks.status) hooks.status(s); };
    note('connecting');
    await loadSDK();
    const app = window.firebase.apps.length ? window.firebase.app() : window.firebase.initializeApp(cfg);
    await window.firebase.auth(app).signInAnonymously();
    const db = window.firebase.database(app);
    const root = String(path).replace(/\/+$/, '');
    const ref = db.ref(root + '/events');

    const events = [];
    const subs = [];
    let timer = null;
    // child_added streams the whole history first, then live appends — debounce
    // so the initial burst folds once, not once per event
    const notify = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const snap = events.slice();
        subs.forEach(cb => cb(snap));
      }, 60);
    };
    ref.on('child_added', (snap) => {
      const v = snap.val();
      if (v && v.k && v.a != null && typeof v.t === 'number') {
        events.push(Object.assign({ _k: snap.key }, v));
        notify();
      }
    });
    db.ref('.info/connected').on('value', s => note(s.val() ? 'live' : 'offline'));
    // don't hand the board an empty log while history is still in flight —
    // once('value') resolves only after every existing child_added has fired,
    // so the first subscribe callback always carries the real campaign
    await new Promise((resolve) => ref.once('value', resolve, resolve));

    const strip = (e) => {
      const c = Object.assign({}, e);
      delete c._k;
      return c;
    };
    return {
      net: true,
      append(ev) { ref.push(strip(ev)); return ev; },
      // first-writer-wins on a write-once node (rules: write iff !data.exists) —
      // the client that lands the claim is the one that sends the day's report
      claimOnce(key, val) {
        return db.ref(root + '/reports/' + key).set(val).then(() => true, () => false);
      },
      subscribe(cb) { subs.push(cb); cb(events.slice()); return () => subs.splice(subs.indexOf(cb), 1); },
      exportLog() { return JSON.stringify({ format: 'smr-org-log', v: 1, events: events.map(strip) }, null, 0); },
      importLog(str) {
        const data = JSON.parse(str);
        if (data.format !== 'smr-org-log' || !Array.isArray(data.events)) throw new Error('Not a campaign log');
        for (const e of data.events) if (e && e.k) ref.push(strip(e));
      },
      clear() { throw new Error('a shared campaign cannot be erased from the app'); },
      size() { return events.length; },
    };
  }

  window.OrgNet = { createStore, makeCode, readCode };
})();
