function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data && data.type === 'snapshot') {
      return handleSnapshot(data);
    }

    if (data && data.type === 'createSheet') {
      return handleCreateSheet(data);
    }

    if (data && data.type === 'deleteMovie') {
      return handleDeleteMovie(data.title);
    }

    var items = Array.isArray(data) ? data : [data];

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('MOVIES');
    var values = sheet.getDataRange().getValues();
    var header = values[0];

    var titleCol = header.indexOf('movie');
    var eloCol = header.indexOf('elo_rating');
    var gamesCol = header.indexOf('elo_games');
    var winCol = header.indexOf('elo_win');
    var lossCol = header.indexOf('elo_loss');
    var tieCol = header.indexOf('elo_tie');

    // Campos que solo se completan si la celda está vacía (no pisan
    // curación manual hecha directo en la Sheet). elo/games/wins/losses/
    // ties son distintos: esos SIEMPRE se actualizan, van aparte abajo.
    var fillFields = [
      { col: header.indexOf('id'), key: 'tmdbId' },
      { col: header.indexOf('year'), key: 'year' },
      { col: header.indexOf('director'), key: 'director' },
      { col: header.indexOf('genre'), key: 'genre' },
      { col: header.indexOf('poster_path'), key: 'poster' },
      { col: header.indexOf('country'), key: 'country' },
      { col: header.indexOf('original_language'), key: 'originalLanguage' },
      { col: header.indexOf('runtime'), key: 'runtime' },
      { col: header.indexOf('overview'), key: 'overview' },
      { col: header.indexOf('collection'), key: 'collection' },
      { col: header.indexOf('production_companies'), key: 'productionCompanies' },
      { col: header.indexOf('vote_average'), key: 'voteAverage' },
      { col: header.indexOf('vote_count'), key: 'voteCount' },
      { col: header.indexOf('cast'), key: 'cast' },
      { col: header.indexOf('tagline'), key: 'tagline' },
      { col: header.indexOf('backdrop_path'), key: 'backdrop' },
      { col: header.indexOf('imdb_id'), key: 'imdbId' },
    ].filter(function (f) { return f.col > -1; });

    var titleToRow = {};
    for (var i = 1; i < values.length; i++) {
      titleToRow[values[i][titleCol]] = i + 1;
    }

    var updated = [];
    var created = [];

    items.forEach(function (item) {
      var rowIndex = titleToRow[item.title];

      if (!rowIndex) {
        var newRow = new Array(header.length).fill('');
        newRow[titleCol] = item.title;
        fillFields.forEach(function (f) {
          if (item[f.key]) newRow[f.col] = item[f.key];
        });
        if (eloCol > -1) newRow[eloCol] = item.elo;
        if (gamesCol > -1) newRow[gamesCol] = item.games;
        if (winCol > -1) newRow[winCol] = item.wins;
        if (lossCol > -1) newRow[lossCol] = item.losses;
        if (tieCol > -1) newRow[tieCol] = item.ties || 0;

        sheet.appendRow(newRow);
        titleToRow[item.title] = sheet.getLastRow();
        created.push(item.title);
        return;
      }

      fillFields.forEach(function (f) {
        if (!item[f.key]) return;
        var cell = sheet.getRange(rowIndex, f.col + 1);
        if (!cell.getValue()) cell.setValue(item[f.key]);
      });
      if (eloCol > -1) sheet.getRange(rowIndex, eloCol + 1).setValue(item.elo);
      if (gamesCol > -1) sheet.getRange(rowIndex, gamesCol + 1).setValue(item.games);
      if (winCol > -1) sheet.getRange(rowIndex, winCol + 1).setValue(item.wins);
      if (lossCol > -1) sheet.getRange(rowIndex, lossCol + 1).setValue(item.losses);
      if (tieCol > -1) sheet.getRange(rowIndex, tieCol + 1).setValue(item.ties || 0);
      updated.push(item.title);
    });

    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, updated: updated, created: created })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleDebugSheet(name) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: 'sheet not found: ' + name })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    var values = sheet.getRange(1, 1, Math.min(5, lastRow), lastCol).getValues();
    return ContentService.createTextOutput(
      JSON.stringify({
        ok: true,
        gid: sheet.getSheetId(),
        lastRow: lastRow,
        lastCol: lastCol,
        sample: values,
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleCreateSheet(data) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var name = data.sheetName;
    var headers = data.headers || [];
    var rows = data.rows || [];

    var sheet = ss.getSheetByName(name);
    if (sheet) {
      ss.deleteSheet(sheet);
    }
    sheet = ss.insertSheet(name);

    if (headers.length > 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }

    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, sheet: name, rows: rows.length })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleDeleteMovie(title) {
  try {
    if (!title) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: 'Falta el título a borrar.' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('MOVIES');
    var values = sheet.getDataRange().getValues();
    var titleCol = values[0].indexOf('movie');
    for (var i = 1; i < values.length; i++) {
      if (String(values[i][titleCol]) === title) {
        sheet.deleteRow(i + 1);
        return ContentService.createTextOutput(
          JSON.stringify({ ok: true, deleted: title })
        ).setMimeType(ContentService.MimeType.JSON);
      }
    }
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: 'No se encontró "' + title + '" en la Sheet.' })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleSnapshot(data) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('HISTORY');
    if (!sheet) {
      sheet = ss.insertSheet('HISTORY');
      sheet.appendRow(['timestamp', 'movie', 'tmdb_id', 'rank', 'elo']);
    }
    var tsChile = Utilities.formatDate(
      new Date(data.timestamp),
      'America/Santiago',
      'yyyy-MM-dd HH:mm:ss'
    );
    var entries = data.entries || [];
    var rows = entries.map(function (e) {
      return [tsChile, e.title, e.tmdbId || '', e.rank, e.elo];
    });
    if (rows.length > 0) {
      var startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, rows.length, 5).setValues(rows);
    }
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, snapshotRows: rows.length })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'pull') {
    return handlePull();
  }
  if (e && e.parameter && e.parameter.action === 'pullHistory') {
    return handlePullHistory();
  }
  if (e && e.parameter && e.parameter.action === 'tmdbSearch') {
    return handleTmdbSearch(e.parameter.query || '');
  }
  if (e && e.parameter && e.parameter.action === 'tmdbDetails') {
    return handleTmdbDetails(e.parameter.id || '');
  }
  if (e && e.parameter && e.parameter.action === 'debugSheet') {
    return handleDebugSheet(e.parameter.name || '');
  }
  if (e && e.parameter && e.parameter.action === 'addColumns') {
    try {
      agregarColumnasMovies_();
      return ContentService.createTextOutput(
        JSON.stringify({ ok: true })
      ).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: String(err) })
      ).setMimeType(ContentService.MimeType.JSON);
    }
  }
  if (e && e.parameter && e.parameter.action === 'backfillStart') {
    return handleBackfillStart(e.parameter.force === 'true');
  }
  if (e && e.parameter && e.parameter.action === 'backfillStatus') {
    return handleBackfillStatus();
  }
  if (e && e.parameter && e.parameter.action === 'backfillStop') {
    return handleBackfillStop();
  }
  if (e && e.parameter && e.parameter.action === 'backfillRunOnce') {
    return handleBackfillRunOnce(e.parameter.force === 'true');
  }
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, msg: "Cine Elo webhook activo" })
  ).setMimeType(ContentService.MimeType.JSON);
}

// Mismas acciones que iniciarBackfillTmdb/progresoBackfillTmdb/
// detenerBackfillTmdb, pero accesibles por URL (desde el celu, sin pasar
// por el editor de Apps Script). backfillStart corre el primer lote antes
// de responder, así que la respuesta puede tardar un rato.
function handleBackfillStart(force) {
  try {
    if (force) {
      var props = PropertiesService.getScriptProperties();
      props.setProperty(BACKFILL_ROW_PROP, '2');
      props.setProperty(BACKFILL_FORCE_PROP, 'true');
    }
    iniciarBackfillTmdb(false);
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, force: !!force, progreso: _backfillProgreso_() })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleBackfillStatus() {
  try {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, progreso: _backfillProgreso_() })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleBackfillStop() {
  try {
    detenerBackfillTmdb();
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, progreso: _backfillProgreso_() })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// Diagnóstico: corre backfillTmdbBatch_ una vez, sincrónico, y devuelve el
// error completo (con stack) si explota — para ver qué está pasando cuando
// el trigger falla en silencio y no queda otra forma de ver el log.
function handleBackfillRunOnce(force) {
  try {
    if (force) {
      var props = PropertiesService.getScriptProperties();
      props.setProperty(BACKFILL_ROW_PROP, '2');
      props.setProperty(BACKFILL_FORCE_PROP, 'true');
    }
    var resultado = backfillTmdbBatch_();
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, progreso: _backfillProgreso_(), debug: resultado ? resultado.debug : null })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({
        ok: false,
        error: String(err),
        stack: err && err.stack ? String(err.stack) : null,
      })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function compartirHojaPublica() {
  var id = SpreadsheetApp.getActiveSpreadsheet().getId();
  DriveApp.getFileById(id).setSharing(
    DriveApp.Access.ANYONE_WITH_LINK,
    DriveApp.Permission.VIEW
  );
  Logger.log('Listo: hoja compartida como "cualquiera con el enlace: lector".');
}

// Utilidad manual: correr una sola vez para agregar las columnas nuevas de
// metadata de TMDB a MOVIES (país, idioma, duración, sinopsis, saga,
// productoras). Es idempotente: si una columna ya existe, no la duplica.
function agregarColumnasMovies_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('MOVIES');
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var nuevas = [
    'country',
    'original_language',
    'runtime',
    'overview',
    'collection',
    'production_companies',
    'vote_average',
    'vote_count',
    'cast',
    'tagline',
    'backdrop_path',
    'imdb_id',
  ];
  var aAgregar = nuevas.filter(function (n) {
    return header.indexOf(n) === -1;
  });
  if (aAgregar.length === 0) {
    Logger.log('Ya estaban todas las columnas.');
    return;
  }
  sheet
    .getRange(1, header.length + 1, 1, aAgregar.length)
    .setValues([aAgregar]);
  Logger.log('Agregadas: ' + aAgregar.join(', '));
}

// ── Backfill de metadata de TMDB para las películas ya cargadas ──
// Con ~5000+ filas no entra en una sola ejecución (límite de 6 min de
// Apps Script), así que procesa de a lotes con un trigger cada 5 minutos
// hasta terminar, y se borra solo al llegar al final.
//
// Para arrancar: correr "iniciarBackfillTmdb" una vez.
// Para frenarlo a mitad de camino: correr "detenerBackfillTmdb" (el
// progreso queda guardado, así que "iniciarBackfillTmdb" lo retoma después).

var BACKFILL_ROW_PROP = 'BACKFILL_TMDB_ROW';
// Cuando está en 'true', el backfill vuelve a pisar TODAS las filas con id
// (no solo las que tienen algún campo vacío) — se usa para re-traducir el
// catálogo entero de español a inglés sin tener que borrar nada a mano.
var BACKFILL_FORCE_PROP = 'BACKFILL_TMDB_FORCE';
var BACKFILL_BATCH_SECONDS = 240; // margen bajo el límite de 6 min
var BACKFILL_SLEEP_MS = 150; // pausa entre tandas (no entre llamadas sueltas)
var BACKFILL_CHUNK_ROWS = 1000; // tope de filas leídas/escritas por lote
var BACKFILL_GROUP_SIZE = 40; // pedidos en paralelo por tanda (fetchAll)

function iniciarBackfillTmdb(correrPrimerLoteYa) {
  _borrarTriggerBackfill_();
  ScriptApp.newTrigger('backfillTmdbBatch_').timeBased().everyMinutes(5).create();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(BACKFILL_ROW_PROP)) {
    props.setProperty(BACKFILL_ROW_PROP, '2'); // fila 1 = encabezado
  }
  // Desde el editor conviene correr el primer lote ya mismo (da feedback
  // inmediato en el log). Desde el webhook (celular) NO, para no dejar
  // colgado el pedido HTTP varios minutos — el trigger de 5 min lo agarra solo.
  if (correrPrimerLoteYa !== false) {
    Logger.log('Backfill arrancado. Corriendo el primer lote ahora mismo...');
    backfillTmdbBatch_();
  } else {
    Logger.log('Backfill arrancado. El trigger va a correr el primer lote en breve.');
  }
}

function detenerBackfillTmdb() {
  _borrarTriggerBackfill_();
  Logger.log('Backfill pausado. El progreso queda guardado para retomar con iniciarBackfillTmdb.');
}

// Re-traduce TODO el catálogo (país/idioma/duración/sinopsis/saga/
// productoras) de español a inglés — pisa lo que ya estaba, no solo lo
// vacío. Es lo mismo que iniciarBackfillTmdb pero arrancando de cero y en
// modo "force". También accesible por URL: ?action=backfillStart&force=true
function reiniciarBackfillEnIngles() {
  var props = PropertiesService.getScriptProperties();
  props.setProperty(BACKFILL_ROW_PROP, '2');
  props.setProperty(BACKFILL_FORCE_PROP, 'true');
  iniciarBackfillTmdb();
}

// Corré esta en cualquier momento (no toca nada, solo lee) para ver cuánto
// falta. El resultado queda en el log de la ejecución (Ver → Registros de
// ejecución, o Ctrl+Enter después de correrla).
function progresoBackfillTmdb() {
  var p = _backfillProgreso_();
  Logger.log(
    'Progreso: ' + p.hechas + ' / ' + p.total + ' filas (' + p.pct + '%).' +
    (p.completo ? ' COMPLETO.' : p.hayTrigger ? ' Trigger activo, sigue solo.' : ' Sin trigger activo — corré iniciarBackfillTmdb para retomar.')
  );
}

function _backfillProgreso_() {
  var props = PropertiesService.getScriptProperties();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('MOVIES');
  var lastRow = sheet.getLastRow();
  var startRow = Number(props.getProperty(BACKFILL_ROW_PROP) || '2');
  var total = Math.max(lastRow - 1, 0); // sin contar el encabezado
  var hechas = Math.max(Math.min(startRow - 2, total), 0);
  var pct = total > 0 ? Math.round((hechas / total) * 100) : 100;
  var hayTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'backfillTmdbBatch_';
  });
  return {
    hechas: hechas,
    total: total,
    pct: pct,
    hayTrigger: hayTrigger,
    completo: startRow > lastRow,
  };
}

function _borrarTriggerBackfill_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backfillTmdbBatch_') {
      ScriptApp.deleteTrigger(t);
    }
  });
}

function backfillTmdbBatch_() {
  var start = Date.now();
  var deadline = start + BACKFILL_BATCH_SECONDS * 1000;
  var props = PropertiesService.getScriptProperties();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('MOVIES');
  var lastCol = sheet.getLastColumn();
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  var cols = {
    id: header.indexOf('id'),
    country: header.indexOf('country'),
    lang: header.indexOf('original_language'),
    runtime: header.indexOf('runtime'),
    overview: header.indexOf('overview'),
    collection: header.indexOf('collection'),
    companies: header.indexOf('production_companies'),
    voteAverage: header.indexOf('vote_average'),
    voteCount: header.indexOf('vote_count'),
    cast: header.indexOf('cast'),
    tagline: header.indexOf('tagline'),
    backdrop: header.indexOf('backdrop_path'),
    imdbId: header.indexOf('imdb_id'),
  };
  var faltaColumna = Object.keys(cols).some(function (k) { return cols[k] === -1; });
  if (faltaColumna) {
    Logger.log('Faltan columnas en MOVIES. Corré agregarColumnasMovies_ (o formatearHojasEstetica) primero.');
    _borrarTriggerBackfill_();
    return;
  }

  var apiKey = getTmdbApiKey_();
  var force = props.getProperty(BACKFILL_FORCE_PROP) === 'true';
  var totalProcesadas = 0;
  var totalSaltadas = 0;
  var chunks = 0;

  // Seguimos encadenando chunks de a BACKFILL_CHUNK_ROWS filas mientras
  // quede presupuesto de tiempo en esta ejecución — con fetchAll cada
  // chunk suele ser rápido, así que en una sola corrida podemos avanzar
  // bastante más que un solo chunk.
  var allDebug = [];
  while (Date.now() < deadline) {
    var lastRow = sheet.getLastRow();
    var startRow = Number(props.getProperty(BACKFILL_ROW_PROP) || '2');
    if (startRow > lastRow) {
      _borrarTriggerBackfill_();
      // Ojo: a propósito NO borramos BACKFILL_ROW_PROP acá. Dejarlo en su
      // valor final (> lastRow) es lo que hace que _backfillProgreso_
      // reporte "completo" correctamente, y de paso permite que si más
      // adelante agregás películas nuevas (lastRow crece), la próxima
      // corrida las detecte y siga solo con esas.
      if (force) props.deleteProperty(BACKFILL_FORCE_PROP);
      Logger.log(
        'Backfill completo. Total esta corrida: ' + totalProcesadas +
        ' actualizadas, ' + totalSaltadas + ' saltadas, en ' + chunks + ' chunk(s).'
      );
      return { totalProcesadas: totalProcesadas, totalSaltadas: totalSaltadas, chunks: chunks, debug: allDebug };
    }

    var resultado = _backfillChunk_(sheet, startRow, lastRow, lastCol, cols, apiKey, deadline, force);
    totalProcesadas += resultado.procesadas;
    totalSaltadas += resultado.saltadas;
    chunks++;
    allDebug = allDebug.concat(resultado.debug);
    props.setProperty(BACKFILL_ROW_PROP, String(resultado.nextRow));

    if (resultado.cortoPorTiempo) break;
  }

  var startRowFinal = Number(props.getProperty(BACKFILL_ROW_PROP) || '2');
  var lastRowFinal = sheet.getLastRow();
  Logger.log(
    'Lote: ' + totalProcesadas + ' actualizadas, ' + totalSaltadas +
    ' saltadas (sin id o ya completas), en ' + chunks + ' chunk(s). ' +
    'Sigue en fila ' + startRowFinal + ' de ' + lastRowFinal + '.'
  );
  return { totalProcesadas: totalProcesadas, totalSaltadas: totalSaltadas, chunks: chunks, debug: allDebug };
}

function _backfillChunk_(sheet, startRow, lastRow, lastCol, cols, apiKey, deadline, force) {
  var chunkSize = Math.min(lastRow - startRow + 1, BACKFILL_CHUNK_ROWS);
  var range = sheet.getRange(startRow, 1, chunkSize, lastCol);
  var values = range.getValues();
  var procesadas = 0;
  var i = values.length; // si no cortamos antes, el chunk entero queda resuelto
  var cortoPorTiempo = false;

  // Separamos las filas que realmente necesitan llamar a TMDB (tienen id y
  // les falta algo, o cualquiera con id si force==true) del resto, para
  // pedirlas en tandas en paralelo con fetchAll en vez de una por una —
  // mucho más rápido que ir de a una.
  var pendientes = [];
  for (var k = 0; k < values.length; k++) {
    var r = values[k];
    // imdbId como "gate" de la tanda de campos más nueva (rating de TMDB,
    // reparto, tagline, backdrop, imdb_id): si falta, reprocesamos la fila
    // aunque el resto (país/duración/sinopsis) ya estuviera completo.
    var yaCompleto = r[cols.country] && r[cols.runtime] && r[cols.overview] && r[cols.imdbId];
    if (r[cols.id] && (force || !yaCompleto)) pendientes.push(k);
  }
  var saltadas = values.length - pendientes.length;
  var debug = [];

  for (var g = 0; g < pendientes.length; g += BACKFILL_GROUP_SIZE) {
    if (Date.now() > deadline) {
      i = pendientes[g]; // todo lo anterior a este índice ya quedó resuelto
      cortoPorTiempo = true;
      break;
    }
    var grupo = pendientes.slice(g, g + BACKFILL_GROUP_SIZE);
    // Dos pedidos por película (detalle + créditos, para el reparto) —
    // van intercalados en el mismo fetchAll para que sigan siendo paralelos.
    var requests = [];
    grupo.forEach(function (idx) {
      var tmdbId = encodeURIComponent(values[idx][cols.id]);
      requests.push({
        url: 'https://api.themoviedb.org/3/movie/' + tmdbId +
          '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US',
        muteHttpExceptions: true,
      });
      requests.push({
        url: 'https://api.themoviedb.org/3/movie/' + tmdbId +
          '/credits?api_key=' + encodeURIComponent(apiKey),
        muteHttpExceptions: true,
      });
    });

    var tFetch = Date.now();
    var responses;
    try {
      responses = UrlFetchApp.fetchAll(requests);
    } catch (e) {
      responses = [];
    }
    debug.push({
      grupo: g,
      pelis: grupo.length,
      requests: requests.length,
      ms: Date.now() - tFetch,
      responses: responses.length,
    });

    for (var r2 = 0; r2 < grupo.length; r2++) {
      var row = values[grupo[r2]];
      try {
        var resp = responses[r2 * 2];
        var creditsResp = responses[r2 * 2 + 1];
        if (resp && resp.getResponseCode() === 200) {
          var d = JSON.parse(resp.getContentText());
          var country = (d.production_countries || []).map(function (c) { return c.name; }).join(', ');
          var companies = (d.production_companies || [])
            .slice(0, 3)
            .map(function (c) { return c.name; })
            .join(', ');
          var collection = d.belongs_to_collection ? d.belongs_to_collection.name : '';
          var cast = '';
          if (creditsResp && creditsResp.getResponseCode() === 200) {
            var creditsData = JSON.parse(creditsResp.getContentText());
            cast = (creditsData.cast || [])
              .slice(0, 5)
              .map(function (c) { return c.name; })
              .join(', ');
          }

          if (country && (force || !row[cols.country])) row[cols.country] = country;
          if (d.original_language && (force || !row[cols.lang])) row[cols.lang] = d.original_language;
          if (d.runtime && (force || !row[cols.runtime])) row[cols.runtime] = d.runtime;
          if (d.overview && (force || !row[cols.overview])) row[cols.overview] = d.overview;
          if (collection && (force || !row[cols.collection])) row[cols.collection] = collection;
          if (companies && (force || !row[cols.companies])) row[cols.companies] = companies;
          if (d.vote_average && (force || !row[cols.voteAverage])) row[cols.voteAverage] = d.vote_average;
          if (d.vote_count && (force || !row[cols.voteCount])) row[cols.voteCount] = d.vote_count;
          if (cast && (force || !row[cols.cast])) row[cols.cast] = cast;
          if (d.tagline && (force || !row[cols.tagline])) row[cols.tagline] = d.tagline;
          if (d.backdrop_path && (force || !row[cols.backdrop])) row[cols.backdrop] = d.backdrop_path;
          if (d.imdb_id && (force || !row[cols.imdbId])) row[cols.imdbId] = d.imdb_id;
        }
        procesadas++;
      } catch (e2) {
        // seguimos con la próxima
      }
    }
    Utilities.sleep(BACKFILL_SLEEP_MS);
  }

  range.setValues(values);
  return {
    nextRow: startRow + i,
    procesadas: procesadas,
    saltadas: saltadas,
    cortoPorTiempo: cortoPorTiempo,
    debug: debug,
  };
}

function autorizarTmdb() {
  var apiKey = PropertiesService.getScriptProperties().getProperty('TMDB_API_KEY');
  var resp = UrlFetchApp.fetch(
    'https://api.themoviedb.org/3/configuration?api_key=' + encodeURIComponent(apiKey)
  );
  Logger.log(resp.getContentText());
}

function getTmdbApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('TMDB_API_KEY');
}

function handleTmdbSearch(query) {
  try {
    var apiKey = getTmdbApiKey_();
    if (!apiKey) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: 'Falta configurar TMDB_API_KEY en Script Properties.' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    if (!query) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: true, results: [] })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    var url = 'https://api.themoviedb.org/3/search/movie?api_key=' +
      encodeURIComponent(apiKey) + '&query=' + encodeURIComponent(query) +
      '&language=en-US&include_adult=false';
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var json = JSON.parse(resp.getContentText());
    var results = (json.results || []).slice(0, 6).map(function (m) {
      return {
        tmdbId: m.id,
        title: m.title,
        year: m.release_date ? m.release_date.substring(0, 4) : '',
        poster: m.poster_path || '',
      };
    });
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, results: results })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handleTmdbDetails(tmdbId) {
  try {
    var apiKey = getTmdbApiKey_();
    if (!apiKey || !tmdbId) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: 'Falta TMDB_API_KEY o id.' })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    var detailsUrl = 'https://api.themoviedb.org/3/movie/' + encodeURIComponent(tmdbId) +
      '?api_key=' + encodeURIComponent(apiKey) + '&language=en-US';
    var creditsUrl = 'https://api.themoviedb.org/3/movie/' + encodeURIComponent(tmdbId) +
      '/credits?api_key=' + encodeURIComponent(apiKey);

    var details = JSON.parse(UrlFetchApp.fetch(detailsUrl, { muteHttpExceptions: true }).getContentText());
    var credits = JSON.parse(UrlFetchApp.fetch(creditsUrl, { muteHttpExceptions: true }).getContentText());

    var director = (credits.crew || [])
      .filter(function (c) { return c.job === 'Director'; })
      .map(function (c) { return c.name; })
      .join(', ');
    var genre = (details.genres || []).map(function (g) { return g.name; }).join(', ');
    var country = (details.production_countries || [])
      .map(function (c) { return c.name; })
      .join(', ');
    var companies = (details.production_companies || [])
      .slice(0, 3)
      .map(function (c) { return c.name; })
      .join(', ');
    var collection = details.belongs_to_collection
      ? details.belongs_to_collection.name
      : '';
    var cast = (credits.cast || [])
      .slice(0, 5)
      .map(function (c) { return c.name; })
      .join(', ');

    return ContentService.createTextOutput(
      JSON.stringify({
        ok: true,
        title: details.title || '',
        year: details.release_date ? details.release_date.substring(0, 4) : '',
        director: director,
        genre: genre,
        poster: details.poster_path || '',
        country: country,
        originalLanguage: details.original_language || '',
        runtime: details.runtime || '',
        overview: details.overview || '',
        collection: collection,
        productionCompanies: companies,
        voteAverage: details.vote_average || '',
        voteCount: details.vote_count || '',
        cast: cast,
        tagline: details.tagline || '',
        backdrop: details.backdrop_path || '',
        imdbId: details.imdb_id || '',
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handlePullHistory() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('HISTORY');
    if (!sheet) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: true, snapshots: [] })
      ).setMimeType(ContentService.MimeType.JSON);
    }
    var values = sheet.getDataRange().getValues();
    // Columnas por posición fija, no por nombre de header:
    // A=timestamp, B=movie, C=tmdb_id, D=rank, E=elo
    var grouped = {};
    var order = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var tsRaw = row[0];
      var title = row[1];
      var tmdbId = row[2];
      var rank = row[3];
      var elo = row[4];
      if (!title || rank === '' || rank === undefined) continue;
      var tsKey = tsRaw instanceof Date ? tsRaw.getTime() : String(tsRaw);
      if (!grouped[tsKey]) {
        grouped[tsKey] = [];
        order.push(tsKey);
      }
      grouped[tsKey].push({
        title: title,
        tmdbId: tmdbId || '',
        rank: rank,
        elo: elo,
      });
    }
    var snapshots = order.map(function (key) {
      var t =
        typeof key === 'number'
          ? key
          : new Date(String(key).replace(' ', 'T')).getTime();
      return { t: t, entries: grouped[key] };
    });
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, snapshots: snapshots })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handlePull() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('MOVIES');
    var values = sheet.getDataRange().getValues();
    var header = values[0];

    var titleCol = header.indexOf('movie');
    var yearCol = header.indexOf('year');
    var ratingCol = header.indexOf('rating');
    var diaryCol = header.indexOf('diary_count');
    var idCol = header.indexOf('id');
    var eloCol = header.indexOf('elo_rating');
    var gamesCol = header.indexOf('elo_games');
    var winCol = header.indexOf('elo_win');
    var lossCol = header.indexOf('elo_loss');

    // Campos de texto simple: mismo nombre de columna en la Sheet, misma
    // key en el JSON de salida. Siempre viajan como string ('' si la
    // columna no existe o la celda está vacía).
    var textFields = [
      { col: header.indexOf('director'), key: 'director' },
      { col: header.indexOf('genre'), key: 'genre' },
      { col: header.indexOf('poster_path'), key: 'poster' },
      { col: header.indexOf('country'), key: 'country' },
      { col: header.indexOf('original_language'), key: 'originalLanguage' },
      { col: header.indexOf('overview'), key: 'overview' },
      { col: header.indexOf('collection'), key: 'collection' },
      { col: header.indexOf('production_companies'), key: 'productionCompanies' },
      { col: header.indexOf('cast'), key: 'cast' },
      { col: header.indexOf('tagline'), key: 'tagline' },
      { col: header.indexOf('backdrop_path'), key: 'backdrop' },
      { col: header.indexOf('imdb_id'), key: 'imdbId' },
    ];
    // Campos numéricos: null si no hay columna o celda vacía, en vez de ''.
    var numFields = [
      { col: header.indexOf('runtime'), key: 'runtime' },
      { col: header.indexOf('vote_average'), key: 'voteAverage' },
      { col: header.indexOf('vote_count'), key: 'voteCount' },
    ];

    var result = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (!row[titleCol]) continue;
      var movie = {
        title: String(row[titleCol]),
        year: yearCol > -1 ? row[yearCol] : null,
        rating: ratingCol > -1 ? row[ratingCol] : null,
        plays: diaryCol > -1 ? row[diaryCol] : null,
        tmdbId: idCol > -1 ? row[idCol] : '',
        elo: eloCol > -1 ? row[eloCol] : null,
        games: gamesCol > -1 ? row[gamesCol] : 0,
        wins: winCol > -1 ? row[winCol] : 0,
        losses: lossCol > -1 ? row[lossCol] : 0,
      };
      textFields.forEach(function (f) {
        movie[f.key] = f.col > -1 ? String(row[f.col] || '') : '';
      });
      numFields.forEach(function (f) {
        movie[f.key] = f.col > -1 ? row[f.col] : null;
      });
      result.push(movie);
    }
    return ContentService.createTextOutput(
      JSON.stringify({ ok: true, movies: result })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

// ── Formateo estético de MOVIES / DIRECTORS / RELATIONS ──
// Utilidad manual: elegí "formatearHojasEstetica" en el dropdown de
// funciones del editor de Apps Script y Run. Es idempotente (limpia
// bandings/formato condicional propios antes de reaplicar), así que se
// puede correr de nuevo después de agregar filas o columnas sin acumular
// reglas viejas.

var ESTETICA_PALETA = {
  MOVIES: { header: '#3B5BDB', headerText: '#FFFFFF', bandingTint: '#EAF0FE' },
  DIRECTORS: { header: '#7C4DFF', headerText: '#FFFFFF', bandingTint: '#F1ECFE' },
  RELATIONS: { header: '#F2C14E', headerText: '#14151A', bandingTint: '#FFF6DF' },
};

// Un color por prefijo numérico de "type" (1-Narrative influence, 2-..., etc).
var ESTETICA_TIPOS = [
  { prefijo: '1-', bg: '#4C6EF5', fg: '#FFFFFF' },
  { prefijo: '2-', bg: '#12B886', fg: '#FFFFFF' },
  { prefijo: '3-', bg: '#82C91E', fg: '#14151A' },
  { prefijo: '4-', bg: '#FAB005', fg: '#14151A' },
  { prefijo: '5-', bg: '#F2C14E', fg: '#14151A' },
  { prefijo: '6-', bg: '#FD7E14', fg: '#FFFFFF' },
  { prefijo: '7-', bg: '#E64980', fg: '#FFFFFF' },
  { prefijo: '8-', bg: '#7048E8', fg: '#FFFFFF' },
];

function formatearHojasEstetica() {
  // Idempotente: de paso asegura que existan las columnas de metadata de
  // TMDB, por si "agregarColumnasMovies_" no aparece en tu dropdown de
  // funciones (bug de refresco conocido del editor de Apps Script).
  agregarColumnasMovies_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  _formatearMovies_(ss.getSheetByName('MOVIES'));
  _formatearDirectors_(ss.getSheetByName('DIRECTORS'));
  _formatearRelations_(ss.getSheetByName('RELATIONS'));
  Logger.log('Listo: MOVIES, DIRECTORS y RELATIONS formateadas.');
}

function _headerIndex_(header, nombre) {
  var i = header.indexOf(nombre);
  if (i === -1) throw new Error('No se encontró la columna "' + nombre + '"');
  return i + 1; // los Range de Apps Script son 1-indexados
}

function _colALetra_(col) {
  var letra = '';
  while (col > 0) {
    var resto = (col - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    col = Math.floor((col - 1) / 26);
  }
  return letra;
}

function _limpiarFormatoPrevio_(sheet) {
  var numRows = Math.max(sheet.getLastRow(), 1);
  var numCols = Math.max(sheet.getLastColumn(), 1);
  sheet.getRange(1, 1, numRows, numCols).clearFormat();
  sheet.setConditionalFormatRules([]);
  sheet.getBandings().forEach(function (b) {
    try {
      b.remove();
    } catch (e) {
      // Bandings viejas con celdas combinadas a veces no se pueden borrar
      // limpiamente; seguimos igual, las vamos a tapar con fondo estático.
    }
  });
}

// Alternamos el fondo de las filas a mano (en vez de Range.applyRowBanding,
// que tira "Unexpected error" apenas hay una celda combinada en el rango,
// como pasa con las notas largas de DIRECTORS.detail).
function _aplicarBandasFilas_(sheet, numRows, numCols, tint) {
  if (numRows <= 1) return;
  var backgrounds = [];
  for (var r = 2; r <= numRows; r++) {
    var color = r % 2 === 0 ? tint : '#FFFFFF';
    var row = [];
    for (var c = 0; c < numCols; c++) row.push(color);
    backgrounds.push(row);
  }
  sheet.getRange(2, 1, numRows - 1, numCols).setBackgrounds(backgrounds);
}

function _colorScale_(sheet, range, colorMin, colorMax) {
  var rules = sheet.getConditionalFormatRules();
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpoint(colorMin)
      .setGradientMaxpoint(colorMax)
      .setRanges([range])
      .build()
  );
  sheet.setConditionalFormatRules(rules);
}

function _formatearBase_(sheet, paleta) {
  var values = sheet.getDataRange().getValues();
  var numRows = values.length;
  var numCols = values[0].length;
  _limpiarFormatoPrevio_(sheet);

  sheet
    .getRange(1, 1, 1, numCols)
    .setBackground(paleta.header)
    .setFontColor(paleta.headerText)
    .setFontWeight('bold')
    .setHorizontalAlignment('center');

  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);

  _aplicarBandasFilas_(sheet, numRows, numCols, paleta.bandingTint);

  sheet.getRange(1, 1, numRows, numCols)
    .setVerticalAlignment('middle')
    .setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);

  return values[0]; // header
}

function _formatearMovies_(sheet) {
  if (!sheet) return;
  var header = _formatearBase_(sheet, ESTETICA_PALETA.MOVIES);
  var numRows = sheet.getLastRow();

  var ratingCol = _headerIndex_(header, 'rating');
  var eloCol = _headerIndex_(header, 'elo_rating');
  _colorScale_(sheet, sheet.getRange(2, ratingCol, numRows - 1, 1), '#F03E3E', '#40C057');
  _colorScale_(sheet, sheet.getRange(2, eloCol, numRows - 1, 1), '#F03E3E', '#40C057');
  sheet.getRange(2, ratingCol, numRows - 1, 1).setNumberFormat('0.0');
  sheet.getRange(2, eloCol, numRows - 1, 1).setNumberFormat('0');

  sheet.setColumnWidth(_headerIndex_(header, 'id'), 60);
  sheet.setColumnWidth(_headerIndex_(header, 'poster_path'), 90);
  sheet.autoResizeColumn(_headerIndex_(header, 'movie'));
  sheet.autoResizeColumn(_headerIndex_(header, 'director'));
}

function _formatearDirectors_(sheet) {
  if (!sheet) return;
  var header = _formatearBase_(sheet, ESTETICA_PALETA.DIRECTORS);
  var numRows = sheet.getLastRow();

  var ratingCol = _headerIndex_(header, 'rating_avg');
  var appearCol = _headerIndex_(header, 'appearances');
  var maxRelCol = _headerIndex_(header, 'max relations');
  _colorScale_(sheet, sheet.getRange(2, ratingCol, numRows - 1, 1), '#F03E3E', '#40C057');
  _colorScale_(sheet, sheet.getRange(2, appearCol, numRows - 1, 1), '#FFF3BF', '#F2C14E');
  _colorScale_(sheet, sheet.getRange(2, maxRelCol, numRows - 1, 1), '#E5DBFF', '#7C4DFF');
  sheet.getRange(2, ratingCol, numRows - 1, 1).setNumberFormat('0.0');

  // Fila completa resaltada para directores que ya tienen nota curada en
  // "detail" — se agrega DESPUÉS de las escalas de color de arriba para que
  // esas columnas conserven su gradiente en vez de taparlo con el resalte.
  var detailCol = _headerIndex_(header, 'detail');
  var detailLetra = _colALetra_(detailCol);
  var filaCompleta = sheet.getRange(2, 1, numRows - 1, sheet.getLastColumn());
  var rulesResalte = sheet.getConditionalFormatRules();
  rulesResalte.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$' + detailLetra + '2<>""')
      .setBackground('#FFDDAA')
      .setRanges([filaCompleta])
      .build()
  );
  sheet.setConditionalFormatRules(rulesResalte);

  sheet.setColumnWidth(detailCol, 320);
  sheet.setColumnWidth(_headerIndex_(header, 'id'), 60);
  sheet.setColumnWidth(_headerIndex_(header, 'portrait_path'), 90);
  sheet.autoResizeColumn(_headerIndex_(header, 'director'));
}

function _formatearRelations_(sheet) {
  if (!sheet) return;
  var header = _formatearBase_(sheet, ESTETICA_PALETA.RELATIONS);
  var numRows = sheet.getLastRow();

  var maxRelCol = _headerIndex_(header, 'max relations');
  _colorScale_(sheet, sheet.getRange(2, maxRelCol, numRows - 1, 1), '#E5DBFF', '#7C4DFF');

  // Badges de color por tipo de relación (prefijo numérico "1-".."8-").
  var typeCol = _headerIndex_(header, 'type');
  var typeRange = sheet.getRange(2, typeCol, numRows - 1, 1);
  var rules = sheet.getConditionalFormatRules();
  ESTETICA_TIPOS.forEach(function (t) {
    rules.push(
      SpreadsheetApp.newConditionalFormatRule()
        .whenTextStartsWith(t.prefijo)
        .setBackground(t.bg)
        .setFontColor(t.fg)
        .setRanges([typeRange])
        .build()
    );
  });
  // "type" sin clasificar todavía (tus notas en DIRECTORS.detail las marcan
  // como "TIPO PENDIENTE ⚑") — gris en vez de dejarlas sin ningún color.
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenCellEmpty()
      .setBackground('#495057')
      .setFontColor('#FFFFFF')
      .setRanges([typeRange])
      .build()
  );
  sheet.setConditionalFormatRules(rules);

  sheet.autoResizeColumn(_headerIndex_(header, 'target_director'));
  sheet.autoResizeColumn(_headerIndex_(header, 'target_movie'));
  sheet.autoResizeColumn(_headerIndex_(header, 'source_director'));
  sheet.autoResizeColumn(_headerIndex_(header, 'source_movie'));
  sheet.autoResizeColumn(typeCol);
}