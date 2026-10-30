#!/usr/bin/env python3
"""Alerte places MAX (Jeune/Senior) via l'open data SNCF.

Usage :
  python3 tgvmax_alert.py inspect
  python3 tgvmax_alert.py watch --from-iata FRPLY --to-iata FRLPD FRJDQ --after 17:00 --interval 600
  python3 tgvmax_alert.py watch --from-iata FRPLY --to-iata FRLPD FRJDQ --once   (cron, GitHub Actions)
  python3 tgvmax_alert.py day --date 2026-11-06 --from-iata FRPLY --to-iata FRLPD FRJDQ

Fonctionnement : a chaque passage, le script liste les places MAX disponibles, les compare
a celles du passage precedent et n'envoie une alerte que pour celles qui viennent
d'apparaitre (y compris une place disparue puis liberee de nouveau).
Le premier passage (pas de fichier d'etat) memorise l'existant sans alerter.

Variables d'environnement (optionnelles, sinon affichage console) :
  TELEGRAM_TOKEN, TELEGRAM_CHAT_ID
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

BASE = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets"
DATASET = os.environ.get("TGVMAX_DATASET", "tgvmax")

F_DATE = "date"
F_TRAIN = "train_no"
F_ORIG = "origine"
F_DEST = "destination"
F_ORIG_IATA = "origine_iata"
F_DEST_IATA = "destination_iata"
F_DEP = "heure_depart"
F_ARR = "heure_arrivee"
F_AVAIL = "od_happy_card"
AVAIL_VALUE = "OUI"

# Codes releves sur les donnees reelles
STATIONS = {
    "FRPLY": "Paris Gare de Lyon",
    "FRLPD": "Lyon Part-Dieu",
    "FRLPE": "Lyon Perrache",
    "FRJDQ": "Lyon Saint-Exupery",
}
DAYS_FR = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]

PAGE = 100
MAX_OFFSET = 10000  # limite Opendatasoft : offset + limit <= 10000
FAIL_ALERT_AFTER = 5
TELEGRAM_LIMIT = 4000


def http_get_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "tgvmax-alert/0.2"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        raise urllib.error.URLError(f"HTTP {e.code}: {body}") from e


def records_url(params):
    return f"{BASE}/{DATASET}/records?{urllib.parse.urlencode(params)}"


def _or_eq(field, values):
    return "(" + " or ".join(f'{field} = "{v}"' for v in values) + ")"


def build_where(origin, dest, d_from, d_to, o_iata=None, d_iata=None):
    parts = [
        f"{F_DATE} >= date'{d_from.isoformat()}'",
        f"{F_DATE} <= date'{d_to.isoformat()}'",
        f'{F_AVAIL} = "{AVAIL_VALUE}"',
    ]
    if origin:
        parts.append(f'search({F_ORIG}, "{origin}")')
    if dest:
        parts.append(f'search({F_DEST}, "{dest}")')
    if o_iata:
        parts.append(_or_eq(F_ORIG_IATA, o_iata))
    if d_iata:
        parts.append(_or_eq(F_DEST_IATA, d_iata))
    return " and ".join(parts)


def fetch_all(origin, dest, d_from, d_to, o_iata=None, d_iata=None, verbose=False):
    where = build_where(origin, dest, d_from, d_to, o_iata, d_iata)
    out, offset = [], 0
    while offset < MAX_OFFSET:
        url = records_url(
            {"where": where, "limit": PAGE, "offset": offset, "order_by": f"{F_DATE},{F_DEP}"}
        )
        if verbose:
            print("GET", url, file=sys.stderr)
        data = http_get_json(url)
        rows = data.get("results", [])
        out.extend(rows)
        if len(rows) < PAGE:
            break
        offset += PAGE
    return out


def keep(row, origin, dest, after, before, o_iata=None, d_iata=None):
    """Filtre cote client (securite si le filtre serveur est trop large)."""
    if origin and origin.lower() not in str(row.get(F_ORIG, "")).lower():
        return False
    if dest and dest.lower() not in str(row.get(F_DEST, "")).lower():
        return False
    if o_iata and row.get(F_ORIG_IATA) not in o_iata:
        return False
    if d_iata and row.get(F_DEST_IATA) not in d_iata:
        return False
    dep = str(row.get(F_DEP, ""))
    if after and dep < after:
        return False
    if before and dep > before:
        return False
    return str(row.get(F_AVAIL, "")).upper() == AVAIL_VALUE


def row_key(row):
    return "|".join(
        str(row.get(f))
        for f in (F_DATE, F_TRAIN, F_DEP, F_ORIG_IATA, F_DEST_IATA, F_ORIG, F_DEST)
    )


def station(code, label):
    return STATIONS.get(code, label)


def fmt_day(iso):
    try:
        d = datetime.strptime(str(iso), "%Y-%m-%d")
    except ValueError:
        return str(iso)
    return f"{DAYS_FR[d.weekday()]} {d:%d/%m}"


def build_message(rows):
    """Message groupe par jour : jours et trajets concernes."""
    by_day = {}
    for r in sorted(rows, key=lambda r: (str(r.get(F_DATE)), str(r.get(F_DEP)))):
        by_day.setdefault(r.get(F_DATE), []).append(r)
    lines = [f"Nouvelles places MAX : {len(rows)}"]
    for day, items in by_day.items():
        lines += ["", fmt_day(day)]
        for r in items:
            o = station(r.get(F_ORIG_IATA), r.get(F_ORIG))
            d = station(r.get(F_DEST_IATA), r.get(F_DEST))
            lines.append(
                f"  {r.get(F_DEP)} > {r.get(F_ARR)}  {o} > {d} (train {r.get(F_TRAIN)})"
            )
    return "\n".join(lines)


def split_message(text, limit=TELEGRAM_LIMIT):
    chunks, cur = [], ""
    for line in text.split("\n"):
        if cur and len(cur) + len(line) + 1 > limit:
            chunks.append(cur.rstrip("\n"))
            cur = ""
        cur += line + "\n"
    if cur.strip():
        chunks.append(cur.rstrip("\n"))
    return chunks


def notify(text):
    token = os.environ.get("TELEGRAM_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print(text)
        return
    for chunk in split_message(text):
        body = urllib.parse.urlencode({"chat_id": chat, "text": chunk}).encode()
        req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body)
        try:
            urllib.request.urlopen(req, timeout=20).read()
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"Echec Telegram : {e}", file=sys.stderr)
            print(chunk)


def load_state(path):
    """Renvoie l'ensemble des places connues, ou None s'il n'y a pas d'etat valide."""
    try:
        return set(json.loads(Path(path).read_text()))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_state(path, keys):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(sorted(keys)))
    tmp.replace(p)


def cmd_inspect(_args):
    url = records_url({"limit": 3})
    print("GET", url)
    data = http_get_json(url)
    print("total_count:", data.get("total_count"))
    rows = data.get("results", [])
    if not rows:
        print("Aucun enregistrement : dataset vide ou identifiant incorrect.")
        return 1
    print("Champs :", ", ".join(rows[0].keys()))
    print(json.dumps(rows[0], indent=2, ensure_ascii=False))
    return 0


def cmd_watch(args):
    previous = load_state(args.state)
    fails, fail_notified = 0, False
    while True:
        d_from = datetime.strptime(args.date_from, "%Y-%m-%d").date() if args.date_from else date.today()
        d_to = d_from + timedelta(days=args.days)
        ok = True
        try:
            rows = fetch_all(
                args.origin, args.dest, d_from, d_to, args.from_iata, args.to_iata, args.verbose
            )
            rows = [
                r
                for r in rows
                if keep(r, args.origin, args.dest, args.after, args.before, args.from_iata, args.to_iata)
            ]
            fails, fail_notified = 0, False
            current = {row_key(r) for r in rows}
            if previous is None:
                if args.notify_existing and rows:
                    notify(build_message(rows))
                else:
                    notify(
                        f"Surveillance MAX demarree : {len(rows)} places deja disponibles. "
                        "Alertes uniquement sur les nouvelles."
                    )
                new = rows
            else:
                new = [r for r in rows if row_key(r) not in previous]
                if new:
                    notify(build_message(new))
            save_state(args.state, current)
            previous = current
            print(f"{datetime.now():%H:%M:%S} {len(rows)} places dispo, {len(new)} nouvelles")
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError) as e:
            ok = False
            fails += 1
            print(f"Erreur source ({fails}) : {e}", file=sys.stderr)
            if fails >= FAIL_ALERT_AFTER and not fail_notified:
                notify(f"tgvmax-alert : source en erreur depuis {fails} tentatives ({e})")
                fail_notified = True
        if args.once:
            return 0 if ok else 1
        time.sleep(args.interval)


def build_day_message(day, rows, o_iata, d_iata):
    o = " / ".join(STATIONS.get(c, c) for c in (o_iata or [])) or "?"
    d = " / ".join(STATIONS.get(c, c) for c in (d_iata or [])) or "?"
    head = f"Places MAX {fmt_day(day)} : {o} > {d}"
    if not rows:
        return head + "\nAucune place MAX disponible."
    lines = [head, f"{len(rows)} train(s) :"]
    for r in sorted(rows, key=lambda r: (str(r.get(F_DEP)), str(r.get(F_DEST_IATA)))):
        lines.append(
            f"  {r.get(F_DEP)} > {r.get(F_ARR)}  "
            f"{station(r.get(F_ORIG_IATA), r.get(F_ORIG))} > "
            f"{station(r.get(F_DEST_IATA), r.get(F_DEST))} (train {r.get(F_TRAIN)})"
        )
    return "\n".join(lines)


def cmd_day(args):
    try:
        day = datetime.strptime(args.date, "%Y-%m-%d").date()
    except ValueError:
        print("Date invalide : utiliser AAAA-MM-JJ", file=sys.stderr)
        return 2
    if day < date.today():
        notify(f"Places MAX : {args.date} est dans le passe.")
        return 0
    try:
        rows = fetch_all(args.origin, args.dest, day, day, args.from_iata, args.to_iata, args.verbose)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        print(f"Erreur source : {e}", file=sys.stderr)
        return 1
    rows = [
        r
        for r in rows
        if keep(r, args.origin, args.dest, args.after, args.before, args.from_iata, args.to_iata)
    ]
    # un meme train peut apparaitre en double : on garde une ligne par cle
    uniq = {row_key(r): r for r in rows}
    msg = build_day_message(args.date, list(uniq.values()), args.from_iata, args.to_iata)
    if not uniq and day > date.today() + timedelta(days=30):
        msg += "\n(Le jeu de donnees ne couvre que les 30 prochains jours.)"
    notify(msg)
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("inspect", help="affiche le schema reel du dataset").set_defaults(fn=cmd_inspect)
    w = sub.add_parser("watch", help="surveille les places MAX")
    w.add_argument("--from", dest="origin", help="texte de la gare d'origine (ex: paris)")
    w.add_argument("--to", dest="dest", help="texte de la gare d'arrivee (ex: lyon)")
    w.add_argument("--from-iata", nargs="+", help="code(s) gare d'origine (ex: FRPLY)")
    w.add_argument("--to-iata", nargs="+", help="code(s) gare d'arrivee (ex: FRLPD FRJDQ)")
    w.add_argument("--days", type=int, default=30, help="fenetre en jours (defaut 30)")
    w.add_argument("--date-from", help="debut de fenetre YYYY-MM-DD (defaut aujourd'hui)")
    w.add_argument("--after", help="depart a partir de HH:MM")
    w.add_argument("--before", help="depart jusqu'a HH:MM")
    w.add_argument("--interval", type=int, default=600, help="secondes entre deux passes")
    w.add_argument("--once", action="store_true", help="une seule passe (cron, GitHub Actions)")
    w.add_argument("--notify-existing", action="store_true", help="alerter aussi sur l'existant au premier passage")
    w.add_argument("--state", default=str(Path.home() / ".tgvmax_seen.json"))
    w.add_argument("-v", "--verbose", action="store_true")
    w.set_defaults(fn=cmd_watch)
    dy = sub.add_parser("day", help="liste les places MAX d'une date et d'un sens")
    dy.add_argument("--date", required=True, help="AAAA-MM-JJ")
    dy.add_argument("--from", dest="origin", help="texte de la gare d'origine")
    dy.add_argument("--to", dest="dest", help="texte de la gare d'arrivee")
    dy.add_argument("--from-iata", nargs="+", help="code(s) gare d'origine")
    dy.add_argument("--to-iata", nargs="+", help="code(s) gare d'arrivee")
    dy.add_argument("--after", help="depart a partir de HH:MM")
    dy.add_argument("--before", help="depart jusqu'a HH:MM")
    dy.add_argument("-v", "--verbose", action="store_true")
    dy.set_defaults(fn=cmd_day)
    args = p.parse_args()
    if args.cmd in ("watch", "day") and (
        not (args.origin or args.from_iata) or not (args.dest or args.to_iata)
    ):
        p.error("indiquer une origine (--from ou --from-iata) et une destination (--to ou --to-iata)")
    try:
        sys.exit(args.fn(args))
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
