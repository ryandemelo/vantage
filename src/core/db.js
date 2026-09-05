/*
 * Vantage, db.js
 * IndexedDB wrapper. Shared by the service worker and by extension pages
 * (popup / reports / options), they all live on the same extension origin,
 * so they read the same database directly.
 *
 * Nothing in here talks to the network. Ever.
 */
(function (root) {
  'use strict';
  const VG = (root.VG = root.VG || {});

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(VG.DB_NAME, VG.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const tx = e.target.transaction;
        const oldVersion = e.oldVersion || 0;

        if (!db.objectStoreNames.contains('events')) {
          const store = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
          store.createIndex('ts', 'ts');
          store.createIndex('day', 'day');
          store.createIndex('site', 'site');
          store.createIndex('workType', 'workType');
          store.createIndex('conversationHash', 'conversationHash');
          return; // new database, nothing to migrate
        }

        // Existing database. Bring every row up to the current event shape so
        // consumers do not have to guess which fields a row predates.
        if (oldVersion < 2) {
          const store = tx.objectStore('events');
          let migrated = 0;
          store.openCursor().onsuccess = (ev) => {
            const cur = ev.target.result;
            if (!cur) {
              if (migrated) console.info('[Vantage] migrated ' + migrated + ' rows to event schema ' + VG.EVENT_SCHEMA_VERSION);
              return;
            }
            const next = VG.migrateEvent(cur.value);
            if (next !== cur.value) { cur.update(next); migrated++; }
            cur.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  VG.db = {
    async add(event) {
      const store = await tx('events', 'readwrite');
      return new Promise((resolve, reject) => {
        const req = store.add(event);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async get(id) {
      const store = await tx('events', 'readonly');
      return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },

    async update(id, patch) {
      const store = await tx('events', 'readwrite');
      return new Promise((resolve, reject) => {
        const get = store.get(id);
        get.onsuccess = () => {
          const row = get.result;
          if (!row) return resolve(false);
          Object.assign(row, patch);
          const put = store.put(row);
          put.onsuccess = () => resolve(true);
          put.onerror = () => reject(put.error);
        };
        get.onerror = () => reject(get.error);
      });
    },

    /** Events with from <= ts < to, ascending. */
    async range(from, to) {
      const store = await tx('events', 'readonly');
      return new Promise((resolve, reject) => {
        const out = [];
        const req = store.index('ts').openCursor(IDBKeyRange.bound(from, to, false, true));
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return resolve(out);
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },

    async all() {
      const store = await tx('events', 'readonly');
      return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },

    /** Count rows in a time range without materialising them. */
    async countRange(from, to) {
      const store = await tx('events', 'readonly');
      return new Promise((resolve, reject) => {
        const req = store.index('ts').count(IDBKeyRange.bound(from, to, false, true));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async count() {
      const store = await tx('events', 'readonly');
      return new Promise((resolve, reject) => {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },

    async first() {
      const store = await tx('events', 'readonly');
      return new Promise((resolve, reject) => {
        const req = store.index('ts').openCursor();
        req.onsuccess = (e) => resolve(e.target.result ? e.target.result.value : null);
        req.onerror = () => reject(req.error);
      });
    },

    /** Delete everything older than `days`. Returns rows removed. */
    async purgeOlderThan(days) {
      const cutoff = Date.now() - days * 86400000;
      const store = await tx('events', 'readwrite');
      return new Promise((resolve, reject) => {
        let n = 0;
        const req = store.index('ts').openCursor(IDBKeyRange.upperBound(cutoff, true));
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return resolve(n);
          cur.delete();
          n++;
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },

    /** Strip stored prompt text but keep the metrics. Used by "forget text". */
    async stripText() {
      const store = await tx('events', 'readwrite');
      return new Promise((resolve, reject) => {
        let n = 0;
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return resolve(n);
          if (cur.value.promptText) {
            cur.value.promptText = '';
            cur.update(cur.value);
            n++;
          }
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },

    /** Remove only rows created by the sample-data generator. */
    async clearDemo() {
      const store = await tx('events', 'readwrite');
      return new Promise((resolve, reject) => {
        let n = 0;
        const req = store.openCursor();
        req.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return resolve(n);
          if (cur.value.demo) { cur.delete(); n++; }
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },

    async addMany(rows) {
      const store = await tx('events', 'readwrite');
      return new Promise((resolve, reject) => {
        let n = 0;
        rows.forEach((r) => { store.add(r); n++; });
        store.transaction.oncomplete = () => resolve(n);
        store.transaction.onerror = () => reject(store.transaction.error);
      });
    },

    /**
     * Release the connection. Nothing in normal operation needs this, but a
     * held connection blocks deleteDatabase and any version upgrade, so a
     * caller that is about to do either has to be able to let go first.
     */
    async close() {
      if (!dbPromise) return false;
      try {
        const db = await dbPromise;
        db.close();
      } catch (e) { /* already gone */ }
      dbPromise = null;
      return true;
    },

    async clear() {
      const store = await tx('events', 'readwrite');
      return new Promise((resolve, reject) => {
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    }
  };

  /* ---------------- settings (chrome.storage.local + managed) ---------------- */

  VG.settings = {
    async get() {
      const local = await chrome.storage.local.get('settings');
      let managed = {};
      try {
        managed = (await chrome.storage.managed.get(null)) || {};
      } catch (e) {
        managed = {};
      }
      const merged = Object.assign({}, VG.DEFAULT_SETTINGS, local.settings || {});
      const locked = [];
      VG.MANAGED_KEYS.forEach((k) => {
        if (managed[k] !== undefined && managed[k] !== null) {
          merged[k] = managed[k];
          locked.push(k);
        }
      });
      merged.__locked = locked;
      // Full text can never be selected unless policy or the user unlocked it.
      if (merged.captureLevel === VG.CAPTURE_LEVELS.FULL && !merged.allowFullText) {
        merged.captureLevel = VG.CAPTURE_LEVELS.REDACTED;
      }
      return merged;
    },

    async set(patch) {
      const clean = Object.assign({}, patch || {});
      // Where data goes is an administrator's decision, never a user's.
      const refused = [];
      VG.POLICY_ONLY_KEYS.forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(clean, k)) {
          delete clean[k];
          refused.push(k);
        }
      });
      if (refused.length) {
        console.warn('[Vantage] refused policy-only setting(s): ' + refused.join(', '));
      }
      const local = await chrome.storage.local.get('settings');
      const next = Object.assign({}, VG.DEFAULT_SETTINGS, local.settings || {}, clean);
      delete next.__locked;
      await chrome.storage.local.set({ settings: next });
      return VG.settings.get();
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);
