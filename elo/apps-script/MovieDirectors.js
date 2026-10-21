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

// Correr UNA vez desde el editor: crea la hoja, la llena y pasa las fórmulas
// de DIRECTORS a contar sobre ella.
function armarMovieDirectors() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var msg = sincronizarMovieDirectors();
  msg += '\n' + _mdRewriteDirectorFormulas_(ss);
  Logger.log(msg);
  return msg;
}

// Solo el cambio de fórmulas de DIRECTORS (por si la hoja ya se creó sola
// desde onOpen y armarMovieDirectors no llegó a correr).
function pasarDirectorsAMovieDirectors() {
  var msg = _mdRewriteDirectorFormulas_(SpreadsheetApp.getActiveSpreadsheet());
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

  var known = {};
  if (md.getLastRow() > 1) {
    md.getRange(2, 1, md.getLastRow() - 1, 1).getValues().forEach(function (r) {
      if (r[0] !== '') known[String(r[0])] = true;
    });
  }

  var mh = _mdHeaderCols_(movies);
  var vals = movies.getRange(2, 1, movies.getLastRow() - 1, movies.getLastColumn()).getValues();
  var entities = _mdEntities_(ss);
  var rows = [], separadas = 0;
  vals.forEach(function (row) {
    var id = row[mh.id];
    if (id === '' || id === null || known[String(id)]) return;
    known[String(id)] = true;
    var names = _mdSplitCredit_(row[mh.director], entities);
    if (names.length > 1) separadas++;
    names.forEach(function (name) { rows.push([id, name]); });
  });
  if (rows.length) {
    md.getRange(md.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
  }
  return 'MOVIE_DIRECTORS: ' + rows.length + ' filas nuevas (' + separadas + ' películas con varios directores)';
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

// Columnas C-F se calculan desde MOVIES por id con un ARRAYFORMULA en la fila
// de encabezado, así las filas que se agreguen (a mano o por el script) se
// completan solas.
function _mdEnsureSheet_(ss, movies) {
  var md = ss.getSheetByName(MD_SHEET);
  if (md) return md;
  md = ss.insertSheet(MD_SHEET);
  var mh = _mdHeaderCols_(movies);
  var L = function (i) { return _relColLetter_(i + 1); };
  var look = function (title, col) {
    return '={"' + title + '";ARRAYFORMULA(IF(A2:A="",,XLOOKUP(A2:A,MOVIES!$' + L(mh.id) + ':$' + L(mh.id) +
      ',MOVIES!$' + L(col) + ':$' + L(col) + ',"")))}';
  };
  md.getRange(1, 1, 1, 2).setValues([['movie_id', 'director']]);
  md.getRange(1, 3, 1, 4).setFormulas([[
    look('movie', mh.movie), look('year', mh.year), look('rating', mh.rating), look('diary_count', mh.diary_count)
  ]]);
  md.setFrozenRows(1);
  md.getRange(1, 1, 1, 6).setFontWeight('bold');
  return md;
}

// appearances / rating_sum / plays / year de DIRECTORS pasan a contar sobre
// MOVIE_DIRECTORS (antes: coincidencia exacta con MOVIES.director, y year con
// FIND, que sí encontraba al director dentro de un crédito compartido). Solo
// se reescriben las celdas que ya tenían fórmula.
function _mdRewriteDirectorFormulas_(ss) {
  var dirs = ss.getSheetByName('DIRECTORS');
  var dh = _mdHeaderCols_(dirs);
  var n = dirs.getLastRow() - 1;
  var md = MD_SHEET + '!';
  var nameCol = _relColLetter_(dh.director + 1);
  var build = {
    appearances: function (a) { return '=COUNTIFS(' + md + '$B:$B,' + a + ',' + md + '$E:$E,">0")'; },
    rating_sum: function (a) { return '=SUMIF(' + md + '$B:$B,' + a + ',' + md + '$E:$E)'; },
    plays: function (a) { return '=SUMIF(' + md + '$B:$B,' + a + ',' + md + '$F:$F)'; },
    year: function (a) {
      return '=IF(COUNTIF(' + md + '$B:$B,' + a + ')=0,"",MINIFS(' + md + '$D:$D,' + md + '$B:$B,' + a + '))';
    }
  };
  // Con un filtro activo en DIRECTORS, las fórmulas escritas en filas
  // ocultas por el filtro no quedaban (volvían a la anterior). Se quitan los
  // criterios mientras se escribe y se restauran al final.
  var filter = dirs.getFilter();
  var savedCriteria = [];
  if (filter) {
    var fr = filter.getRange();
    for (var c = fr.getColumn(); c <= fr.getLastColumn(); c++) {
      var crit = filter.getColumnFilterCriteria(c);
      if (crit) {
        savedCriteria.push([c, crit]);
        filter.removeColumnFilterCriteria(c);
      }
    }
    SpreadsheetApp.flush();
  }
  try {
    return _mdWriteDirectorFormulas_(ss, dirs, dh, n, build, nameCol);
  } finally {
    savedCriteria.forEach(function (sc) { filter.setColumnFilterCriteria(sc[0], sc[1]); });
  }
}

function _mdWriteDirectorFormulas_(ss, dirs, dh, n, build, nameCol) {
  var log = [];
  Object.keys(build).forEach(function (col) {
    if (dh[col] === undefined) throw new Error('DIRECTORS no tiene la columna "' + col + '"');
    var range = dirs.getRange(2, dh[col] + 1, n, 1);
    var f = range.getFormulas();
    var vals = range.getValues();
    var count = 0;
    var want = f.map(function (r, i) {
      if (!r[0]) return null;
      count++;
      return build[col](nameCol + (i + 2));
    });
    if (count === n) {
      range.setFormulas(want.map(function (w) { return [w]; }));
    } else {
      range.setValues(want.map(function (w, i) { return [w === null ? vals[i][0] : w]; }));
    }
    SpreadsheetApp.flush();
    // Releer y comparar: si algo (otra regla, otra pestaña, un script) la
    // vuelve a cambiar, queda registrado cuántas y cuál quedó en su lugar.
    var got = range.getFormulas();
    var bad = [];
    want.forEach(function (w, i) {
      if (w !== null && got[i][0] !== w) bad.push('fila ' + (i + 2) + ': ' + got[i][0]);
    });
    log.push(col + ': ' + count + ' fórmulas, ' + bad.length + ' no quedaron' +
      (bad.length ? ' (ej. ' + bad[0] + ')' : ''));
  });
  return 'DIRECTORS -> MOVIE_DIRECTORS. ' + log.join(' | ') +
    ' | hoja: ' + dirs.getName() + ' de ' + ss.getName() + ' (' + ss.getId() + ')';
}
