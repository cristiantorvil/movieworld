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

// Rating 0/vacío = sin ver = watchlist. Mismo criterio que el backend
// (handlePullWatchlist: parseFloat con coma decimal, || 0) — una sola regla
// para decidir en qué modo (vistas/watchlist) aparece cada película.
export function parseRating(rating) {
  if (typeof rating === "number") return isFinite(rating) ? rating : 0;
  return parseFloat(String(rating == null ? "" : rating).replace(",", ".")) || 0;
}

export function isWatchlistMovie(m) {
  return !(parseRating(m && m.rating) > 0);
}

// Elo de arranque cuando la Sheet no tiene uno cargado todavía: vistas
// desde su rating, watchlist desde el promedio de TMDB.
export function defaultEloFor(m) {
  const rating = parseRating(m.rating);
  if (rating > 0) return computeInitialElo(rating, Number(m.plays) || 1);
  return computeWatchlistElo(m.voteAverage, m.voteCount);
}

function hasElo(v) {
  return v !== null && v !== undefined && v !== "" && isFinite(Number(v));
}

export function findByKey(list, key) {
  for (let i = 0; i < list.length; i++) {
    if (movieKey(list[i]) === key) return list[i];
  }
  return null;
}

// Campos de metadata de TMDB que viajan igual en todos lados (pull, push,
// merge, alta de película nueva). "numeric: true" son los que deben quedar
// en null (no "") cuando no hay dato, para no romper comparaciones.
export const META_FIELDS = [
  { key: "director" },
  { key: "genre" },
  { key: "poster" },
  { key: "tmdbId" },
  { key: "country" },
  { key: "originalLanguage" },
  { key: "runtime", numeric: true },
  { key: "overview" },
  { key: "collection" },
  { key: "productionCompanies" },
  { key: "voteAverage", numeric: true },
  { key: "voteCount", numeric: true },
  { key: "cast" },
  { key: "tagline" },
  { key: "backdrop" },
  { key: "imdbId" },
];

// Pisa los movies locales con lo que haya en el Sheet (progreso + metadata
// de TMDB), y agrega las que estén en el Sheet pero no localmente — misma
// lógica para Cine Elo (catálogo completo, pull-en-segundo-plano detrás de
// lo local) y Watchlist (antes tenía su propio loadWatchlist que reemplazaba
// todo de golpe en vez de mergear, y esperaba el pull entero antes de
// mostrar nada). Se usa tanto al abrir cada app como en cualquier botón de
// "restaurar/refrescar desde el Sheet".
//
// opts:
// - gamesKey: nombre del campo LOCAL que guarda el conteo de duelos
//   jugados (Cine Elo usa "comparisons", Watchlist usa "games" — el campo
//   del lado de la Sheet siempre se llama "games" en ambos endpoints).
// - metaFields: lista de META_FIELDS a mergear (default: la de arriba).
// - makeId: generador opcional de id local (ej. uid) para películas nuevas
//   que aparecen en la Sheet pero no existían localmente — Watchlist no
//   usa un id sintético (se identifica por movieKey), así que no lo pasa.
// - fallbackElo: cómo calcular el elo inicial de una peli sin elo_rating
//   en la Sheet todavía — default computeInitialElo(rating, plays) (Cine
//   Elo); Watchlist pasa computeWatchlistElo (usa vote_average de TMDB).
// Una misma película (mismo tmdbId, o mismo título si todavía no tiene)
// repetida en una lista local — típicamente un caché viejo de antes de que
// se borrara una fila duplicada en la Sheet — se colapsa a una sola. Se
// queda la que tenga más duelos jugados (la más "usada"); el merge siguiente
// contra la Sheet le pisa el elo/duelos con el valor real igual.
export function dedupeMovies(list) {
  const byKey = new Map();
  list.forEach((m) => {
    const key = m.tmdbId ? "id:" + m.tmdbId : "title:" + m.title;
    const prev = byKey.get(key);
    const games = (x) => Number(x.games != null ? x.games : x.comparisons) || 0;
    if (!prev || games(m) > games(prev)) byKey.set(key, m);
  });
  return list.length === byKey.size ? list : Array.from(byKey.values());
}

export function mergeSheetIntoMovies(localMovies, sheetMovies, opts) {
  localMovies = dedupeMovies(localMovies);
  const o = opts || {};
  const gamesKey = o.gamesKey || "comparisons";
  const metaFields = o.metaFields || META_FIELDS;
  const makeId = o.makeId || null;
  const fallbackElo = o.fallbackElo || defaultEloFor;

  // Apps Script confirmadamente falla de forma intermitente (se cuelga, o
  // devuelve una página de error) — si ALGUNA vez esa falla se cuela como
  // un pull "exitoso" pero con muy pocas filas (respuesta cortada a mitad,
  // etc.), lo de abajo filtra el catálogo local entero contra eso y borra
  // todo lo que no aparezca. Eso pasó de verdad: dejó el catálogo local en
  // 0-1 películas, persistido para siempre. Un pull legítimo nunca debería
  // traer drásticamente MENOS de lo que ya hay guardado — si pasa, no es la
  // Sheet real, es una respuesta mala, y no la usamos.
  if (sheetMovies.length === 0 || (localMovies.length > 0 && sheetMovies.length < localMovies.length * 0.5)) {
    console.error(
      `mergeSheetIntoMovies: pull sospechoso (${sheetMovies.length} filas vs. ` +
        `${localMovies.length} locales) — se ignora para no perder el catálogo local.`
    );
    return { merged: localMovies, updatedCount: 0, newCount: 0, skipped: true };
  }

  // tmdbId es el identificador primario — dos películas con el mismo título
  // (ej. "Wuthering Heights" 1939/2011) tienen tmdbId distinto y no deben
  // pisarse entre sí. title solo es fallback para filas sin tmdbId todavía.
  const sheetById = new Map(
    sheetMovies.filter((m) => m.tmdbId).map((m) => [String(m.tmdbId), m])
  );
  const sheetByTitle = new Map(
    sheetMovies.filter((m) => !m.tmdbId).map((m) => [m.title, m])
  );
  const localIds = new Set(
    localMovies.filter((m) => m.tmdbId).map((m) => String(m.tmdbId))
  );
  const localTitlesNoId = new Set(
    localMovies.filter((m) => !m.tmdbId).map((m) => m.title)
  );
  function findSheetMatch(m) {
    return m.tmdbId ? sheetById.get(String(m.tmdbId)) : sheetByTitle.get(m.title);
  }
  let updatedCount = 0;

  // El pull siempre trae el estado completo del Sheet, así que una peli
  // local que ya no aparece ahí fue borrada (o, en Watchlist, puntuada —
  // pullWatchlist deja de devolverla) y hay que sacarla de la caché local.
  const next = localMovies
    .filter((m) => !!findSheetMatch(m))
    .map((m) => {
      const existing = findSheetMatch(m);
      updatedCount++;
      const merged = { ...m };
      metaFields.forEach(({ key }) => {
        merged[key] = existing[key] || m[key];
      });
      // title/year: la Sheet es la fuente de verdad ahora que el match es
      // por tmdbId — una limpieza de título hecha del lado del backend
      // (ej. sacar el "(AÑO)" pegado al nombre) tiene que llegar acá.
      merged.title = existing.title || m.title;
      merged.year = existing.year || m.year;
      merged.rating = existing.rating != null ? existing.rating : m.rating;
      merged.plays = existing.plays != null ? existing.plays : m.plays;
      // Celda de elo vacía en la Sheet (fila recién agregada a mano, por
      // ejemplo): se conserva el local si hay, y si no se calcula — antes
      // llegaba "" y la peli quedaba con elo vacío, ordenada como si fuera 0.
      merged.elo = hasElo(existing.elo)
        ? Number(existing.elo)
        : hasElo(m.elo)
        ? Number(m.elo)
        : fallbackElo(existing);
      merged[gamesKey] = Number(existing.games) || 0;
      merged.wins = Number(existing.wins) || 0;
      merged.losses = existing.losses != null ? existing.losses : m.losses;
      merged.ties = existing.ties != null ? existing.ties : m.ties;
      return merged;
    });

  const newOnes = [];
  sheetMovies.forEach((sm) => {
    if (!sm.title) return;
    const already = sm.tmdbId ? localIds.has(String(sm.tmdbId)) : localTitlesNoId.has(sm.title);
    if (already) return;
    const movie = Object.assign(
      makeId ? { id: makeId() } : {},
      {
        title: sm.title,
        year: sm.year || undefined,
        rating: sm.rating,
        plays: sm.plays,
        elo: hasElo(sm.elo) ? Number(sm.elo) : fallbackElo(sm),
        wins: Number(sm.wins) || 0,
        losses: sm.losses || 0,
        ties: sm.ties || 0,
      }
    );
    movie[gamesKey] = Number(sm.games) || 0;
    metaFields.forEach(({ key, numeric }) => {
      movie[key] = sm[key] || (numeric ? null : "");
    });
    newOnes.push(movie);
  });

  return { merged: [...next, ...newOnes], updatedCount, newCount: newOnes.length };
}

// Sube el estado LOCAL completo (elo/duelos/wins/losses + META_FIELDS) de
// cada película al Sheet, pisando lo que haya ahí — para cuando el local es
// la fuente de verdad real y el Sheet quedó atrás. Caso confirmado: duelos
// seguidos sobre la misma peli mandados en paralelo (antes del fix de
// runSerializedPerMovie en syncDurable) podían llegar desordenados y dejar
// escrito un elo_games más viejo aunque cada pedido individual haya
// contestado ok:true — nada queda "pendiente" en ese caso, así que ni
// flushPendingSync ni "Sincronizar ahora" lo detectan ni lo corrigen. Esto
// es la vía de recuperación manual para ese escenario.
//
// NUNCA crea filas nuevas (no manda allowCreate=1): solo pisa las que ya
// matchean por tmdbId o título+año en el Sheet; cualquier película local
// sin match ahí vuelve en `skipped`, intacta, para que se pueda revisar.
// Manda de a `chunkSize` por pedido (default 100, igual que Cine Elo),
// secuencial — nunca en paralelo, mismo motivo que flushPendingSync.
export function bulkPushToSheet(movies, opts) {
  const o = opts || {};
  const gamesKey = o.gamesKey || "comparisons";
  const metaFields = o.metaFields || META_FIELDS;
  const chunkSize = o.chunkSize || 100;
  const onProgress = o.onProgress;

  const payload = movies.map((m) => {
    const item = {
      title: m.title,
      year: m.year || "",
      elo: m.elo,
      games: m[gamesKey] || 0,
      wins: m.wins || 0,
      losses: m.losses != null ? m.losses : (m[gamesKey] || 0) - (m.wins || 0),
      ties: m.ties || 0,
    };
    metaFields.forEach(({ key }) => {
      item[key] = m[key] || "";
    });
    return item;
  });

  const chunks = [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    chunks.push(payload.slice(i, i + chunkSize));
  }

  const stats = { done: 0, total: chunks.length, updated: 0, skipped: 0 };
  if (onProgress) onProgress(Object.assign({}, stats));
  let chain = Promise.resolve();
  chunks.forEach((chunk) => {
    chain = chain.then(() =>
      postJson(chunk, false, 20000).then((data) => {
        stats.done++;
        if (data) {
          stats.updated += (data.updated || []).length;
          stats.skipped += (data.skipped || []).length;
        }
        if (onProgress) onProgress(Object.assign({}, stats));
      })
    );
  });
  return chain.then(() => stats);
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

// Una sola conexión reutilizada (antes se abría una NUEVA en cada lectura/
// escritura y nunca se cerraba — cientos por sesión con el flush cada 20s).
// En el celular el navegador corta las conexiones de IndexedDB cuando la
// pestaña pasa a segundo plano ("Connection to Indexed Database server
// lost"); la próxima operación fallaba y, sin nadie que capturara ese
// rechazo, watchlist.html mostraba "Algo se rompió" — la pantalla que se
// veía tan seguido. Ahora la conexión se descarta al cerrarse y cada
// operación reintenta una vez con una conexión nueva antes de rendirse.
let dbPromise = null;

function idbOpen() {
  if (dbPromise) return dbPromise;
  const p = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(IDB_NAME, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        if (dbPromise === p) dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        if (dbPromise === p) dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB bloqueada por otra pestaña"));
  });
  dbPromise = p;
  p.catch(() => {
    if (dbPromise === p) dbPromise = null;
  });
  return p;
}

// Corre fn(db) y, si falla (conexión muerta, transacción abortada), tira la
// conexión cacheada y reintenta una vez con una nueva.
function withDb(fn) {
  return idbOpen()
    .then(fn)
    .catch(() => {
      dbPromise = null;
      return idbOpen().then(fn);
    });
}

export function enqueuePendingSync(item) {
  item.id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  // El id lleva timestamp pero no es ordenable como string (el prefijo
  // random va primero) — sin un campo aparte, no hay forma de saber cuál de
  // dos pendientes para la misma peli es el más nuevo al reconciliar contra
  // un pull fresco, y a veces se terminaba aplicando el viejo encima.
  item.ts = Date.now();
  return withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(item);
        tx.oncomplete = () => resolve(item.id);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("transacción abortada"));
      })
  );
}

export function readPendingSync() {
  return withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error || new Error("transacción abortada"));
      })
  );
}

export function removePendingSync(id) {
  return withDb(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("transacción abortada"));
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

export function postJson(payload, allowCreate, timeoutMs) {
  const url = allowCreate ? SYNC_URL + "?allowCreate=1" : SYNC_URL;
  return fetchJsonWithRetry(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    },
    2,
    timeoutMs
  );
}

// Cola compartida (misma IndexedDB "cine-elo-db") entre las 4 páginas — este
// handler soporta TODOS los tipos que cualquiera de ellas pueda encolar, no
// solo los que encola la página actual, por si acá se drena un item que
// vino de otra pestaña.
//
// 20s de timeout (el doble del default) en vez de los 10s de fetchJsonWithRetry
// — confirmado en producción (2026-09-27) que bajo carga Apps Script puede
// tardar más que eso en contestar un setFields, y con el default más corto
// esto abortaba antes de tiempo en cada uno de los 2 reintentos, dejando
// items que quizás sí hubieran llegado a confirmarse con un poco más de
// margen atascados en la cola para siempre.
const PENDING_SYNC_TIMEOUT_MS = 20000;

// ── Resultado de duelo (mismo camino para Cine Elo y Watchlist) ──
// Antes cada página escribía los duelos distinto: Cine Elo con un POST
// suelto (sin cola, sin reintento — si fallaba se perdía) y Watchlist con
// setFields columna por columna vía la cola durable. Ahora las dos encolan
// un "syncElo" con el estado completo de elo/duelos de cada película, que se
// manda por el mismo POST por lotes de siempre (solo actualiza filas que ya
// existen, nunca crea). expectRated le dice al backend si la peli estaba
// vista o en watchlist al jugarse el duelo: si para cuando llega el guardado
// eso cambió (ej. un duelo de watchlist atrasado que llega después de
// "Marcar como vista"), el backend lo ignora en vez de pisar el elo nuevo.
// opts.allowDecrease: solo para "deshacer duelo" — el backend ignora un
// guardado de duelo con MENOS duelos que los que ya tiene la fila (es uno
// viejo que llegó tarde, ej. el Service Worker reenviando un pendiente
// después de que ya llegó uno más nuevo), salvo que venga con esta marca.
export function makeEloSyncItem(m, gamesKey, opts) {
  const games = Number(m[gamesKey || "comparisons"]) || 0;
  const wins = Number(m.wins) || 0;
  return {
    type: "syncElo",
    tmdbId: m.tmdbId || "",
    title: m.title,
    year: m.year || "",
    elo: m.elo,
    games,
    wins,
    losses: Math.max(games - wins, 0),
    expectRated: !isWatchlistMovie(m),
    allowDecrease: !!(opts && opts.allowDecrease),
  };
}

function eloPayload(item) {
  return {
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
  };
}

export function syncPendingItem(item) {
  if (item.type === "setFields") {
    return fetchJsonWithRetry(
      SYNC_URL +
        "?action=setFields&tmdbId=" + encodeURIComponent(item.tmdbId || "") +
        "&title=" + encodeURIComponent(item.title || "") +
        "&year=" + encodeURIComponent(item.year || "") +
        "&changes=" + encodeURIComponent(JSON.stringify(item.changes)),
      {},
      2,
      PENDING_SYNC_TIMEOUT_MS
    );
  }
  if (item.type === "syncElo") {
    return postJson([eloPayload(item)], false, PENDING_SYNC_TIMEOUT_MS);
  }
  if (item.type === "deleteMovie") {
    return postJson(
      { type: "deleteMovie", tmdbId: item.tmdbId || "", title: item.title, year: item.year },
      false,
      PENDING_SYNC_TIMEOUT_MS
    );
  }
  if (item.type === "create") {
    return fetchJsonWithRetry(
      SYNC_URL + "?allowCreate=1",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify([item.payload]),
      },
      2,
      PENDING_SYNC_TIMEOUT_MS
    );
  }
  return Promise.reject(new Error("tipo de pending sync desconocido: " + item.type));
}

// Tope de items que un solo flush intenta mandar. Con una cola grande
// (cientos/miles de cambios acumulados durante una caída del backend o una
// mala racha de cuota de Apps Script) mandarlos TODOS de una — como hacía
// esto antes, vía Promise.all — satura tanto el límite de conexiones
// simultáneas del navegador como la cuota de "ejecuciones simultáneas" de
// Apps Script, y arma un bucle que se autoalimenta: todo falla por cuota,
// nada se saca de la cola, y FLUSH_INTERVAL_MS después se vuelve a mandar
// el mismo backlog entero de golpe, otra vez. Un backlog de miles de items
// confirmado en producción por esto mismo. Con un tope chico, cada pasada
// hace progreso real y deja cuota libre para el resto de la app (el pull
// normal de la página, por ejemplo).
const FLUSH_BATCH_SIZE = 25;

// Con una cola grande, una sola pasada (25 items secuenciales, cada uno con
// hasta 2 reintentos de por sí) puede tardar más que FLUSH_INTERVAL_MS en
// terminar. Sin esta guarda, el setInterval de más abajo dispara una pasada
// NUEVA encima de la anterior todavía en curso — y con varias pasadas
// solapadas ya se vuelve a tener varios pedidos en simultáneo, el mismo
// problema que el batching de arriba busca evitar. Un solo flush a la vez;
// si ya hay uno en curso, esta llamada espera ESE mismo en vez de arrancar
// otro.
let flushInFlight = null;

// Se llama al montar cada página y cada FLUSH_INTERVAL_MS mientras siga
// abierta (red de contención para navegadores sin Background Sync, ej.
// Safari/iPhone, o mientras ese registro todavía no disparó). Manda los
// items UNO A LA VEZ (nunca en paralelo, ver FLUSH_BATCH_SIZE arriba),
// del más viejo al más nuevo. Devuelve una promesa que espera a que todos
// los intentos de esta pasada terminen (éxito o no) — quien llama puede
// esperarla antes de pedir un pull, para no traer de la Sheet un valor
// viejo mientras un guardado reciente todavía está en camino.
export function flushPendingSync() {
  if (flushInFlight) return flushInFlight;
  const current = readPendingSync()
    .then((queue) => {
      const batch = coalescePending(queue).slice(0, FLUSH_BATCH_SIZE);
      let chain = Promise.resolve();
      batch.forEach((group) => {
        chain = chain.then(() =>
          runSerializedPerMovie(group.item, () => syncPendingItem(group.item))
            .then((data) => {
              if (data && data.ok) return removeGroup(group);
            })
            .catch(() => {
              // sigue en la cola: se reintenta la próxima vez.
            })
        );
      });
      return chain;
    })
    // Nunca rechaza: se llama desde un setInterval sin nadie que capture el
    // error (IndexedDB caída, por ejemplo) — lo que quede en la cola se
    // reintenta en la próxima pasada igual.
    .catch((err) => {
      console.error("flushPendingSync falló (se reintenta en la próxima pasada):", err);
    })
    .finally(() => {
      if (flushInFlight === current) flushInFlight = null;
    });
  flushInFlight = current;
  return current;
}

// Junta los setFields consecutivos de una MISMA película que son solo
// duelos (sin tocar "rating") en un único pedido, con el último valor de
// cada columna — una peli que duelea 30 veces mientras el backend está
// caído deja 30 items en la cola que dicen todos lo mismo salvo por el
// elo final, y mandarlos uno por uno multiplica x30 el trabajo (y la
// cuota) sin cambiar el resultado. Cualquier otra cosa (un cambio de
// rating = "marcar como vista", un borrado, un alta) corta el grupo, así
// el orden entre esos y los duelos de la misma peli se respeta. Devuelve
// [{item, ids}]: el item a mandar y los ids de la cola que cubre (todos se
// sacan de la cola juntos si el pedido se confirma).
function coalescePending(queue) {
  const sorted = queue.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const groups = [];
  // movieKey -> grupo todavía abierto. Un grupo solo junta items seguidos
  // del MISMO tipo mergeable para esa peli: cualquier otra cosa en el medio
  // (rating, borrado, alta, o el otro tipo de duelo) lo cierra, así el orden
  // entre ellos se respeta tal cual se encolaron.
  const open = new Map();
  sorted.forEach((item) => {
    const key = movieKey(item);
    const isDuelOnly =
      item.type === "setFields" &&
      Array.isArray(item.changes) &&
      !item.changes.some((c) => c.col === "rating");
    // syncElo trae el estado COMPLETO de elo/duelos — el último pisa a los
    // anteriores sin perder nada.
    const isEloSnapshot = item.type === "syncElo";
    const mergeType = isDuelOnly ? "fields" : isEloSnapshot ? "elo" : null;
    const g = open.get(key);
    if (mergeType && g && g.mergeType === mergeType) {
      if (mergeType === "fields") {
        item.changes.forEach((c) => {
          g.byCol[c.col] = c.value;
        });
      } else {
        g.latest = item;
      }
      g.ids.push(item.id);
      return;
    }
    const group = { item, ids: [item.id], byCol: null, latest: null, mergeType };
    if (mergeType === "fields") {
      group.byCol = {};
      item.changes.forEach((c) => {
        group.byCol[c.col] = c.value;
      });
    }
    if (mergeType) open.set(key, group);
    else open.delete(key);
    groups.push(group);
  });
  return groups.map((g) => {
    if (g.byCol) {
      return {
        item: Object.assign({}, g.item, {
          changes: Object.keys(g.byCol).map((col) => ({ col, value: g.byCol[col] })),
        }),
        ids: g.ids,
      };
    }
    return { item: g.latest || g.item, ids: g.ids };
  });
}

function removeGroup(group) {
  return Promise.all(group.ids.map((id) => removePendingSync(id)));
}

// Botón "Sincronizar ahora": vacía TODA la cola (ya coalescida) en lugar
// de los 25 por pasada del flush de fondo, siempre de a un pedido por vez.
// Se corta sola tras 5 fallas seguidas de red/timeout (Apps Script caído o
// sin cuota: seguir pegándole no ayuda y gasta más cuota) — pero un
// rechazo explícito de la Sheet (ok:false, ej. la peli ya no existe) NO
// cuenta como falla de red: el item queda en la cola (nunca se descarta
// en silencio) y se sigue con el siguiente. onProgress({done,total,failed,
// rejected}) se llama tras cada pedido. Resuelve con el resumen final.
export function flushAllPending(onProgress) {
  const MAX_CONSECUTIVE_FAILS = 5;
  const run = () =>
    readPendingSync().then((queue) => {
      const groups = coalescePending(queue);
      const stats = { done: 0, total: groups.length, failed: 0, rejected: 0, stopped: false };
      let consecutiveFails = 0;
      if (onProgress) onProgress(Object.assign({}, stats));
      let chain = Promise.resolve();
      groups.forEach((group) => {
        chain = chain.then(() => {
          if (stats.stopped) return;
          return runSerializedPerMovie(group.item, () => syncPendingItem(group.item))
            .then((data) => {
              if (data && data.ok) {
                consecutiveFails = 0;
                stats.done++;
                return removeGroup(group);
              }
              consecutiveFails = 0;
              stats.rejected++;
            })
            .catch(() => {
              stats.failed++;
              consecutiveFails++;
              if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) stats.stopped = true;
            })
            .then(() => {
              if (onProgress) onProgress(Object.assign({}, stats));
            });
        });
      });
      return chain.then(() => stats);
    });
  const previous = flushInFlight ? flushInFlight.catch(() => {}) : Promise.resolve();
  const current = previous.then(run).finally(() => {
    if (flushInFlight === current) flushInFlight = null;
  });
  flushInFlight = current;
  return current;
}

// Varios duelos seguidos sobre la MISMA película (normal: el modo rápido
// dueleea la misma peli varias veces antes de que el primer guardado
// confirme) cada uno dispara su propio intento inmediato acá abajo — sin
// esto, esos pedidos viajan en paralelo y pueden llegar a Apps Script
// DESORDENADOS (quién gana la carrera de red no tiene por qué ser quién
// salió último), y el que escribe último en la Sheet pisa a los demás con
// SU valor de elo_games, no necesariamente el más alto. Cada uno reporta
// ok:true individualmente (escribió algo, solo que no lo último) así que
// nunca queda nada pendiente ni ningún aviso — la Sheet simplemente se
// queda con un conteo de duelos más bajo que el real, en silencio. Confirmado
// en producción: un navegador mostraba 339 duelos jugados para "I Am Cuba",
// la Sheet tenía 324. Esta cola serializa los intentos inmediatos por
// película (nunca entre películas distintas) para que siempre salgan en el
// mismo orden en que se encolaron.
const inFlightByMovie = new Map();

function runSerializedPerMovie(item, task) {
  const key = movieKey(item);
  const previous = inFlightByMovie.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  inFlightByMovie.set(key, current);
  current.finally(() => {
    if (inFlightByMovie.get(key) === current) inFlightByMovie.delete(key);
  });
  return current;
}

// Encola ANTES de intentar mandarlo, e intenta mandarlo ya mismo — si eso
// falla queda en la cola sin avisarle a nadie (mismo trato silencioso que un
// duelo): Background Sync, el intervalo de flushPendingSync, o la próxima
// carga de cualquiera de las 4 páginas lo reintentan solos. onChange
// (opcional) se llama después de encolar y de nuevo si el intento inmediato
// se confirma, para que la página pueda refrescar un indicador de "cambios
// sin confirmar".
// Resuelve siempre (nunca rechaza) con {ok, error?} — el intento inmediato
// puede fallar sin que eso sea un error del llamador: el item ya quedó
// encolado durable, así que Background Sync/el próximo flush lo reintentan
// solos pase lo que pase acá. Páginas que no necesitan saber si confirmó ya
// (la mayoría: duelos, ratings) ignoran el valor devuelto como siempre;
// removeMovie en watchlist.html sí lo mira, para no dejar un borrado fallido
// en silencio (ver el comentario ahí — antes la peli desaparecía de la
// vista igual, aunque el borrado nunca hubiera llegado a la Sheet).
export function syncDurable(item, onChange) {
  const send = () => runSerializedPerMovie(item, () => syncPendingItem(item));
  return enqueuePendingSync(item)
    .then(
      (pendingId) => pendingId,
      (err) => {
        // IndexedDB no disponible (modo privado, storage lleno, conexión
        // perdida): no hay cola durable, pero igual se intenta mandar ya.
        console.error("No se pudo encolar el guardado, se manda sin cola:", item, err);
        return null;
      }
    )
    .then((pendingId) => {
      if (onChange) onChange();
      if (pendingId) requestBackgroundSync();
      return send()
        .then((data) => {
          if (data && data.ok) {
            const cleanup = pendingId ? removePendingSync(pendingId).catch(() => {}) : Promise.resolve();
            return cleanup.then(() => {
              if (onChange) onChange();
              return { ok: true, data };
            });
          }
          return { ok: false, error: (data && data.error) || "la Sheet rechazó el cambio" };
        })
        .catch((err) => {
          console.error(
            "Sync en segundo plano falló (queda pendiente, Background Sync reintentará):",
            item,
            err
          );
          return { ok: false, error: String((err && err.message) || err) };
        });
    });
}

// Aplica la cola pendiente sobre un pull fresco de la Sheet ANTES de
// mergearlo: un cambio recién encolado puede no haber llegado todavía a la
// Sheet, y sin esto el pull lo "deshacía" en pantalla (una peli borrada que
// reaparece, un duelo que vuelve al elo anterior, una marcada como vista que
// vuelve a la watchlist). Trabaja con los nombres de campo del pull (games,
// rating, plays...). Nunca rechaza: si la cola no se puede leer, devuelve el
// pull tal cual.
const SETFIELDS_COL_TO_PULL_KEY = {
  rating: "rating",
  diary_count: "plays",
  elo_rating: "elo",
  elo_games: "games",
  elo_win: "wins",
  elo_loss: "losses",
  director: "director",
  poster_path: "poster",
  genre: "genre",
  country: "country",
  year: "year",
};

export function reconcileWithPending(sheetMovies) {
  return readPendingSync()
    .then((queue) => {
      if (!queue.length) return sheetMovies;
      const sorted = queue.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const byKey = new Map();
      sheetMovies.forEach((m) => byKey.set(movieKey(m), Object.assign({}, m)));
      sorted.forEach((item) => {
        if (item.type === "create" && item.payload) {
          const k = movieKey(item.payload);
          if (!byKey.has(k)) byKey.set(k, Object.assign({}, item.payload));
          return;
        }
        const key = movieKey(item);
        if (item.type === "deleteMovie") {
          byKey.delete(key);
          return;
        }
        const m = byKey.get(key);
        if (!m) return;
        if (item.type === "syncElo") {
          // Mismo guard que el backend: si la peli cambió de vista a
          // watchlist (o al revés) después de este duelo, no aplica.
          if (item.expectRated != null && item.expectRated === isWatchlistMovie(m)) return;
          if (!item.allowDecrease && Number(item.games) < (Number(m.games) || 0)) return;
          m.elo = item.elo;
          m.games = item.games;
          m.wins = item.wins;
          m.losses = item.losses;
        } else if (item.type === "setFields" && Array.isArray(item.changes)) {
          // Mismo guard que handleSetFields en el backend: a una peli ya
          // vista no se le pisan elo/duelos salvo que el mismo cambio traiga
          // el rating (un duelo de watchlist viejo que llega tarde).
          const touchesRating = item.changes.some((c) => c.col === "rating");
          item.changes.forEach((c) => {
            if (!touchesRating && !isWatchlistMovie(m) && /^elo_/.test(c.col)) return;
            const k = SETFIELDS_COL_TO_PULL_KEY[c.col];
            if (k) m[k] = c.value;
          });
        }
      });
      return Array.from(byKey.values());
    })
    .catch(() => sheetMovies);
}
