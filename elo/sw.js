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
// Clave de acceso al webhook (ver getAppToken/setAppToken en
// frontend/shared-engine.js): las páginas la copian a Cache Storage porque
// acá no hay localStorage. Sin clave no se manda nada — los items quedan en
// IndexedDB y salen la próxima vez que se abra una página.
var APP_TOKEN_CACHE = "cine-elo-auth";
var APP_TOKEN_CACHE_PATH = "__cine-elo-app-token__";

function getAppToken() {
  var url = new URL(APP_TOKEN_CACHE_PATH, self.location.href).href;
  return caches.open(APP_TOKEN_CACHE)
    .then(function (c) { return c.match(url); })
    .then(function (r) { return r ? r.text() : ""; })
    .catch(function () { return ""; });
}

function apiFetch(url, options) {
  return getAppToken().then(function (token) {
    if (!token) throw new Error("falta la clave de acceso (APP_TOKEN)");
    var sep = url.indexOf("?") === -1 ? "?" : "&";
    return fetch(url + sep + "token=" + encodeURIComponent(token), options);
  });
}

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
    return apiFetch(
      SYNC_URL +
        "?action=setFields&tmdbId=" + encodeURIComponent(item.tmdbId || "") +
        "&title=" + encodeURIComponent(item.title || "") +
        "&year=" + encodeURIComponent(item.year || "") +
        "&changes=" + encodeURIComponent(JSON.stringify(item.changes))
    ).then(function (r) { return r.json(); });
  }
  if (item.type === "create") {
    return apiFetch(SYNC_URL + "?allowCreate=1", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify([item.payload]),
    }).then(function (r) { return r.json(); });
  }
  if (item.type === "eloDelta") {
    // Duelo como delta (ver makeEloDeltaItem en frontend/shared-engine.js):
    // el backend lo suma a la fila y descarta reintentos por opId.
    return apiFetch(SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        type: "eloOps",
        ops: [{
          opId: item.opId,
          tmdbId: item.tmdbId || "",
          title: item.title,
          year: item.year || "",
          dElo: item.dElo,
          dGames: item.dGames,
          dWins: item.dWins,
          baseElo: item.baseElo,
          expectRated: item.expectRated,
        }],
      }),
    }).then(function (r) { return r.json(); });
  }
  if (item.type === "syncElo") {
    // Duelo con estado completo, de una versión anterior de la app.
    return apiFetch(SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify([{
        title: item.title,
        year: item.year || "",
        tmdbId: item.tmdbId || "",
        elo: item.elo,
        games: item.games,
        wins: item.wins,
        losses: item.losses,
        ties: 0,
        expectRated: item.expectRated,
        allowDecrease: !!item.allowDecrease,
      }]),
    }).then(function (r) { return r.json(); });
  }
  if (item.type === "deleteMovie") {
    return apiFetch(SYNC_URL, {
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
