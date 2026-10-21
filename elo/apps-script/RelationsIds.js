// ── RELATIONS por id de película ──
// MOVIES tiene títulos repetidos (remakes: "Suspiria", "Halloween", "A Star
// Is Born"...), así que RELATIONS identifica cada película por su id de
// MOVIES (TMDB) en target_movie_id / source_movie_id. target_movie /
// source_movie siguen siendo el título escrito a mano; al editarlo, onEdit
// completa el id (desempatando por "Título (AAAA)" y por el director de la
// relación). Si el id elegido no es el correcto, se corrige a mano en la
// columna de id.

var REL_ID_COLS = { target: 'target_movie_id', source: 'source_movie_id' };
var REL_NOTE_AMBIGUO = '#FFE08A';
var REL_NOTE_FALTA = '#F4A6A6';

// Correr UNA vez desde el editor de Apps Script.
function migrarRelationsAIds() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rel = ss.getSheetByName('RELATIONS');
  var movies = ss.getSheetByName('MOVIES');
  var cols = _relEnsureIdCols_(rel);
  var n = rel.getLastRow() - 1;
  var resumen = { ok: 0, ambiguos: [], faltantes: [] };
  if (n > 0) {
    var idx = _relMovieIndex_(movies);
    var data = rel.getRange(2, 1, n, rel.getLastColumn()).getValues();
    ['target', 'source'].forEach(function (side) {
      var out = [], notes = [], bgs = [];
      data.forEach(function (row, i) {
        var r = _relResolve_(idx, row[cols[side + '_movie']], row[cols[side + '_director']]);
        out.push([r.id]);
        notes.push([r.note]);
        bgs.push([r.color]);
        if (r.state === 'ok') resumen.ok++;
        if (r.state === 'ambiguo') resumen.ambiguos.push('fila ' + (i + 2) + ' ' + side + ': ' + r.note);
        if (r.state === 'falta') resumen.faltantes.push('fila ' + (i + 2) + ' ' + side + ': ' + row[cols[side + '_movie']]);
      });
      var range = rel.getRange(2, cols[REL_ID_COLS[side]] + 1, n, 1);
      range.setValues(out).setNotes(notes).setBackgrounds(bgs);
    });
  }
  _relRewriteFormulas_(rel, movies, cols);
  var msg = 'ids resueltos: ' + resumen.ok +
    '\nambiguos (amarillo, revisar): ' + resumen.ambiguos.length + '\n  ' + resumen.ambiguos.join('\n  ') +
    '\nno están en MOVIES (rojo): ' + resumen.faltantes.length + '\n  ' + resumen.faltantes.join('\n  ');
  Logger.log(msg);
  return msg;
}

// Al escribir/pegar un título en target_movie o source_movie, completa su id.
function onEdit(e) {
  var sheet = e.range.getSheet();
  if (sheet.getName() !== 'RELATIONS' || e.range.getRow() < 2) return;
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cols = _relHeaderCols_(header);
  if (cols.target_movie_id === undefined || cols.source_movie_id === undefined) return;
  var first = e.range.getColumn() - 1, last = first + e.range.getNumColumns() - 1;
  var sides = ['target', 'source'].filter(function (side) {
    var c = cols[side + '_movie'];
    return c >= first && c <= last;
  });
  if (!sides.length) return;
  var idx = _relMovieIndex_(e.source.getSheetByName('MOVIES'));
  var rows = sheet.getRange(e.range.getRow(), 1, e.range.getNumRows(), header.length).getValues();
  sides.forEach(function (side) {
    var out = [], notes = [], bgs = [];
    rows.forEach(function (row) {
      var r = _relResolve_(idx, row[cols[side + '_movie']], row[cols[side + '_director']]);
      out.push([r.id]); notes.push([r.note]); bgs.push([r.color]);
    });
    sheet.getRange(e.range.getRow(), cols[REL_ID_COLS[side]] + 1, rows.length, 1)
      .setValues(out).setNotes(notes).setBackgrounds(bgs);
  });
}

function _relHeaderCols_(header) {
  var cols = {};
  header.forEach(function (h, i) { cols[String(h).trim()] = i; });
  return cols;
}

// Agrega target_movie_id / source_movie_id al final (no se insertan en el
// medio: DIRECTORS y MOVIES cuentan sobre las columnas A-D de RELATIONS).
function _relEnsureIdCols_(rel) {
  var header = rel.getRange(1, 1, 1, rel.getLastColumn()).getValues()[0];
  var cols = _relHeaderCols_(header);
  [REL_ID_COLS.target, REL_ID_COLS.source].forEach(function (name) {
    if (cols[name] === undefined) {
      var c = rel.getLastColumn() + 1;
      rel.getRange(1, c).setValue(name);
      cols[name] = c - 1;
    }
  });
  rel.getRange(1, 1).copyFormatToRange(rel, cols[REL_ID_COLS.target] + 1, cols[REL_ID_COLS.source] + 1, 1, 1);
  return cols;
}

function _relMovieIndex_(movies) {
  var header = movies.getRange(1, 1, 1, movies.getLastColumn()).getValues()[0];
  var c = _relHeaderCols_(header);
  var vals = movies.getRange(2, 1, movies.getLastRow() - 1, header.length).getValues();
  var byTitle = {};
  vals.forEach(function (row) {
    var id = row[c.id];
    if (id === '' || id === null) return;
    var key = String(row[c.movie]).trim().toLowerCase();
    (byTitle[key] = byTitle[key] || []).push({ id: id, year: row[c.year], director: String(row[c.director]) });
  });
  return byTitle;
}

function _relResolve_(idx, name, director) {
  name = String(name === null ? '' : name).trim();
  if (!name) return { id: '', note: '', color: null, state: 'vacio' };
  var title = name, year = null;
  var m = name.match(/^(.*)\s+\((\d{4})\)$/);
  if (m) { title = m[1]; year = Number(m[2]); }
  var cands = idx[title.toLowerCase()] || [];
  if (year !== null && cands.length > 1) {
    var byYear = cands.filter(function (x) { return Number(x.year) === year; });
    if (byYear.length) cands = byYear;
  }
  var dir = String(director || '').trim().toLowerCase();
  if (cands.length > 1 && dir) {
    var byDir = cands.filter(function (x) { return x.director.toLowerCase().indexOf(dir) !== -1; });
    if (byDir.length) cands = byDir;
  }
  if (!cands.length) {
    return { id: '', note: 'No está en MOVIES', color: REL_NOTE_FALTA, state: 'falta' };
  }
  if (cands.length > 1) {
    return {
      id: cands[0].id,
      note: 'Título repetido, se eligió el primero. Candidatos: ' + cands.map(function (x) {
        return x.id + ' (' + x.year + ', ' + x.director + ')';
      }).join('; '),
      color: REL_NOTE_AMBIGUO,
      state: 'ambiguo'
    };
  }
  return { id: cands[0].id, note: '', color: null, state: 'ok' };
}

// target_movie_rating / source_movie_rating buscan por id en vez de título, y
// MOVIES.in / MOVIES.out cuentan por id. Solo se reescriben las celdas que ya
// tenían fórmula.
function _relRewriteFormulas_(rel, movies, cols) {
  var colL = function (i) { return _relColLetter_(i + 1); };
  var mh = _relHeaderCols_(movies.getRange(1, 1, 1, movies.getLastColumn()).getValues()[0]);
  var n = rel.getLastRow() - 1;
  var pairs = [['target_movie_rating', REL_ID_COLS.target], ['source_movie_rating', REL_ID_COLS.source]];
  pairs.forEach(function (p) {
    var range = rel.getRange(2, cols[p[0]] + 1, n, 1);
    var f = range.getFormulas();
    var out = f.map(function (r, i) {
      if (!r[0]) return [r[0]];
      return ['=IFERROR(XLOOKUP(' + colL(cols[p[1]]) + (i + 2) + ',MOVIES!$' + colL(mh.id) + ':$' + colL(mh.id) +
        ',MOVIES!$' + colL(mh.rating) + ':$' + colL(mh.rating) + '),"")'];
    });
    if (out.some(function (r) { return r[0]; })) range.setFormulas(out);
  });

  var m = movies.getLastRow() - 1;
  [['in', REL_ID_COLS.target], ['out', REL_ID_COLS.source]].forEach(function (p) {
    var range = movies.getRange(2, mh[p[0]] + 1, m, 1);
    var f = range.getFormulas();
    var idCol = colL(mh.id);
    var relCol = colL(cols[p[1]]);
    var out = f.map(function (r, i) {
      if (!r[0]) return [r[0]];
      return ['=COUNTIF(RELATIONS!$' + relCol + '$2:$' + relCol + ',' + idCol + (i + 2) + ')'];
    });
    // Celdas sin fórmula se dejan como estaban (puede haber valores escritos).
    var vals = range.getValues();
    range.setValues(vals.map(function (v, i) { return out[i][0] ? [out[i][0]] : [v[0]]; }));
  });
}

function _relColLetter_(n) {
  var s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
