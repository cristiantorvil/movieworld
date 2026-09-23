// Service Worker de Cine Elo — solo existe para el Background Sync de la
// cola de guardados pendientes (ver PENDING_SYNC en edit.html/add.html/
// index.html). No cachea nada ni intercepta fetch: cada página se sigue
// sirviendo normal, esto únicamente permite que el navegador reintente un
// guardado en segundo plano aunque se cierren todas las pestañas de
// Cine Elo, en cuanto haya conexión.
//
// IMPORTANTE: los service workers no tienen acceso a localStorage, por
// eso la cola vive en IndexedDB (misma base "cine-elo-db" que usan las
// páginas) — es el único storage compartido entre página y worker.

var SYNC_URL =
  "https://script.google.com/macros/s/AKfycbxj4NLejc7vBU17MyuJefuEA8YbjdP0czUNlGN6u96U_fYb1czZMkhUM2k_Y0gpBU0aQg/exec";
var IDB_NAME = "cine-elo-db";
var IDB_STORE = "pendingSync";

function idbOpen() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = function () {
      req.result.createObjectStore(IDB_STORE, { keyPath: "id" });
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function idbGetAll() {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, "readonly");
      var req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error); };
    });
  });
}

function idbRemove(id) {
  return idbOpen().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(id);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
    });
  });
}

function syncItem(item) {
  // tmdbId es el identificador primario en el backend (title+year quedan de
  // fallback ahí) — items viejos ya en IndexedDB sin tmdbId simplemente
  // mandan "" acá, que el backend interpreta como "no viene id".
  if (item.type === "setFields") {
    return fetch(
      SYNC_URL +
        "?action=setFields&tmdbId=" + encodeURIComponent(item.tmdbId || "") +
        "&title=" + encodeURIComponent(item.title || "") +
        "&year=" + encodeURIComponent(item.year || "") +
        "&changes=" + encodeURIComponent(JSON.stringify(item.changes))
    ).then(function (r) { return r.json(); });
  }
  if (item.type === "create") {
    return fetch(SYNC_URL + "?allowCreate=1", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify([item.payload]),
    }).then(function (r) { return r.json(); });
  }
  if (item.type === "deleteMovie") {
    return fetch(SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ type: "deleteMovie", tmdbId: item.tmdbId || "", title: item.title, year: item.year }),
    }).then(function (r) { return r.json(); });
  }
  return Promise.reject(new Error("tipo de pending sync desconocido: " + item.type));
}

// Si un item falla, dejamos que la excepción se propague: eso marca el
// evento 'sync' entero como fallido, y el navegador programa un reintento
// más adelante con su propio backoff (los items que ya se sacaron de
// IndexedDB en esta misma pasada no se vuelven a mandar en ese reintento).
function flushAll() {
  return idbGetAll().then(function (items) {
    var chain = Promise.resolve();
    items.forEach(function (item) {
      chain = chain.then(function () {
        return syncItem(item).then(function (data) {
          if (!data || !data.ok) throw new Error("backend respondió ok:false");
          return idbRemove(item.id);
        });
      });
    });
    return chain;
  });
}

self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("sync", function (event) {
  if (event.tag === "flush-pending-sync") {
    event.waitUntil(flushAll());
  }
});
