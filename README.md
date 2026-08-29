# MovieWorld

Proyecto unificado de dos apps que antes vivían separadas (ELO y GRAFO), con una sola base de datos compartida.

## Estructura

- `index.html` — portada, enlaza a las dos apps, a `elo/add.html` y a `elo/edit.html`.
- `elo/` — **Cine Elo**: app de ranking por comparación (React, standalone). `apps-script/` tiene el backend (Google Apps Script, manejado con `clasp`); `frontend/` tiene el código fuente `.jsx`. `add.html` es una página aparte (sin build, vanilla JS) para agregar una película rápido sin abrir toda la app; `edit.html` es su equivalente para corregir una peli ya cargada (rating, poster, TMDB, director, u otro campo suelto).
- `grafo/` — **Directors Graph**: grafo de influencias entre directores (notebook `grafo.ipynb` + PyVis). `lib/` son librerías JS de terceros (vis.js, tom-select); `posters/`/`profiles/` son imágenes cacheadas localmente.

## Base de datos única

Todo (películas, ratings de Elo, relaciones entre directores, metadata curada de directores) vive en **una sola hoja de Google Sheets** ("elo", en Drive), con estos tabs:

- `MOVIES` — catálogo de películas (título, año, director, género, rating, id de TMDB, poster, stats de Elo, país, idioma original, duración, sinopsis, saga y productoras, y `references`/`in`/`out` calculados por fórmula).
- `DIRECTORS` — un director por fila. `appearances`, `rating_sum`, `rating_avg`, `plays`, `year`, `max relations`, `diff`, `in`, `out`, `references` son **fórmulas nativas de Sheets** (SUMIF/COUNTIF, exactamente las mismas que tenía `directors_favs_rev.xlsx`, solo traducidas de sintaxis Excel a Sheets); `id`, `portrait_path`, `language`, `country`, `movement`, `detail` son curados a mano.
- `RELATIONS` — relaciones de influencia entre directores. `target_director`/`target_movie`/`source_director`/`source_movie`/`type` son curados a mano; `max relations`/`target_year`/`target_movie_rating`/`source_year`/`source_movie_rating` son XLOOKUP hacia `DIRECTORS`/`MOVIES`.
- `TYPES` — catálogo de tipos de influencia.
- `HISTORY` — snapshots históricos del ranking de Elo.

La hoja está compartida como "cualquiera con el enlace: lector", así que `grafo.ipynb` lee `MOVIES`/`DIRECTORS`/`RELATIONS` ya calculados directo vía export CSV (`https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<gid>`), sin credenciales y sin recalcular nada en Python — el cálculo vive en la hoja, no en el notebook.

## Cómo agregar una película nueva

Dos formas, ambas pegan directo a la misma Sheet vía el webhook de Apps Script:

- Desde la app Cine Elo (`elo/index.html`, tab "Mis pelis") — al escribir el título, busca en TMDB automáticamente y completa director/género/año/poster antes de guardar.
- Desde `elo/add.html` (enlazada en la portada) — versión rápida standalone, sin abrir todo Cine Elo ni cargar el catálogo completo. Busca en TMDB, dejás elegir rating/veces vista opcional, y guarda. No aparece en Cine Elo hasta la próxima sincronización con la Sheet ahí (botón "restaurar desde el Sheet", o al abrir la app sin progreso local).

## Cómo corregir una película ya cargada

Desde `elo/edit.html` (enlazada en la portada) — buscá por título (sin cargar el catálogo completo, usa el action `searchMovies` del backend) y editá rating dorado, poster, director o cualquier otra columna suelta vía `setField`. Si el match de TMDB está mal (título equivocado, poster que no corresponde), poné el ID correcto de TMDB y usá "Resync": trae de nuevo director/género/poster/país/etc. desde ese ID (`fixTmdbMatch`), igual que se usó para corregir varios matches mal hechos durante la auditoría inicial.

## Cómo actualizar el grafo de directores

Correr `grafo/grafo.ipynb` de punta a punta (lee la hoja "elo" en vivo, recalcula todo, regenera `grafo/index.html`). Es un paso manual — no está automatizado a propósito, ya que también implica bajar posters/retratos nuevos.

## Sync con GitHub

Una tarea programada de Windows (`CineEloGitHubSync`) vigila la carpeta de Descargas por nuevos exports de `index.html` de Cine Elo y los sube solos a este repo.
