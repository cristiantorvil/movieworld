function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data && data.type === 'snapshot') {
      return handleSnapshot(data);
    }

    if (data && data.type === 'createSheet') {
      return handleCreateSheet(data);
    }

    var items = Array.isArray(data) ? data : [data];

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('MOVIES');
    var values = sheet.getDataRange().getValues();
    var header = values[0];

    var titleCol = header.indexOf('movie');
    var idCol = header.indexOf('id');
    var yearCol = header.indexOf('year');
    var directorCol = header.indexOf('director');
    var genreCol = header.indexOf('genre');
    var posterCol = header.indexOf('poster_path');
    var eloCol = header.indexOf('elo_rating');
    var gamesCol = header.indexOf('elo_games');
    var winCol = header.indexOf('elo_win');
    var lossCol = header.indexOf('elo_loss');
    var tieCol = header.indexOf('elo_tie');

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
        if (idCol > -1 && item.tmdbId) newRow[idCol] = item.tmdbId;
        if (yearCol > -1 && item.year) newRow[yearCol] = item.year;
        if (directorCol > -1 && item.director) newRow[directorCol] = item.director;
        if (genreCol > -1 && item.genre) newRow[genreCol] = item.genre;
        if (posterCol > -1 && item.poster) newRow[posterCol] = item.poster;
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

      if (idCol > -1 && item.tmdbId) {
        var currentId = sheet.getRange(rowIndex, idCol + 1).getValue();
        if (!currentId) sheet.getRange(rowIndex, idCol + 1).setValue(item.tmdbId);
      }
      if (yearCol > -1 && item.year) {
        var currentYear = sheet.getRange(rowIndex, yearCol + 1).getValue();
        if (!currentYear) sheet.getRange(rowIndex, yearCol + 1).setValue(item.year);
      }
      if (directorCol > -1 && item.director) {
        var currentDirector = sheet.getRange(rowIndex, directorCol + 1).getValue();
        if (!currentDirector) sheet.getRange(rowIndex, directorCol + 1).setValue(item.director);
      }
      if (genreCol > -1 && item.genre) {
        var currentGenre = sheet.getRange(rowIndex, genreCol + 1).getValue();
        if (!currentGenre) sheet.getRange(rowIndex, genreCol + 1).setValue(item.genre);
      }
      if (posterCol > -1 && item.poster) {
        var currentPoster = sheet.getRange(rowIndex, posterCol + 1).getValue();
        if (!currentPoster) sheet.getRange(rowIndex, posterCol + 1).setValue(item.poster);
      }
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
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, msg: "Cine Elo webhook activo" })
  ).setMimeType(ContentService.MimeType.JSON);
}

function compartirHojaPublica() {
  var id = SpreadsheetApp.getActiveSpreadsheet().getId();
  DriveApp.getFileById(id).setSharing(
    DriveApp.Access.ANYONE_WITH_LINK,
    DriveApp.Permission.VIEW
  );
  Logger.log('Listo: hoja compartida como "cualquiera con el enlace: lector".');
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
      '&language=es-ES&include_adult=false';
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
      '?api_key=' + encodeURIComponent(apiKey) + '&language=es-ES';
    var creditsUrl = 'https://api.themoviedb.org/3/movie/' + encodeURIComponent(tmdbId) +
      '/credits?api_key=' + encodeURIComponent(apiKey);

    var details = JSON.parse(UrlFetchApp.fetch(detailsUrl, { muteHttpExceptions: true }).getContentText());
    var credits = JSON.parse(UrlFetchApp.fetch(creditsUrl, { muteHttpExceptions: true }).getContentText());

    var director = (credits.crew || [])
      .filter(function (c) { return c.job === 'Director'; })
      .map(function (c) { return c.name; })
      .join(', ');
    var genre = (details.genres || []).map(function (g) { return g.name; }).join(', ');

    return ContentService.createTextOutput(
      JSON.stringify({
        ok: true,
        title: details.title || '',
        year: details.release_date ? details.release_date.substring(0, 4) : '',
        director: director,
        genre: genre,
        poster: details.poster_path || '',
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
    var directorCol = header.indexOf('director');
    var genreCol = header.indexOf('genre');
    var ratingCol = header.indexOf('rating');
    var diaryCol = header.indexOf('diary_count');
    var idCol = header.indexOf('id');
    var posterCol = header.indexOf('poster_path');
    var eloCol = header.indexOf('elo_rating');
    var gamesCol = header.indexOf('elo_games');
    var winCol = header.indexOf('elo_win');
    var lossCol = header.indexOf('elo_loss');

    var result = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (!row[titleCol]) continue;
      result.push({
        title: String(row[titleCol]),
        year: yearCol > -1 ? row[yearCol] : null,
        director: directorCol > -1 ? String(row[directorCol] || '') : '',
        genre: genreCol > -1 ? String(row[genreCol] || '') : '',
        rating: ratingCol > -1 ? row[ratingCol] : null,
        plays: diaryCol > -1 ? row[diaryCol] : null,
        tmdbId: idCol > -1 ? row[idCol] : '',
        poster: posterCol > -1 ? row[posterCol] : '',
        elo: eloCol > -1 ? row[eloCol] : null,
        games: gamesCol > -1 ? row[gamesCol] : 0,
        wins: winCol > -1 ? row[winCol] : 0,
        losses: lossCol > -1 ? row[lossCol] : 0,
      });
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