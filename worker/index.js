// Bot Telegram "places MAX" : Cloudflare Worker (webhook).
// Commande : /places <date> [aller|retour] [apres HH:MM] [avant HH:MM]
// Variables a definir dans Cloudflare : ALLOWED_CHAT_ID, WEBHOOK_SECRET.
// La reponse est renvoyee directement dans la reponse HTTP au webhook : pas de token Telegram ici.

const BASE = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/tgvmax/records";
const PARIS = "FRPLY";
const LYON = ["FRLPD", "FRJDQ"];
const STATIONS = {
  FRPLY: "Paris Gare de Lyon",
  FRLPD: "Lyon Part-Dieu",
  FRLPE: "Lyon Perrache",
  FRJDQ: "Lyon Saint-Exupery",
};
const DAYS_FR = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
const WEEKDAYS = {
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
};
const WINDOW_DAYS = 30;

const HELP = [
  "Commande : /places <date> [aller|retour] [apres HH:MM] [avant HH:MM]",
  "Exemples :",
  "  /places demain",
  "  /places 06/11 retour",
  "  /places vendredi aller apres 17h",
  "aller = Paris vers Lyon (defaut), retour = Lyon vers Paris.",
  "Dates : demain, vendredi, 06/11, 06/11/2026, 2026-11-06.",
  `Seuls les ${WINDOW_DAYS} prochains jours sont disponibles.`,
].join("\n");

// ---------- dates ----------
function parisToday() {
  // YYYY-MM-DD a Paris
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

function isoToUtc(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(iso, n) {
  return utcToIso(isoToUtc(iso) + n * 86400000);
}

function validIso(y, m, d) {
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return utcToIso(ms);
}

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function parseDate(raw, today) {
  const t = stripAccents(raw.toLowerCase().trim());
  if (t === "aujourdhui" || t === "aujourd'hui" || t === "auj") return today;
  if (t === "demain") return addDays(today, 1);
  if (t === "apres-demain" || t === "apresdemain") return addDays(today, 2);
  if (t in WEEKDAYS) {
    const todayDow = new Date(isoToUtc(today)).getUTCDay();
    const diff = (WEEKDAYS[t] - todayDow + 7) % 7;
    return addDays(today, diff);
  }
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return validIso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[/.\-](\d{1,2})(?:[/.\-](\d{2}|\d{4}))?$/);
  if (m) {
    const d = +m[1];
    const mo = +m[2];
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return validIso(y, mo, d);
    }
    const year = +today.slice(0, 4);
    let iso = validIso(year, mo, d);
    if (iso && (isoToUtc(today) - isoToUtc(iso)) / 86400000 > 180) iso = validIso(year + 1, mo, d);
    return iso;
  }
  return null;
}

function parseTime(raw) {
  const m = stripAccents(raw.toLowerCase()).match(/^(\d{1,2})(?:[h:](\d{2})?)?$/);
  if (!m) return null;
  const h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

// ---------- commande ----------
export function parseCommand(text, today) {
  let parts = text.trim().split(/\s+/);
  const head = parts.shift().toLowerCase().replace(/@\w+$/, "");
  if (head === "/start" || head === "/aide" || head === "/help") return { help: true };
  if (head !== "/places" && head !== "places") return { unknown: true };
  if (!parts.length) return { error: "Indique une date.\n\n" + HELP };

  const dateTok = parts.shift();
  const date = parseDate(dateTok, today);
  if (!date) return { error: `Date non reconnue : "${dateTok}".\n\n${HELP}` };

  let direction = "aller";
  let after = null;
  let before = null;
  while (parts.length) {
    const tok = stripAccents(parts.shift().toLowerCase());
    if (tok === "aller") direction = "aller";
    else if (tok === "retour") direction = "retour";
    else if (tok === "apres" || tok === "avant") {
      const val = parts.shift();
      const tm = val ? parseTime(val) : null;
      if (!tm) return { error: `Heure non reconnue apres "${tok}" (ex: 17h ou 17:30).` };
      if (tok === "apres") after = tm;
      else before = tm;
    } else {
      return { error: `Mot non compris : "${tok}".\n\n${HELP}` };
    }
  }
  return { date, direction, after, before };
}

// ---------- donnees ----------
function orEq(field, values) {
  return "(" + values.map((v) => `${field} = "${v}"`).join(" or ") + ")";
}

async function fetchDay(date, from, to) {
  const where = [
    `date >= date'${date}'`,
    `date <= date'${date}'`,
    `od_happy_card = "OUI"`,
    orEq("origine_iata", from),
    orEq("destination_iata", to),
  ].join(" and ");
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const url = `${BASE}?${new URLSearchParams({
      where,
      limit: "100",
      offset: String(offset),
      order_by: "date,heure_depart",
    })}`;
    const resp = await fetch(url, { headers: { "User-Agent": "tgvmax-bot/0.1" } });
    if (!resp.ok) throw new Error(`SNCF open data HTTP ${resp.status}`);
    const data = await resp.json();
    const rows = data.results || [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

function fmtDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS_FR[dow]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

function name(code, label) {
  return STATIONS[code] || label || code;
}

export function buildReply(date, direction, rows, after, before) {
  const from = direction === "aller" ? [PARIS] : LYON;
  const to = direction === "aller" ? LYON : [PARIS];
  const label = (codes) => codes.map((c) => STATIONS[c]).join(" / ");
  const seen = new Map();
  for (const r of rows) {
    if (!from.includes(r.origine_iata) || !to.includes(r.destination_iata)) continue;
    if (String(r.od_happy_card).toUpperCase() !== "OUI") continue;
    if (after && r.heure_depart < after) continue;
    if (before && r.heure_depart > before) continue;
    seen.set([r.date, r.train_no, r.heure_depart, r.origine_iata, r.destination_iata].join("|"), r);
  }
  const list = [...seen.values()].sort((a, b) =>
    (a.heure_depart + a.destination_iata).localeCompare(b.heure_depart + b.destination_iata),
  );
  const filt = [after && `apres ${after}`, before && `avant ${before}`].filter(Boolean).join(", ");
  const head = `Places MAX ${fmtDay(date)} : ${label(from)} > ${label(to)}${filt ? ` (${filt})` : ""}`;
  if (!list.length) return `${head}\nAucune place MAX disponible.`;
  const lines = list.map(
    (r) =>
      `  ${r.heure_depart} > ${r.heure_arrivee}  ${name(r.origine_iata, r.origine)} > ${name(r.destination_iata, r.destination)} (train ${r.train_no})`,
  );
  return [head, `${list.length} train(s) :`, ...lines].join("\n");
}

async function answer(text) {
  const today = parisToday();
  const cmd = parseCommand(text, today);
  if (cmd.help || cmd.unknown) return HELP;
  if (cmd.error) return cmd.error;

  const diff = (isoToUtc(cmd.date) - isoToUtc(today)) / 86400000;
  if (diff < 0) return `${fmtDay(cmd.date)} est dans le passe.`;
  if (diff > WINDOW_DAYS) {
    return `${fmtDay(cmd.date)} est hors periode : le jeu de donnees couvre les ${WINDOW_DAYS} prochains jours.`;
  }
  const from = cmd.direction === "aller" ? [PARIS] : LYON;
  const to = cmd.direction === "aller" ? LYON : [PARIS];
  try {
    const rows = await fetchDay(cmd.date, from, to);
    return buildReply(cmd.date, cmd.direction, rows, cmd.after, cmd.before);
  } catch (e) {
    return `Source SNCF indisponible pour le moment (${e.message}). Reessaie dans quelques minutes.`;
  }
}

// ---------- webhook ----------
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("ok");
    if (!env.WEBHOOK_SECRET || !env.ALLOWED_CHAT_ID) return new Response("not configured", { status: 500 });
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!constantTimeEqual(secret, env.WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const msg = update && update.message;
    if (!msg || typeof msg.text !== "string" || !msg.chat) return new Response("ok");
    if (String(msg.chat.id) !== String(env.ALLOWED_CHAT_ID)) return new Response("ok"); // ignore les inconnus

    const text = await answer(msg.text);
    return new Response(
      JSON.stringify({ method: "sendMessage", chat_id: msg.chat.id, text }),
      { headers: { "content-type": "application/json" } },
    );
  },
};
