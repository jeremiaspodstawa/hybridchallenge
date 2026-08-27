# Hybrid Challenge Leaderboard

Generiert die HTML-Seite fuer das Urban-Heroes-Challenge-Leaderboard (Suchbegriffe
"hybrid" und "extended 90") direkt aus Databricks.

`generate-leaderboard.mjs` ist absichtlich abhaengigkeitsfrei (nur Node 18+
Bordmittel) und spricht per REST direkt mit Databricks - keine MCP-Tools, keine
lokale Infrastruktur noetig. So laufen Klarnamen nie sichtbar durch ein LLM,
sondern nur durch dieses Skript.

## Env-Variablen (als Secrets setzen, nie einchecken)

- `DATABRICKS_HOST`
- `DATABRICKS_TOKEN`
- `DATABRICKS_HTTP_PATH`
- `DATABRICKS_CATALOG`
- `DATABRICKS_SCHEMA`

Optional (Default = aktuelle Challenge-Periode):

- `LB_FROM` (Default `2026-08-29`)
- `LB_TO` (Default `2026-10-17`)
- `LB_KW1` / `LB_KW1PTS` (Default `hybrid` / `1`)
- `LB_KW2` / `LB_KW2PTS` (Default `extended 90` / `2`)

## Aufruf
