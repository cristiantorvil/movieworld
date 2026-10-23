// ── MOVIE_DIRECTORS: quién dirigió qué, una fila por director ──
// MOVIES.director es texto libre ("Joel Coen & Ethan Coen", "Edward F. Cline,
// Buster Keaton") y las fórmulas de DIRECTORS lo comparaban exacto, así que
// una película codirigida no sumaba a ninguno de sus directores por separado.
// MOVIE_DIRECTORS tiene una fila (movie_id, director) por cada director:
//  - un dúo estable que ya es UNA fila en DIRECTORS ("Joel Coen & Ethan
//    Coen") queda como una sola entrada;
//  - cualquier otra colaboración se separa en una fila por persona.
// Las filas existentes no se reescriben nunca (se pueden corregir a mano);
// sincronizarMovieDirectors solo agrega las películas nuevas de MOVIES.

var MD_SHEET = 'MOVIE_DIRECTORS';
var MD_SEP = /\s*(?:&|,|\s+y\s+|\s+and\s+)\s*/;

// Correr desde el editor: crea/llena la hoja y (re)arma las fórmulas de
// MOVIE_DIRECTORS y DIRECTORS. Se puede correr las veces que haga falta.
function armarMovieDirectors() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var msg = sincronizarMovieDirectors();
  msg += '\n' + _mdSetupFormulas_(ss);
  Logger.log(msg);
  return msg;
}

// Solo las fórmulas (sin sincronizar filas).
function optimizarLibro() {
  var msg = _mdSetupFormulas_(SpreadsheetApp.getActiveSpreadsheet());
  Logger.log(msg);
  return msg;
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('MOVIEWORLD')
    .addItem('Sincronizar MOVIE_DIRECTORS', 'sincronizarMovieDirectors')
    .addToUi();
  try {
    sincronizarMovieDirectors();
  } catch (err) {
    Logger.log('sincronizarMovieDirectors: ' + err);
  }
}

// Agrega a MOVIE_DIRECTORS las películas de MOVIES que todavía no tienen filas.
function sincronizarMovieDirectors() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var movies = ss.getSheetByName('MOVIES');
  var md = _mdEnsureSheet_(ss, movies);

  // Último movie_id real (getLastRow de la hoja cuenta también las columnas
  // de agregados, que no tienen por qué terminar en la misma fila).
  var ids = md.getRange(2, 1, Math.max(md.getMaxRows() - 1, 1), 1).getValues();
  var lastIdRow = 1;
  var known = {};
  ids.forEach(function (r, i) {
    if (r[0] === '' || r[0] === null) return;
    known[String(r[0])] = true;
    lastIdRow = i + 2;
  });

  // Solo las columnas id y director: MOVIES trae overview/cast/etc. y leerla
  // entera en cada onOpen hacía lenta la apertura.
  var mh = _mdHeaderCols_(movies);
  var n = movies.getLastRow() - 1;
  var idVals = movies.getRange(2, mh.id + 1, n, 1).getValues();
  var dirVals = movies.getRange(2, mh.director + 1, n, 1).getValues();
  var entities = _mdEntities_(ss);
  var rows = [], separadas = 0;
  idVals.forEach(function (r, i) {
    var id = r[0];
    if (id === '' || id === null || known[String(id)]) return;
    known[String(id)] = true;
    var names = _mdSplitCredit_(dirVals[i][0], entities);
    if (names.length > 1) separadas++;
    names.forEach(function (name) { rows.push([id, name]); });
  });
  if (rows.length) {
    md.getRange(lastIdRow + 1, 1, rows.length, 2).setValues(rows);
    lastIdRow += rows.length;
  }
  var borradas = _mdRemoveOrphans_(md, lastIdRow, idVals);
  return 'MOVIE_DIRECTORS: ' + rows.length + ' filas nuevas (' + separadas +
    ' películas con varios directores), ' + borradas + ' filas de películas que ya no están en MOVIES';
}

// Películas borradas de MOVIES dejan filas huérfanas que ya no aportan nada
// (sin título/rating) y confunden. Se reescribe solo A:B sin ellas. Si de
// repente faltara una parte grande de MOVIES (lectura a medias), no se toca.
function _mdRemoveOrphans_(md, lastIdRow, idVals) {
  if (lastIdRow < 2) return 0;
  var inMovies = {};
  idVals.forEach(function (r) { if (r[0] !== '' && r[0] !== null) inMovies[String(r[0])] = true; });
  var range = md.getRange(2, 1, lastIdRow - 1, 2);
  var vals = range.getValues();
  var keep = vals.filter(function (r) { return r[0] === '' || r[0] === null || inMovies[String(r[0])]; });
  var removed = vals.length - keep.length;
  if (!removed || removed > vals.length * 0.1) return 0;
  range.clearContent();
  md.getRange(2, 1, keep.length, 2).setValues(keep);
  return removed;
}

function _mdHeaderCols_(sheet) {
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cols = {};
  header.forEach(function (h, i) { cols[String(h).trim()] = i; });
  return cols;
}

function _mdParts_(s) {
  return String(s === null ? '' : s).trim().split(MD_SEP).filter(function (p) { return p; });
}

// Dúos/tríos que DIRECTORS ya trata como una sola entrada: {partes en
// minúscula -> nombre tal cual está en DIRECTORS}.
function _mdEntities_(ss) {
  var dirs = ss.getSheetByName('DIRECTORS');
  var names = dirs.getRange(2, 1, dirs.getLastRow() - 1, 1).getValues();
  var out = [];
  names.forEach(function (r) {
    var parts = _mdParts_(r[0]);
    if (parts.length > 1) {
      out.push({ name: String(r[0]).trim(), parts: parts.map(function (p) { return p.toLowerCase(); }) });
    }
  });
  return out;
}

// "Charlotte Zwerin, David Maysles, Albert Maysles" -> ["Charlotte Zwerin",
// "Albert Maysles & David Maysles"]: las partes que forman un dúo de
// DIRECTORS se juntan en esa entrada; el resto queda por persona, en el
// orden del crédito.
function _mdSplitCredit_(credit, entities) {
  var parts = _mdParts_(credit);
  if (parts.length <= 1) return parts;
  var lower = parts.map(function (p) { return p.toLowerCase(); });
  var owner = {};
  entities.forEach(function (e) {
    var all = e.parts.every(function (p) { return lower.indexOf(p) !== -1; });
    if (all) e.parts.forEach(function (p) { owner[p] = owner[p] || e.name; });
  });
  var out = [], seen = {};
  parts.forEach(function (p, i) {
    var name = owner[lower[i]] || p;
    if (!seen[name]) { seen[name] = true; out.push(name); }
  });
  return out;
}

// MOVIE_DIRECTORS: A movie_id, B director (a mano / por el script),
// C-F movie/year/rating/diary_count traídos de MOVIES, H-J y L-N agregados
// por director que usa DIRECTORS.
function _mdEnsureSheet_(ss, movies) {
  var md = ss.getSheetByName(MD_SHEET);
  if (md) return md;
  md = ss.insertSheet(MD_SHEET);
  md.getRange(1, 1, 1, 2).setValues([['movie_id', 'director']]);
  md.setFrozenRows(1);
  return md;
}

// Fórmulas pensadas para recalcular poco:
//  - MOVIE_DIRECTORS C-F: UN solo VLOOKUP por fila que devuelve las 4
//    columnas (antes 4 XLOOKUP por fila, cada uno recorriendo MOVIES).
//  - H-J / L-N: dos QUERY que agrupan MOVIE_DIRECTORS por director una vez.
//  - DIRECTORS appearances/rating_sum/plays/year: un ARRAYFORMULA por
//    columna que busca en esos agregados (antes ~12.700 COUNTIFS/SUMIF/MINIFS,
//    cada una recorriendo MOVIE_DIRECTORS entera).
function _mdSetupFormulas_(ss) {
  var movies = ss.getSheetByName('MOVIES');
  var md = _mdEnsureSheet_(ss, movies);
  var dirs = ss.getSheetByName('DIRECTORS');
  var mh = _mdHeaderCols_(movies);
  var dh = _mdHeaderCols_(dirs);
  var L = function (i) { return _relColLetter_(i + 1); };
  var mcol = function (name) { return 'MOVIES!$' + L(mh[name]) + '$2:$' + L(mh[name]); };

  md.getRange(1, 3, md.getMaxRows(), 12).clearContent();
  md.getRange(1, 3).setFormula(
    '={"movie","year","rating","diary_count";ARRAYFORMULA(IF(A2:A="",,IFERROR(VLOOKUP(A2:A,{' +
    [mcol('id'), mcol('movie'), mcol('year'), mcol('rating'), mcol('diary_count')].join(',') +
    '},{2,3,4,5},FALSE))))}');
  md.getRange(1, 8).setFormula(
    '={"agg_director","appearances","rating_sum";IFERROR(QUERY(B2:F,' +
    '"select B, count(E), sum(E) where B is not null and E > 0 group by B label count(E) \'\', sum(E) \'\'",0))}');
  md.getRange(1, 12).setFormula(
    '={"agg_director","plays","year";IFERROR(QUERY(B2:F,' +
    '"select B, sum(F), min(D) where B is not null group by B label sum(F) \'\', min(D) \'\'",0))}');
  md.getRange(1, 1, 1, 14).setFontWeight('bold');

  var a = 'A2:A';
  var agg = {
    appearances: 'IFERROR(VLOOKUP(' + a + ',MOVIE_DIRECTORS!$H:$J,2,FALSE)*1,0)',
    rating_sum: 'IFERROR(VLOOKUP(' + a + ',MOVIE_DIRECTORS!$H:$J,3,FALSE)*1,0)',
    plays: 'IFERROR(VLOOKUP(' + a + ',MOVIE_DIRECTORS!$L:$N,2,FALSE)*1,0)',
    year: 'IFNA(VLOOKUP(' + a + ',MOVIE_DIRECTORS!$L:$N,3,FALSE),"")'
  };
  if (dh.director !== 0) throw new Error('DIRECTORS: se esperaba "director" en la columna A');
  return _mdWithoutFilter_(dirs, function () {
    Object.keys(agg).forEach(function (col) {
      if (dh[col] === undefined) throw new Error('DIRECTORS no tiene la columna "' + col + '"');
      var c = dh[col] + 1;
      dirs.getRange(2, c, dirs.getMaxRows() - 1, 1).clearContent();
      dirs.getRange(1, c).setFormula('={"' + col + '";ARRAYFORMULA(IF(' + a + '="",,' + agg[col] + '))}');
    });
    SpreadsheetApp.flush();
    var n = dirs.getLastRow() - 1;
    var log = [];
    Object.keys(agg).forEach(function (col) {
      var vals = dirs.getRange(1, dh[col] + 1, n + 1, 1).getDisplayValues();
      var errs = vals.filter(function (v) { return String(v[0]).charAt(0) === '#'; }).length;
      log.push(col + ': ' + errs + ' errores');
    });
    var mdErr = md.getRange(1, 3, 2, 12).getDisplayValues().join(',').split(',')
      .filter(function (v) { return v.charAt(0) === '#'; }).length;
    return 'Fórmulas optimizadas. MOVIE_DIRECTORS errores en encabezado/fila 2: ' + mdErr +
      ' | DIRECTORS ' + log.join(', ');
  });
}

// max relations de DIRECTORS con tope para que el grafo no se vuelva una
// maraña (~2.000 relaciones en total en vez de ~2.150): el puntaje se escala
// por 0,94, nunca baja de 0 (antes daba negativos), un promedio >= 4 asegura
// al menos 1, y nadie pasa de 40. El bono +2 por tener "out" se mantiene.
function aplicarMaxRelations() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dirs = ss.getSheetByName('DIRECTORS');
  var dh = _mdHeaderCols_(dirs);
  ['max relations', 'appearances', 'rating_sum', 'rating_avg', 'plays', 'out'].forEach(function (c) {
    if (dh[c] === undefined) throw new Error('DIRECTORS no tiene la columna "' + c + '"');
  });
  var col = function (name) { return _relColLetter_(dh[name] + 1); };
  var n = dirs.getLastRow() - 1;
  var want = [];
  for (var r = 2; r <= n + 1; r++) {
    var B = col('appearances') + r, C = col('rating_sum') + r, D = col('rating_avg') + r;
    var E = col('plays') + r, J = col('out') + r;
    want.push(['=MIN(40,MAX(IF(AND(' + B + '>0,' + D + '>=4),1,0),IF(OR(' + B + '=0,' + D + '=""),0,ROUND(0.94*(' +
      C + '^0.793*(' + D + '/3.5)^3-3.9)*MAX(0.5,1+0.5*(' + E + '/' + B + '-1)),0))+IF(' + J + '>0,2,0)))']);
  }
  var msg = _mdWithoutFilter_(dirs, function () {
    var range = dirs.getRange(2, dh['max relations'] + 1, n, 1);
    range.setFormulas(want);
    SpreadsheetApp.flush();
    var got = range.getFormulas();
    var bad = got.filter(function (g, i) { return g[0] !== want[i][0]; }).length;
    var total = range.getValues().reduce(function (s, v) { return s + (Number(v[0]) || 0); }, 0);
    return 'max relations: ' + n + ' fórmulas, ' + bad + ' no quedaron. Suma = ' + total +
      ' (~' + Math.round(total / 2) + ' relaciones)';
  });
  Logger.log(msg);
  return msg;
}

// Con un filtro activo, lo escrito en filas ocultas por el filtro no
// quedaba. Se quitan los criterios mientras se escribe y se restauran.
function _mdWithoutFilter_(sheet, fn) {
  var filter = sheet.getFilter();
  var saved = [];
  if (filter) {
    var fr = filter.getRange();
    for (var c = fr.getColumn(); c <= fr.getLastColumn(); c++) {
      var crit = filter.getColumnFilterCriteria(c);
      if (crit) {
        saved.push([c, crit]);
        filter.removeColumnFilterCriteria(c);
      }
    }
    SpreadsheetApp.flush();
  }
  try {
    return fn();
  } finally {
    saved.forEach(function (sc) { filter.setColumnFilterCriteria(sc[0], sc[1]); });
  }
}
