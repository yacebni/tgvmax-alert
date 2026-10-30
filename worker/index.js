// Bot Telegram "places MAX" : Cloudflare Worker.
//
// Commandes :
//   /places <date> [aller|retour] [apres HH:MM] [avant HH:MM]        consultation immediate
//   /surveiller <date> [aller|retour] <HH:MM>                         alerte sur un train precis
//   /surveiller <date> [aller|retour] [apres HH:MM] [avant HH:MM]     alerte sur une plage horaire
//   /surveiller chaque <jour> [aller|retour] [apres|avant HH:MM]      surveillance recurrente
//   /mes                                                              liste des surveillances
//   /stop <numero|tout>                                               arrete des surveillances
//
// Configuration Cloudflare (voir worker/wrangler.jsonc et worker/README.md) :
//   Secrets   : ALLOWED_CHAT_ID, WEBHOOK_SECRET, TELEGRAM_TOKEN (alertes planifiees)
//   Binding KV: TARGETS
//   Cron      : */5 * * * *
//
// Stockage KV : une cle par entree, la definition est dupliquee dans les metadonnees de la cle
// (lecture par list() uniquement, sans get) ; la valeur contient en plus l'etat "seen".
//   t:<chat>:<id>            surveillance manuelle
//   t:<chat>:<regle>_<date>  occurrence creee par une regle recurrente
//   r:<chat>:<id>            regle recurrente

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
const DAY_NAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const WEEKDAYS = {
  dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6,
};
const WINDOW_DAYS = 30; // fenetre du jeu de donnees
const TARGET_WINDOW_DAYS = 120; // surveillance manuelle possible plus loin : demarre a l'entree dans la fenetre
const MAX_TARGETS = 10; // surveillances manuelles
const MAX_RULES = 3; // regles recurrentes (chacune cree jusqu'a 5 occurrences)

const HELP = [
  "Consulter : /places <date> [aller|retour] [apres HH:MM] [avant HH:MM]",
  "  /places demain",
  "  /places 06/11 retour",
  "  /places vendredi aller apres 17h",
  "",
  "Etre prevenu : /surveiller <date> [aller|retour] <HH:MM>",
  "  /surveiller 13/11 aller 18:14   (un train precis)",
  "  /surveiller vendredi retour apres 17h   (n'importe quel train de la plage)",
  "",
  "Chaque semaine : /surveiller chaque <jour> [aller|retour] [apres HH:MM] [avant HH:MM]",
  "  /surveiller chaque vendredi aller apres 17h",
  "  /surveiller chaque lundi retour avant 9h",
  "",
  "  /mes   liste des surveillances",
  "  /stop 1   ou   /stop tout",
  "",
  "aller = Paris vers Lyon (defaut), retour = Lyon vers Paris.",
  "Dates : demain, vendredi, 06/11, 06/11/2026, 2026-11-06.",
  `Consultation : ${WINDOW_DAYS} prochains jours. Surveillance manuelle : jusqu'a ${TARGET_WINDOW_DAYS} jours.`,
].join("\n");

// ---------- dates ----------
function parisToday() {
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

function daysBetween(a, b) {
  return Math.round((isoToUtc(b) - isoToUtc(a)) / 86400000);
}

function weekdayOf(iso) {
  return new Date(isoToUtc(iso)).getUTCDay();
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
    const diff = (WEEKDAYS[t] - weekdayOf(today) + 7) % 7;
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
    // Sans annee : une date passee de plus d'une semaine designe l'annee suivante.
    if (iso && daysBetween(iso, today) > 7) iso = validIso(year + 1, mo, d);
    return iso;
  }
  return null;
}

export function parseTime(raw) {
  const m = stripAccents(raw.toLowerCase()).match(/^(\d{1,2})(?:[h:](\d{2})?)?$/);
  if (!m) return null;
  const h = +m[1];
  const mi = m[2] ? +m[2] : 0;
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

// ---------- commande ----------
export function parseCommand(text, today) {
  const parts = text.trim().split(/\s+/);
  const head = parts.shift().toLowerCase().replace(/@\w+$/, "");
  if (head === "/start" || head === "/aide" || head === "/help") return { cmd: "help" };
  if (head === "/mes" || head === "/liste") return { cmd: "list" };
  if (head === "/stop") return { cmd: "stop", arg: (parts[0] || "").toLowerCase() };
  const isWatch = head === "/surveiller" || head === "surveiller";
  const isPlaces = head === "/places" || head === "places";
  if (!isWatch && !isPlaces) return { cmd: "unknown" };
  if (!parts.length) return { error: "Indique une date.\n\n" + HELP };

  // surveillance recurrente : "chaque vendredi" / "tous les vendredis"
  let weekday = null;
  if (isWatch) {
    const first = stripAccents(parts[0].toLowerCase());
    if (first === "chaque" || first === "tous") {
      parts.shift();
      if (first === "tous" && stripAccents((parts[0] || "").toLowerCase()) === "les") parts.shift();
      const dayTok = stripAccents((parts.shift() || "").toLowerCase()).replace(/s$/, "");
      if (!(dayTok in WEEKDAYS)) {
        return { error: `Jour non reconnu : "${dayTok}". Exemple : /surveiller chaque vendredi aller apres 17h` };
      }
      weekday = WEEKDAYS[dayTok];
    }
  }

  let date = null;
  if (weekday === null) {
    const dateTok = parts.shift();
    date = parseDate(dateTok, today);
    if (!date) return { error: `Date non reconnue : "${dateTok}".\n\n${HELP}` };
  }

  let direction = "aller";
  let at = null;
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
    } else if (isWatch && parseTime(tok)) {
      at = parseTime(tok);
    } else {
      return { error: `Mot non compris : "${tok}".\n\n${HELP}` };
    }
  }
  if (at && (after || before)) {
    return { error: "Choisis soit une heure precise, soit une plage (apres/avant), pas les deux." };
  }
  if (weekday !== null) return { cmd: "watchRule", weekday, direction, at, after, before };
  return { cmd: isWatch ? "watch" : "places", date, direction, at, after, before };
}

// ---------- donnees ----------
function routeCodes(direction) {
  return direction === "aller" ? { from: [PARIS], to: LYON } : { from: LYON, to: [PARIS] };
}

function orEq(field, values) {
  return "(" + values.map((v) => `${field} = "${v}"`).join(" or ") + ")";
}

async function fetchDay(date, from, to, onlyAvail = true) {
  const parts = [`date >= date'${date}'`, `date <= date'${date}'`];
  if (onlyAvail) parts.push(`od_happy_card = "OUI"`);
  parts.push(orEq("origine_iata", from), orEq("destination_iata", to));
  const where = parts.join(" and ");
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const url = `${BASE}?${new URLSearchParams({
      where,
      limit: "100",
      offset: String(offset),
      order_by: "date,heure_depart",
    })}`;
    const resp = await fetch(url, { headers: { "User-Agent": "tgvmax-bot/0.3" } });
    if (!resp.ok) throw new Error(`SNCF open data HTTP ${resp.status}`);
    const data = await resp.json();
    const rows = data.results || [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

export function rowKey(r) {
  return [r.date, r.train_no, r.heure_depart, r.origine_iata, r.destination_iata].join("|");
}

// Lignes correspondant au sens et aux filtres horaires, dedoublonnees et triees.
export function selectRows(rows, direction, f = {}, onlyAvail = true) {
  const { from, to } = routeCodes(direction);
  const seen = new Map();
  for (const r of rows) {
    if (!from.includes(r.origine_iata) || !to.includes(r.destination_iata)) continue;
    if (onlyAvail && String(r.od_happy_card).toUpperCase() !== "OUI") continue;
    if (f.at && r.heure_depart !== f.at) continue;
    if (f.after && r.heure_depart < f.after) continue;
    if (f.before && r.heure_depart > f.before) continue;
    seen.set(rowKey(r), r);
  }
  return [...seen.values()].sort((a, b) =>
    (a.heure_depart + a.destination_iata).localeCompare(b.heure_depart + b.destination_iata),
  );
}

function fmtDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS_FR[dow]} ${String(d).padStart(2, "0")}/${String(m).padStart(2, "0")}`;
}

function name(code, label) {
  return STATIONS[code] || label || code;
}

export function buildReply(date, direction, rows, after, before, at) {
  const { from, to } = routeCodes(direction);
  const label = (codes) => codes.map((c) => STATIONS[c]).join(" / ");
  const list = selectRows(rows, direction, { after, before, at });
  const filt = [at && `a ${at}`, after && `apres ${after}`, before && `avant ${before}`]
    .filter(Boolean)
    .join(", ");
  const head = `Places MAX ${fmtDay(date)} : ${label(from)} > ${label(to)}${filt ? ` (${filt})` : ""}`;
  if (!list.length) return `${head}\nAucune place MAX disponible.`;
  const lines = list.map(
    (r) =>
      `  ${r.heure_depart} > ${r.heure_arrivee}  ${name(r.origine_iata, r.origine)} > ${name(r.destination_iata, r.destination)} (train ${r.train_no})`,
  );
  return [head, `${list.length} train(s) :`, ...lines].join("\n");
}

// ---------- stockage KV ----------
function hashKeys(keys) {
  if (!keys || !keys.length) return "0";
  const s = [...keys].sort().join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function timeLabel(t) {
  return t.at
    ? t.at
    : [t.after && `apres ${t.after}`, t.before && `avant ${t.before}`].filter(Boolean).join(" ") || "tous les trains";
}

function describe(t) {
  return `${fmtDay(t.date)} ${t.direction} ${timeLabel(t)}`;
}

function describeRule(r) {
  return `chaque ${DAY_NAMES[r.weekday]} ${r.direction} ${timeLabel(r)}`;
}

function filtersOf(t) {
  return { at: t.at, after: t.after, before: t.before };
}

function expirationFor(date) {
  return Math.floor(isoToUtc(addDays(date, 2)) / 1000);
}

function newId() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => (b % 36).toString(36)).join("");
}

// Ecrit une entree : valeur complete + definition en metadonnees (hash de l'etat inclus).
async function saveEntry(env, e) {
  const { key, isRule, h, ...value } = e;
  const meta = {};
  for (const f of ["chat", "date", "weekday", "direction", "at", "after", "before", "rule"]) {
    if (value[f] !== undefined && value[f] !== null) meta[f] = value[f];
  }
  meta.h = hashKeys(value.seen);
  const opts = { metadata: meta };
  if (value.date) opts.expiration = expirationFor(value.date); // les regles n'expirent pas
  await env.TARGETS.put(key, JSON.stringify(value), opts);
}

// Liste les entrees (regles et surveillances) sans lecture individuelle grace aux metadonnees.
async function listEntries(env, chat) {
  const out = [];
  let cursor;
  do {
    const res = await env.TARGETS.list({ cursor });
    for (const k of res.keys) {
      if (chat && !k.name.startsWith(`t:${chat}:`) && !k.name.startsWith(`r:${chat}:`)) continue;
      let m = k.metadata;
      if (!m) {
        // ancienne entree sans metadonnees : une lecture, rare
        const v = await env.TARGETS.get(k.name, "json");
        if (!v) continue;
        const { seen, ...rest } = v;
        m = { ...rest, h: hashKeys(seen) };
      }
      out.push({ key: k.name, isRule: k.name.startsWith("r:"), ...m });
    }
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

function splitEntries(all) {
  const byDate = (a, b) =>
    `${a.date} ${a.at || a.after || ""} ${a.direction} ${a.key}`.localeCompare(
      `${b.date} ${b.at || b.after || ""} ${b.direction} ${b.key}`,
    );
  return {
    rules: all.filter((e) => e.isRule).sort((a, b) => `${a.weekday} ${a.key}`.localeCompare(`${b.weekday} ${b.key}`)),
    manual: all.filter((e) => !e.isRule && !e.rule).sort(byDate),
    instances: all.filter((e) => !e.isRule && e.rule).sort(byDate),
  };
}

function sameTarget(a, b) {
  return (
    a.date === b.date &&
    a.direction === b.direction &&
    (a.at || null) === (b.at || null) &&
    (a.after || null) === (b.after || null) &&
    (a.before || null) === (b.before || null)
  );
}

function sameRule(a, b) {
  return (
    a.weekday === b.weekday &&
    a.direction === b.direction &&
    (a.at || null) === (b.at || null) &&
    (a.after || null) === (b.after || null) &&
    (a.before || null) === (b.before || null)
  );
}

function upcomingDates(weekday, today) {
  const out = [];
  for (let i = 0; i <= WINDOW_DAYS; i++) {
    const d = addDays(today, i);
    if (weekdayOf(d) === weekday) out.push(d);
  }
  return out;
}

function ruleIdOf(rule) {
  return rule.key.split(":")[2];
}

function instanceKey(rule, date) {
  return `t:${rule.chat}:${ruleIdOf(rule)}_${date}`; // deterministe : une recreation ecrase au lieu de dupliquer
}

function newInstance(rule, date, seen) {
  return {
    key: instanceKey(rule, date),
    chat: rule.chat,
    date,
    direction: rule.direction,
    at: rule.at,
    after: rule.after,
    before: rule.before,
    rule: ruleIdOf(rule),
    seen,
  };
}

// ---------- commandes de surveillance ----------
const NO_KV = "Stockage non configure (binding KV TARGETS manquant). Voir worker/README.md.";

async function handleWatch(cmd, env, chat, today) {
  if (!env.TARGETS) return NO_KV;
  const diff = daysBetween(today, cmd.date);
  if (diff < 0) return `${fmtDay(cmd.date)} est dans le passe.`;
  if (diff > TARGET_WINDOW_DAYS) return `${fmtDay(cmd.date)} est trop lointain (maximum ${TARGET_WINDOW_DAYS} jours).`;

  const { manual } = splitEntries(await listEntries(env, chat));
  const candidate = { date: cmd.date, direction: cmd.direction, at: cmd.at, after: cmd.after, before: cmd.before };
  if (manual.some((t) => sameTarget(t, candidate))) return `Deja surveille : ${describe(candidate)}.`;
  if (manual.length >= MAX_TARGETS) return `Limite de ${MAX_TARGETS} surveillances atteinte. Retire-en avec /stop.`;

  const { from, to } = routeCodes(cmd.direction);
  let seen = [];
  let tail;
  if (diff <= WINDOW_DAYS) {
    try {
      const rows = await fetchDay(cmd.date, from, to, false);
      const avail = selectRows(rows, cmd.direction, filtersOf(candidate), true);
      const known = selectRows(rows, cmd.direction, filtersOf(candidate), false);
      seen = avail.map(rowKey);
      if (avail.length) {
        tail = "\nDeja disponible :\n" + buildReply(cmd.date, cmd.direction, rows, cmd.after, cmd.before, cmd.at);
      } else if (known.length) {
        tail = "\nComplet pour l'instant. Je te previens des qu'une place s'ouvre.";
      } else {
        tail = "\nAucun train correspondant dans les donnees pour l'instant (horaire inconnu ou pas encore ouvert). Je surveille quand meme.";
      }
    } catch {
      tail = "\n(Etat actuel non verifie : source SNCF indisponible. La surveillance demarre quand meme.)";
    }
  } else {
    tail = `\nHors fenetre actuelle (${WINDOW_DAYS} jours) : la surveillance demarrera quand ces trains y entreront.`;
  }
  await saveEntry(env, { key: `t:${chat}:${newId()}`, chat, ...candidate, seen });
  return `Surveillance activee : ${describe(candidate)}.${tail}\nAlerte a chaque nouvelle place. /mes pour la liste, /stop pour arreter.`;
}

async function handleWatchRule(cmd, env, chat, today) {
  if (!env.TARGETS) return NO_KV;
  const { rules } = splitEntries(await listEntries(env, chat));
  const candidate = { weekday: cmd.weekday, direction: cmd.direction, at: cmd.at, after: cmd.after, before: cmd.before };
  if (rules.some((r) => sameRule(r, candidate))) return `Deja surveille : ${describeRule(candidate)}.`;
  if (rules.length >= MAX_RULES) return `Limite de ${MAX_RULES} regles recurrentes atteinte. Retire-en avec /stop.`;

  const rule = { key: `r:${chat}:${newId()}`, chat, kind: "rule", ...candidate };
  await saveEntry(env, rule);

  // creation immediate des occurrences deja dans la fenetre, etat actuel memorise (pas d'alerte sur l'existant)
  const { from, to } = routeCodes(cmd.direction);
  const lines = [];
  for (const date of upcomingDates(cmd.weekday, today)) {
    try {
      const rows = await fetchDay(date, from, to, true);
      const current = selectRows(rows, cmd.direction, filtersOf(rule), true);
      await saveEntry(env, newInstance(rule, date, current.map(rowKey)));
      lines.push(`  ${fmtDay(date)} : ${current.length ? `${current.length} train(s) deja disponible(s)` : "en attente"}`);
    } catch {
      lines.push(`  ${fmtDay(date)} : etat non verifie (source indisponible)`);
    }
  }
  return [
    `Surveillance recurrente activee : ${describeRule(candidate)}.`,
    "Dates suivies actuellement :",
    ...lines,
    "Les dates suivantes sont ajoutees automatiquement. /places <date> pour le detail, /mes pour la liste, /stop pour arreter.",
  ].join("\n");
}

function statusOf(t) {
  return t.h && t.h !== "0" ? "place disponible" : "en attente";
}

function numbered(entries) {
  const { rules, manual, instances } = splitEntries(entries);
  return { rules, manual, instances, list: [...rules, ...manual] };
}

async function handleList(env, chat) {
  if (!env.TARGETS) return NO_KV;
  const { rules, manual, instances, list } = numbered(await listEntries(env, chat));
  if (!list.length) return "Aucune surveillance active. Exemple : /surveiller 13/11 aller 18:14";
  const lines = ["Surveillances actives :"];
  let n = 1;
  for (const r of rules) {
    const ruleId = r.key.split(":")[2];
    const dates = instances
      .filter((t) => t.rule === ruleId)
      .map((t) => `${fmtDay(t.date)} (${statusOf(t)})`);
    lines.push(`${n++}. ${describeRule(r)} [recurrente]`);
    if (dates.length) lines.push(`   ${dates.join(", ")}`);
  }
  for (const t of manual) lines.push(`${n++}. ${describe(t)} (${statusOf(t)})`);
  return lines.join("\n");
}

async function handleStop(cmd, env, chat) {
  if (!env.TARGETS) return NO_KV;
  const all = await listEntries(env, chat);
  const { instances, list } = numbered(all);
  if (!list.length) return "Aucune surveillance active.";
  const removeRule = async (r) => {
    const ruleId = r.key.split(":")[2];
    await Promise.all([
      env.TARGETS.delete(r.key),
      ...instances.filter((t) => t.rule === ruleId).map((t) => env.TARGETS.delete(t.key)),
    ]);
  };
  const remove = (e) => (e.isRule ? removeRule(e) : env.TARGETS.delete(e.key));
  if (cmd.arg === "tout" || cmd.arg === "all") {
    await Promise.all(list.map(remove));
    return `${list.length} surveillance(s) arretee(s).`;
  }
  const n = Number(cmd.arg);
  if (!Number.isInteger(n) || n < 1 || n > list.length) {
    return `Indique un numero entre 1 et ${list.length} (voir /mes) ou "tout".`;
  }
  const e = list[n - 1];
  await remove(e);
  return `Surveillance arretee : ${e.isRule ? describeRule(e) : describe(e)}.`;
}

// ---------- alertes planifiees (cron) ----------
async function telegramSend(env, chat, text) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function runTargets(env) {
  if (!env.TARGETS || !env.TELEGRAM_TOKEN) return;
  const today = parisToday();
  const { rules, manual, instances } = splitEntries(await listEntries(env));
  const targets = [...manual, ...instances];

  // creation des occurrences manquantes des regles (idempotent : cle deterministe)
  for (const rule of rules) {
    const ruleId = ruleIdOf(rule);
    for (const date of upcomingDates(rule.weekday, today)) {
      if (targets.some((t) => t.rule === ruleId && t.date === date)) continue;
      const inst = newInstance(rule, date, []);
      await saveEntry(env, inst);
      const { key, seen, ...meta } = inst;
      targets.push({ key, ...meta, h: "0" }); // premiere ouverture => alerte
    }
  }

  const groups = new Map();
  for (const t of targets) {
    const diff = daysBetween(today, t.date);
    if (diff < 0) {
      await env.TARGETS.delete(t.key);
      continue;
    }
    if (diff > WINDOW_DAYS) continue;
    const gk = `${t.date}|${t.direction}`;
    if (!groups.has(gk)) groups.set(gk, []);
    groups.get(gk).push(t);
  }

  for (const [gk, items] of groups) {
    const [date, direction] = gk.split("|");
    const { from, to } = routeCodes(direction);
    let rows;
    try {
      rows = await fetchDay(date, from, to, true);
    } catch {
      continue; // on reessaie au prochain passage
    }
    for (const t of items) {
      const current = selectRows(rows, direction, filtersOf(t), true);
      const currentKeys = current.map(rowKey);
      if (hashKeys(currentKeys) === (t.h || "0")) continue; // rien de change : aucune lecture
      const full = await env.TARGETS.get(t.key, "json");
      if (!full) continue;
      const known = new Set(full.seen || []);
      const fresh = current.filter((r) => !known.has(rowKey(r)));
      if (fresh.length) {
        const text = "Place MAX ouverte !\n" + buildReply(date, direction, fresh, t.after, t.before, t.at);
        if (!(await telegramSend(env, t.chat, text))) continue; // etat inchange : nouvel essai ensuite
      }
      await saveEntry(env, { ...full, key: t.key, seen: currentKeys });
    }
  }
}

// ---------- reponse ----------
async function answer(text, env, chat) {
  const today = parisToday();
  const cmd = parseCommand(text, today);
  if (cmd.error) return cmd.error;
  if (cmd.cmd === "help" || cmd.cmd === "unknown") return HELP;
  if (cmd.cmd === "list") return handleList(env, chat);
  if (cmd.cmd === "stop") return handleStop(cmd, env, chat);
  if (cmd.cmd === "watch") return handleWatch(cmd, env, chat, today);
  if (cmd.cmd === "watchRule") return handleWatchRule(cmd, env, chat, today);

  const diff = daysBetween(today, cmd.date);
  if (diff < 0) return `${fmtDay(cmd.date)} est dans le passe.`;
  if (diff > WINDOW_DAYS) {
    return `${fmtDay(cmd.date)} est hors periode : le jeu de donnees couvre les ${WINDOW_DAYS} prochains jours. Pour etre prevenu a l'ouverture : /surveiller`;
  }
  const { from, to } = routeCodes(cmd.direction);
  try {
    const rows = await fetchDay(cmd.date, from, to, true);
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

    let text;
    try {
      text = await answer(msg.text, env, String(msg.chat.id));
    } catch (e) {
      text = `Erreur interne : ${e.message}`;
    }
    return new Response(
      JSON.stringify({ method: "sendMessage", chat_id: msg.chat.id, text }),
      { headers: { "content-type": "application/json" } },
    );
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTargets(env));
  },
};
