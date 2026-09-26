// Motor compartido de Elo/duelos + cola de sincronización pendiente, usado
// por Cine Elo (cine-elo.jsx), Watchlist, Agregar y Editar película. Antes
// cada página reimplementaba esto por separado — código casi idéntico, pero
// que se iba desincronizando (constantes repetidas, timeouts distintos,
// algún tipo de item de la cola sin soportar en una sola de las 4 copias) —
// y esa desincronización fue la causa de varios bugs de Elo/duelos "que
// vuelven" pese a arreglarlos en una sola página. Vive acá (elo/frontend/,
// no elo/ raíz) para que cine-elo.jsx lo importe con "../shared-engine.js"
// desde build/cine-elo.jsx (ver elo/frontend/build/); las páginas
// standalone (sin build: add.html, edit.html, watchlist.html) lo cargan con
// <script type="module"> e importan "./frontend/shared-engine.js".
//
// sw.js (Service Worker) NO importa este módulo a propósito: el soporte de
// Service Workers de tipo "module" todavía es inconsistente en Safari/
// iPhone, que es justo el navegador que más nos importa cubrir acá — sw.js
// se queda con su propia copia mínima, autocontenida.

export const SYNC_URL =
  "https://script.google.com/macros/s/AKfycbxj4NLejc7vBU17MyuJefuEA8YbjdP0czUNlGN6u96U_fYb1czZMkhUM2k_Y0gpBU0aQg/exec";

export const START_ELO = 1200;

// K dinámico: mientras menos duelos lleva una película, más se mueve su elo
// por cada resultado nuevo (todavía estamos "descubriendo" dónde va) — y
// una vez asentada, cada duelo pesa menos. Mismo criterio que usan las
// federaciones de ajedrez con jugadores nuevos vs. establecidos.
export function getKFactor(comparisons) {
  if (comparisons < 10) return 32;
  if (comparisons < 30) return 20;
  return 12;
}

export function expectedScore(a, b) {
  return 1 / (1 + Math.pow(10, (b - a) / 400));
}

export function computeInitialElo(rating, plays) {
  // rating: 0.5-5 estrellas, plays: veces vista
  const r = typeof rating === "number" ? rating : 2.5;
  const p = typeof plays === "number" ? plays : 1;
  const ratingBonus = (r - 2.5) * 100; // ±250 según nota
  const playsBonus = Math.min(p - 1, 10) * 10; // hasta +100 por rewatches
  return Math.round(START_ELO + ratingBonus + playsBonus);
}

// Elo base de una peli de watchlist: en vez de un valor fijo para todas,
// usa el rating promedio de TMDB (vote_average, escala 0-10) pasado por la
// misma fórmula de arriba (dividido 2 para llevarlo a escala de estrellas).
// Sin votos no hay señal real, así que queda en el neutro START_ELO. Misma
// lógica que _computeWatchlistElo_ en el backend (Código.js).
export function computeWatchlistElo(voteAverage, voteCount) {
  const v = typeof voteAverage === "number" ? voteAverage : parseFloat(voteAverage);
  const count = typeof voteCount === "number" ? voteCount : parseFloat(voteCount);
  if (!v || !count) return START_ELO;
  return computeInitialElo(v / 2, 1);
}

// Clave de identidad compartida por películas locales y items de la cola
// pendiente (ambos traen tmdbId/title/year): tmdbId es el identificador
// primario, "title:"+título+"|"+año queda de fallback SOLO para películas
// sin tmdbId asignado todavía (nunca título solo — dos homónimas sin tmdbId
// pero con años distintos tampoco deberían colisionar).
export function movieKey(m) {
  return m.tmdbId ? "id:" + m.tmdbId : "title:" + m.title + "|" + (m.year || "");
}

export function findByKey(list, key) {
  for (let i = 0; i < list.length; i++) {
    if (movieKey(list[i]) === key) return list[i];
  }
  return null;
}

// ── Cola de guardados pendientes (IndexedDB) ──
// Un guardado en el momento (fetch con retry/keepalive, ver
// fetchJsonWithRetry) sigue perdiéndose si la pestaña se cierra o Apps
// Script tarda más de lo que el navegador tolera (confirmado en
// producción). Por eso cada cambio se anota PRIMERO acá — vive en
// IndexedDB (no localStorage) porque el Service Worker (sw.js), que
// reintenta en segundo plano vía Background Sync incluso con todas las
// pestañas cerradas, no tiene acceso a localStorage. Misma base
// "cine-elo-db" que sw.js, así que cualquier página puede drenar lo que
// dejó otra.
export const IDB_NAME = "cine-elo-db";
export const IDB_STORE = "pendingSync";
export const FLUSH_INTERVAL_MS = 20000;

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function enqueuePendingSync(item) {
  item.id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  // El id lleva timestamp pero no es ordenable como string (el prefijo
  // random va primero) — sin un campo aparte, no hay forma de saber cuál de
  // dos pendientes para la misma peli es el más nuevo al reconciliar contra
  // un pull fresco, y a veces se terminaba aplicando el viejo encima.
  item.ts = Date.now();
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(item);
        tx.oncomplete = () => resolve(item.id);
        tx.onerror = () => reject(tx.error);
      })
  );
}

export function readPendingSync() {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      })
  );
}

export function removePendingSync(id) {
  return idbOpen().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      })
  );
}

// Guardados de una versión anterior (antes de migrar a IndexedDB) pueden
// haber quedado en el localStorage viejo — los movemos una sola vez para no
// perderlos.
export function migrateOldPendingSync() {
  try {
    const raw = localStorage.getItem("cine-elo-pending-sync");
    if (!raw) return Promise.resolve();
    const items = JSON.parse(raw) || [];
    localStorage.removeItem("cine-elo-pending-sync");
    return Promise.all(
      items.map((item) => {
        delete item.id;
        return enqueuePendingSync(item);
      })
    );
  } catch (e) {
    return Promise.resolve(); // nada que migrar o storage bloqueado
  }
}

// Le pide al navegador que reintente en segundo plano vía Service Worker —
// incluso con TODAS las pestañas cerradas, en cuanto haya conexión. Si el
// navegador no soporta Background Sync (ej. Safari/iPhone) no hace nada
// acá: igual queda el reintento al abrir cualquier página y el intervalo de
// flushPendingSync como red de contención.
export function requestBackgroundSync() {
  if (!("serviceWorker" in navigator) || !("SyncManager" in window)) return;
  navigator.serviceWorker.ready
    .then((reg) => reg.sync.register("flush-pending-sync"))
    .catch(() => {});
}

export function registerServiceWorker(swPath) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register(swPath || "sw.js").catch(() => {});
}

// Apps Script a veces deja un pedido colgado sin responder nunca
// (confirmado en producción) y a veces responde 200 con una página de error
// HTML en vez de JSON — fetch() no tiene timeout propio, así que sin esto
// un intento colgado nunca se resuelve ni se rechaza. keepalive evita que
// el navegador cancele el pedido si el usuario navega a otra página antes
// de que termine. 2 reintentos con backoff corto antes de dejarlo como
// está: si sigue en la cola, Background Sync/el intervalo lo reintentan.
export function fetchJsonWithRetry(url, options, retries, timeoutMs) {
  if (retries == null) retries = 2;
  if (timeoutMs == null) timeoutMs = 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchOptions = Object.assign({}, options, {
    signal: controller.signal,
    keepalive: true,
  });
  return fetch(url, fetchOptions)
    .then((r) => r.json())
    .finally(() => clearTimeout(timer))
    .catch((err) => {
      if (retries <= 0) throw err;
      return new Promise((resolve) => setTimeout(resolve, 500)).then(() =>
        fetchJsonWithRetry(url, options, retries - 1, timeoutMs)
      );
    });
}

export function postJson(payload, allowCreate) {
  const url = allowCreate ? SYNC_URL + "?allowCreate=1" : SYNC_URL;
  return fetchJsonWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
}

// Cola compartida (misma IndexedDB "cine-elo-db") entre las 4 páginas — este
// handler soporta TODOS los tipos que cualquiera de ellas pueda encolar, no
// solo los que encola la página actual, por si acá se drena un item que
// vino de otra pestaña.
export function syncPendingItem(item) {
  if (item.type === "setFields") {
    return fetchJsonWithRetry(
      SYNC_URL +
        "?action=setFields&tmdbId=" + encodeURIComponent(item.tmdbId || "") +
        "&title=" + encodeURIComponent(item.title || "") +
        "&year=" + encodeURIComponent(item.year || "") +
        "&changes=" + encodeURIComponent(JSON.stringify(item.changes)),
      {}
    );
  }
  if (item.type === "deleteMovie") {
    return postJson(
      { type: "deleteMovie", tmdbId: item.tmdbId || "", title: item.title, year: item.year },
      false
    );
  }
  if (item.type === "create") {
    return fetchJsonWithRetry(SYNC_URL + "?allowCreate=1", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify([item.payload]),
    });
  }
  return Promise.reject(new Error("tipo de pending sync desconocido: " + item.type));
}

// Se llama al montar cada página y cada FLUSH_INTERVAL_MS mientras siga
// abierta (red de contención para navegadores sin Background Sync, ej.
// Safari/iPhone, o mientras ese registro todavía no disparó). Devuelve una
// promesa que espera a que TODOS los intentos terminen (éxito o no) — quien
// llama puede esperarla antes de pedir un pull, para no traer de la Sheet
// un valor viejo mientras un guardado reciente todavía está en camino.
export function flushPendingSync() {
  return readPendingSync().then((queue) =>
    Promise.all(
      queue.map((item) =>
        syncPendingItem(item)
          .then((data) => {
            if (data && data.ok) return removePendingSync(item.id);
          })
          .catch(() => {
            // sigue en la cola: se reintenta la próxima vez.
          })
      )
    )
  );
}

// Encola ANTES de intentar mandarlo, e intenta mandarlo ya mismo — si eso
// falla queda en la cola sin avisarle a nadie (mismo trato silencioso que un
// duelo): Background Sync, el intervalo de flushPendingSync, o la próxima
// carga de cualquiera de las 4 páginas lo reintentan solos. onChange
// (opcional) se llama después de encolar y de nuevo si el intento inmediato
// se confirma, para que la página pueda refrescar un indicador de "cambios
// sin confirmar".
export function syncDurable(item, onChange) {
  return enqueuePendingSync(item).then((pendingId) => {
    if (onChange) onChange();
    requestBackgroundSync();
    return syncPendingItem(item)
      .then((data) => {
        if (data && data.ok) {
          return removePendingSync(pendingId).then(() => {
            if (onChange) onChange();
          });
        }
      })
      .catch((err) => {
        console.error(
          "Sync en segundo plano falló (queda pendiente, Background Sync reintentará):",
          item,
          err
        );
      });
  });
}
