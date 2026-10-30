# Bot Telegram "places MAX" (Cloudflare Worker)

Réponse en 1 à 2 secondes à `/places <date> [aller|retour] [apres HH:MM] [avant HH:MM]`.
Le bot n'obéit qu'à ton `chat id` et vérifie un secret de webhook.

## Déploiement (sans rien installer)

1. Compte gratuit sur dash.cloudflare.com.
2. **Workers & Pages** > **Create** > **Create Worker** > nom `tgvmax-bot` > **Deploy**.
3. **Edit code** : remplace tout le contenu par celui de `worker/index.js`, puis **Deploy**.
4. **Settings** > **Variables and Secrets** > **Add** (type **Secret**) :
   - `ALLOWED_CHAT_ID` = ton chat id
   - `WEBHOOK_SECRET` = une chaîne aléatoire (lettres, chiffres, `_` ou `-`), par exemple le résultat de `openssl rand -hex 16`
   Puis **Deploy** pour appliquer.
5. Note l'URL du Worker (`https://tgvmax-bot.<ton-compte>.workers.dev`).
6. Branche Telegram sur le Worker en ouvrant cette URL dans ton navigateur (remplace les 3 valeurs) :

```
https://api.telegram.org/bot<TOKEN_DU_BOT>/setWebhook?url=<URL_DU_WORKER>&secret_token=<WEBHOOK_SECRET>
```

Réponse attendue : `{"ok":true,"result":true,"description":"Webhook was set"}`.

## Utilisation

```
/places demain
/places 06/11 retour
/places vendredi aller apres 17h
/aide
```

## Limites

- Données SNCF : 30 prochains jours, disponibilité indicative.
- Un webhook actif empêche `getUpdates` de fonctionner (normal). Pour l'enlever : `.../deleteWebhook`.
- Le plan gratuit de Cloudflare (100 000 requêtes par jour) est très largement suffisant.
- Le token du bot n'est jamais stocké dans Cloudflare : il ne sert qu'à l'étape 6, dans ton navigateur.
