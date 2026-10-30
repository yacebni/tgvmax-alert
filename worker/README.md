# Bot Telegram "places MAX" (Cloudflare Worker)

Consultation instantanée et alertes ciblées, avec un seul bot.
Le bot n'obéit qu'à ton `chat id` et vérifie un secret de webhook.

## Commandes

| Commande | Effet |
|---|---|
| `/places demain` | Trains avec places MAX ce jour-là (aller par défaut) |
| `/places 06/11 retour apres 17h` | Sens Lyon vers Paris, départs après 17h |
| `/surveiller 13/11 aller 18:14` | Alerte dès qu'une place MAX s'ouvre sur ce train |
| `/surveiller vendredi retour apres 17h` | Alerte sur n'importe quel train de la plage horaire |
| `/mes` | Liste des surveillances |
| `/stop 1` ou `/stop tout` | Arrête une ou toutes les surveillances |
| `/aide` | Aide |

Une alerte part à chaque *nouvelle* place (apparition, ou réapparition après disparition). Les surveillances expirent après la date du trajet. On peut surveiller jusqu'à 120 jours à l'avance : elles démarrent quand les trains entrent dans la fenêtre de 30 jours du jeu de données.

## Déploiement initial

1. Compte gratuit sur dash.cloudflare.com.
2. **Workers & Pages** > **Create** > **Hello World** > nom `tgvmax-bot` > **Deploy**.
3. **Edit code** : remplace tout par `worker/index.js`, puis **Deploy**.
4. **Settings** > **Variables and Secrets** > secrets :
   - `ALLOWED_CHAT_ID` : ton chat id
   - `WEBHOOK_SECRET` : chaîne aléatoire (lettres, chiffres, `_`, `-`), ex. `openssl rand -hex 16`
5. Branche Telegram (dans ton navigateur) :

```
https://api.telegram.org/bot<TOKEN_DU_BOT>/setWebhook?url=<URL_DU_WORKER>&secret_token=<WEBHOOK_SECRET>
```

## Activer les alertes ciblées (en plus)

6. **Storage & databases** > **KV** > **Create namespace** > nom `tgvmax-targets`.
7. Dans le Worker : **Settings** > **Bindings** > **Add** > **KV namespace** : variable `TARGETS`, namespace `tgvmax-targets`.
8. **Settings** > **Variables and Secrets** : ajoute le secret `TELEGRAM_TOKEN` (token du bot, nécessaire pour envoyer les alertes sans message entrant).
9. **Settings** > **Triggers** > **Cron Triggers** > **Add** : `*/5 * * * *` (toutes les 5 minutes).
10. **Deploy**, puis teste : `/surveiller demain aller 18:14` puis `/mes`.

## Déploiement automatique (Workers Builds)

Le Worker se redéploie à chaque `push` sur `main`, sans copier-coller :

1. Worker `tgvmax-bot` > **Settings** > **Builds** > **Connect** > GitHub > dépôt `tgvmax-alert`.
2. **Root directory** : `worker`, branche `main`, commande de déploiement `npx wrangler deploy`.
3. La configuration (nom, binding KV `TARGETS`, cron `*/5 * * * *`) est dans `worker/wrangler.jsonc` : c'est elle qui fait foi, à modifier là et non dans le tableau de bord.
4. Les secrets (`ALLOWED_CHAT_ID`, `WEBHOOK_SECRET`, `TELEGRAM_TOKEN`) restent dans Cloudflare et ne sont pas touchés par un déploiement.

## Limites

- Données SNCF : disponibilité indicative, pas de nombre de places ; fenêtre de 30 jours.
- Le cron s'exécute toutes les 5 minutes au mieux : une place très éphémère peut passer inaperçue.
- 20 surveillances maximum. Plan gratuit Cloudflare : 100 000 requêtes par jour et 1 000 écritures KV par jour, très largement suffisant (une écriture seulement quand l'état d'une surveillance change).
- Un webhook actif empêche `getUpdates` de fonctionner (normal). Pour l'enlever : `.../deleteWebhook`.
- Le token n'est stocké dans Cloudflare que pour les alertes planifiées (secret chiffré, jamais dans le code).
