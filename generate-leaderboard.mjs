#!/usr/bin/env node
// Eigenstaendiges Skript fuer die Cloud-Routine: holt den Challenge-Leaderboard-
// Stand direkt per REST von Databricks (kein MCP-Tool-Call, keine lokale
// Abhaengigkeit) und schreibt eine fertige HTML-Seite fuer das Artifact.
// Prinzip wie im Hauptprojekt (urbanheroes-umsatzmodell/tools/leaderboard.mjs):
// Klarnamen laufen nur hier durch, nie als sichtbares Tool-Ergebnis an ein LLM.
// Keine Abhaengigkeiten, nur Node-Bordmittel (Node 18+).

const HOST = (process.env.DATABRICKS_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const TOKEN = process.env.DATABRICKS_TOKEN || '';
const WAREHOUSE = (process.env.DATABRICKS_HTTP_PATH || '').split('/').filter(Boolean).pop() || '';
const CATALOG = process.env.DATABRICKS_CATALOG || '';
const SCHEMA = process.env.DATABRICKS_SCHEMA || '';
const COMPANY_ID = 3854; // Urban Heroes Hamburg

const FROM = process.env.LB_FROM || '2026-08-29';
const TO = process.env.LB_TO || '2026-10-17';
const KW1 = process.env.LB_KW1 || 'hybrid';
const KW1PTS = Number(process.env.LB_KW1PTS || 1);
const KW2 = process.env.LB_KW2 || 'extended 90';
const KW2PTS = Number(process.env.LB_KW2PTS || 2);

const outArgIdx = process.argv.indexOf('--out');
const OUT = outArgIdx > -1 ? process.argv[outArgIdx + 1] : new URL('./leaderboard.html', import.meta.url).pathname;

function escapeLiteral(s) { return s.replace(/'/g, "''"); }
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(d) { return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
function fmtStamp(d) { return new Date(d).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' Uhr'; }

async function dbxRequest(path, options = {}) {
  const res = await fetch(`https://${HOST}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`Databricks ${res.status}: ${body.message || body.error_code || text.slice(0, 400)}`);
  return body;
}

async function dbxQuery(statement) {
  let out = await dbxRequest('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      statement, warehouse_id: WAREHOUSE, catalog: CATALOG || undefined, schema: SCHEMA || undefined,
      wait_timeout: '30s', on_wait_timeout: 'CONTINUE', format: 'JSON_ARRAY', disposition: 'INLINE'
    })
  });
  const id = out.statement_id;
  let guard = 0;
  while (out.status && ['PENDING', 'RUNNING'].includes(out.status.state) && guard < 120) {
    await new Promise(r => setTimeout(r, 2000));
    out = await dbxRequest(`/api/2.0/sql/statements/${id}`);
    guard++;
  }
  const state = out.status && out.status.state;
  if (state !== 'SUCCEEDED') {
    throw new Error(`Abfrage nicht erfolgreich (${state}): ${(out.status && out.status.error && out.status.error.message) || state || 'unbekannt'}`);
  }
  const cols = (out.manifest && out.manifest.schema && out.manifest.schema.columns) || [];
  const rows = (out.result && out.result.data_array) || [];
  return rows.map(r => Object.fromEntries(cols.map((c, i) => [c.name, r[i]])));
}

async function computeLeaderboard() {
  if (!HOST || !TOKEN || !WAREHOUSE) {
    throw new Error('Databricks-Zugangsdaten fehlen (DATABRICKS_HOST / DATABRICKS_TOKEN / DATABRICKS_HTTP_PATH als Env-Secrets setzen).');
  }
  const terms = [{ term: KW1, points: KW1PTS }, { term: KW2, points: KW2PTS }].filter(t => t.term && t.term.trim());
  const lowered = terms.map(t => escapeLiteral(t.term.trim().toLowerCase()));
  const perTermSelect = lowered.map((t, i) => `
    SUM(CASE WHEN LOWER(b.session_name) LIKE '%${t}%' AND b.status = 'ok' THEN 1 ELSE 0 END) AS gebucht_${i},
    SUM(CASE WHEN LOWER(b.session_name) LIKE '%${t}%' AND b.status = 'ok' AND b.has_attended THEN 1 ELSE 0 END) AS teilgenommen_${i}`
  ).join(',');
  const whereOr = lowered.map(t => `LOWER(b.session_name) LIKE '%${t}%'`).join(' OR ');
  const havingOr = lowered.map((_, i) => `gebucht_${i} > 0`).join(' OR ');

  const statement = `
    SELECT b.client_id AS client_id, c.first_name AS first_name, c.last_name AS last_name,${perTermSelect}
    FROM booking_gold b
    LEFT JOIN client_gold c ON c.id = b.client_id AND c.company_id = ${COMPANY_ID}
    WHERE b.company_id = ${COMPANY_ID}
      AND b.type = 'standard'
      AND b.session_start >= TIMESTAMP'${FROM} 00:00:00'
      AND b.session_start <= TIMESTAMP'${TO} 23:59:59'
      AND (${whereOr})
    GROUP BY b.client_id, c.first_name, c.last_name
    HAVING ${havingOr}
  `;

  const rows = await dbxQuery(statement);
  const entries = rows.map(r => {
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || null;
    let punkteBuchung = 0, punkteTeilnahme = 0;
    const perTerm = terms.map((t, i) => {
      const gebucht = Number(r[`gebucht_${i}`]) || 0;
      const teilgenommen = Number(r[`teilgenommen_${i}`]) || 0;
      punkteBuchung += gebucht * t.points;
      punkteTeilnahme += teilgenommen * t.points;
      return { term: t.term, points: t.points, gebucht, teilgenommen };
    });
    return { name, perTerm, punkteBuchung, punkteTeilnahme };
  });
  entries.sort((a, b) => (b.punkteTeilnahme - a.punkteTeilnahme) || (b.punkteBuchung - a.punkteBuchung));
  return { keywords: terms, entries };
}

function buildTemplate({ fromLabel, toLabel, stamp, keywordLegend, kwHeaders, podiumHtml, tableRows, emptyState, participantCount }) {
  return `<!doctype html>
<title>Challenge-Leaderboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root {
  --uh-indigo: #5946ef; --uh-indigo-dark: #4636c9; --uh-indigo-light: #efedfe;
  --uh-pink: #dd1e5b; --uh-pink-light: #fce9ef;
  --gradient: linear-gradient(106deg, #dc2473 0%, #4a51e9 100%);
  --fg: #1c1c1c; --muted: #6b6b70; --border: #e6e5ea; --bg: #f7f7f9; --card: #ffffff;
  --gold: #b8860b; --silver: #7a7a82; --bronze: #a1622f;
  --font-display: "Oswald", "Arial Narrow", sans-serif;
  --font-body: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --fg: #f2f1f7; --muted: #a3a1ad; --border: #34333d; --bg: #17161c; --card: #201f28;
    --uh-indigo-light: #2a2740; --uh-pink-light: #3a2130; --gold: #d9a441; --silver: #b7b5c0; --bronze: #c98252;
  }
}
:root[data-theme="dark"] {
  --fg: #f2f1f7; --muted: #a3a1ad; --border: #34333d; --bg: #17161c; --card: #201f28;
  --uh-indigo-light: #2a2740; --uh-pink-light: #3a2130; --gold: #d9a441; --silver: #b7b5c0; --bronze: #c98252;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; font-family: var(--font-body); color: var(--fg); background: var(--bg); -webkit-font-smoothing: antialiased; }
.top-bar { height: 6px; background: var(--gradient); }
.wrap { max-width: 920px; margin: 0 auto; padding: 40px 24px 72px; }
.eyebrow { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.14em; font-size: 0.72rem; font-weight: 600; color: var(--uh-pink); margin: 0 0 6px; }
h1 { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.01em; font-weight: 700; font-size: clamp(1.9rem, 4vw, 2.6rem); margin: 0 0 14px; text-wrap: balance; color: var(--fg); }
.meta-row { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; font-size: 0.88rem; color: var(--muted); margin-bottom: 6px; }
.meta-row .divider { color: var(--border); }
.pts { color: var(--muted); font-weight: 500; }
.stamp { font-size: 0.78rem; color: var(--muted); margin-bottom: 34px; display: flex; align-items: center; gap: 6px; }
.stamp .dot { width: 6px; height: 6px; border-radius: 50%; background: #1a8a4a; display: inline-block; }
.podium { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 40px; }
.podium-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 22px 16px 18px; text-align: center; position: relative; overflow: hidden; }
.podium-card::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: var(--gradient); }
.podium-card.rank-1 { padding-top: 30px; transform: translateY(-8px); }
.podium-card.rank-1::before { background: var(--gold); height: 5px; }
.podium-card.rank-2::before { background: var(--silver); }
.podium-card.rank-3::before { background: var(--bronze); }
.podium-rank { font-size: 1.7rem; line-height: 1; margin-bottom: 10px; }
.podium-name { font-family: var(--font-display); font-weight: 600; font-size: 1.05rem; text-transform: uppercase; letter-spacing: 0.01em; margin-bottom: 10px; text-wrap: balance; }
.podium-pts { font-family: var(--font-display); font-size: 2rem; font-weight: 700; color: var(--uh-indigo); font-variant-numeric: tabular-nums; }
.podium-pts .unit { font-size: 0.6rem; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-left: 4px; font-family: var(--font-body); }
.podium-sub { font-size: 0.76rem; color: var(--muted); margin-top: 4px; }
.table-card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
thead th { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.06em; font-size: 0.68rem; font-weight: 600; color: var(--muted); text-align: left; padding: 14px 16px; border-bottom: 1px solid var(--border); white-space: nowrap; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody td { padding: 12px 16px; border-bottom: 1px solid var(--border); }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--uh-indigo-light); }
td.rank { font-family: var(--font-display); font-weight: 600; color: var(--muted); width: 40px; }
td.name { font-weight: 600; }
td.num .sep { color: var(--border); margin: 0 3px; }
td.num .booked { color: var(--muted); }
td.pts-teil { font-weight: 700; color: var(--uh-indigo); }
td.pts-buch { color: var(--muted); }
.empty { padding: 40px 16px; text-align: center; color: var(--muted); }
.footnote { margin-top: 22px; font-size: 0.78rem; color: var(--muted); line-height: 1.6; }
.footnote strong { color: var(--fg); }
@media (max-width: 620px) { .podium { grid-template-columns: 1fr; } .podium-card.rank-1 { transform: none; order: -1; } }
</style>
<div class="top-bar"></div>
<div class="wrap">
  <p class="eyebrow">Urban Heroes Hamburg</p>
  <h1>Challenge-Leaderboard</h1>
  <div class="meta-row">
    <span>${fromLabel} &ndash; ${toLabel}</span>
    <span class="divider">&middot;</span>
    <span>${keywordLegend}</span>
    <span class="divider">&middot;</span>
    <span>${participantCount} Teilnehmer:innen</span>
  </div>
  <div class="stamp"><span class="dot"></span>Stand ${stamp} &middot; aktualisiert automatisch st&uuml;ndlich</div>
  ${podiumHtml}
  <div class="table-card">
    <div class="table-scroll">
      <table>
        <thead><tr><th>Platz</th><th>Name</th>${kwHeaders}<th class="num">Punkte Teilnahme</th><th class="num">Punkte Buchung</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      ${emptyState}
    </div>
  </div>
  <p class="footnote">Spalten je Suchbegriff zeigen <strong>wahrgenommen / gebucht</strong>. Punkte Teilnahme = wahrgenommene Termine &times; Punktzahl, Punkte Buchung = gebuchte Termine &times; Punktzahl. Daten direkt aus Databricks, inkl. Klarnamen.</p>
</div>
`;
}

async function main() {
  const { keywords, entries } = await computeLeaderboard();
  const generatedAt = new Date();
  const podium = entries.slice(0, 3);
  const rankBadge = (rank) => rank === 1 ? '\u{1F947}' : rank === 2 ? '\u{1F948}' : rank === 3 ? '\u{1F949}' : String(rank);
  const podiumOrder = [1, 0, 2].filter(i => podium[i]);
  const podiumHtml = podium.length ? `<div class="podium">${podiumOrder.map(i => {
    const e = podium[i]; const rank = i + 1;
    return `<div class="podium-card rank-${rank}">
      <div class="podium-rank">${rankBadge(rank)}</div>
      <div class="podium-name">${escapeHtml(e.name || 'Unbekannt')}</div>
      <div class="podium-pts">${e.punkteTeilnahme}<span class="unit">Pkt.</span></div>
      <div class="podium-sub">${e.punkteBuchung} Pkt. Buchung</div>
    </div>`;
  }).join('')}</div>` : '';

  const tableRows = entries.map((e, idx) => `<tr>
    <td class="rank">${idx + 1}</td>
    <td class="name">${escapeHtml(e.name || 'Unbekannt')}</td>
    ${e.perTerm.map(t => `<td class="num" data-label="${escapeHtml(t.term)}"><span class="attend">${t.teilgenommen}</span><span class="sep">/</span><span class="booked">${t.gebucht}</span></td>`).join('')}
    <td class="num pts-teil">${e.punkteTeilnahme}</td>
    <td class="num pts-buch">${e.punkteBuchung}</td>
  </tr>`).join('\n');

  const html = buildTemplate({
    fromLabel: fmtDate(FROM), toLabel: fmtDate(TO), stamp: fmtStamp(generatedAt),
    keywordLegend: keywords.map(k => `${escapeHtml(k.term)} <span class="pts">(${k.points} Pkt.)</span>`).join(' &middot; '),
    kwHeaders: keywords.map(k => `<th class="num">${escapeHtml(k.term)}</th>`).join(''),
    podiumHtml, tableRows,
    emptyState: entries.length === 0 ? '<p class="empty">Noch keine Buchungen im gew&auml;hlten Zeitraum f&uuml;r diese Suchbegriffe.</p>' : '',
    participantCount: entries.length,
  });

  const fs = await import('node:fs/promises');
  await fs.writeFile(OUT, html, 'utf8');
  console.log(`OK: ${entries.length} Teilnehmer:innen, Stand ${fmtStamp(generatedAt)}. Datei: ${OUT}`);
}

main().catch(e => { console.error('FEHLER:', e.message); process.exit(1); });
