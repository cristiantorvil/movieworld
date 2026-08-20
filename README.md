# MovieWorld

Proyecto unificado de dos apps que antes vivían separadas (ELO y GRAFO), con una sola base de datos compartida.

## Estructura

- `index.html` — portada, enlaza a las dos apps.
- `elo/` — **Cine Elo**: app de ranking por comparación (React, standalone). `apps-script/` tiene el backend (Google Apps Script, manejado con `clasp`); `frontend/` tiene el código fuente `.jsx`.
- `grafo/` — **Directors Graph**: grafo de influencias entre directores (notebook `grafo.ipynb` + PyVis). `lib/` son librerías JS de terceros (vis.js, tom-select); `posters/`/`profiles/` son imágenes cacheadas localmente.

## Base de datos única

Todo (películas, ratings de Elo, relaciones entre directores, metadata curada de directores) vive en **una sola hoja de Google Sheets** ("elo", en Drive), con estos tabs:

- `MOVIES` — catálogo de películas (título, año, director, género, rating, id de TMDB, poster, stats de Elo).
- `RELATIONS` — relaciones de influencia entre directores (curado a mano).
- `DIRECTOR_META` — metadata curada por director que no se puede derivar de las películas (id de TMDB, retrato, idioma, país, movimiento, notas).
- `TYPES` — catálogo de tipos de influencia.
- `HISTORY` — snapshots históricos del ranking de Elo.

La hoja está compartida como "cualquiera con el enlace: lector", así que `grafo.ipynb` la lee directo vía export CSV (`https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=<gid>`), sin credenciales. Los cálculos que antes eran fórmulas de Excel (`DIRECTORS`: appearances, rating_sum, in/out, etc.) ahora se hacen en pandas dentro del notebook.

## Cómo agregar una película nueva

Desde la app Cine Elo (`elo/index.html`, tab "Mis pelis") — al escribir el título, busca en TMDB automáticamente y completa director/género/año/poster antes de guardar en la hoja.

## Cómo actualizar el grafo de directores

Correr `grafo/grafo.ipynb` de punta a punta (lee la hoja "elo" en vivo, recalcula todo, regenera `grafo/index.html`). Es un paso manual — no está automatizado a propósito, ya que también implica bajar posters/retratos nuevos.

## Sync con GitHub

Una tarea programada de Windows (`CineEloGitHubSync`) vigila la carpeta de Descargas por nuevos exports de `index.html` de Cine Elo y los sube solos a este repo.
