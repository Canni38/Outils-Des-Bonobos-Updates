# Outils Des Bonobos backend

Service HTTP indépendant de l’application Tauri, écrit en TypeScript avec Fastify et PostgreSQL (`pg`). Il ne modifie pas le client ni son dépôt local de mises en page.

## Prérequis et démarrage local

- Node.js 22.6 ou plus récent.
- Docker Compose pour démarrer PostgreSQL localement, ou une instance PostgreSQL existante.
- Définir `POSTGRES_PASSWORD` dans `backend/.env` avant `docker compose up -d` dans ce dossier. Le port est publié uniquement sur `127.0.0.1`.
- Le backend charge au démarrage `backend/.env.local`, puis `backend/.env`, sans remplacer les variables déjà présentes dans l’environnement du processus. Placer `DATABASE_URL` dans l’un de ces fichiers ou le fournir dans l’environnement.
- Définir `STEAM_OPENID_RETURN_URL` comme URL HTTPS publique se terminant par `/auth/steam/callback` en production. En local, l’URL par défaut est `http://127.0.0.1:8080/auth/steam/callback`.
- `BONOBOS_CORS_ORIGINS` accepte une liste d’origines exactes séparées par des virgules. En production, renseigner l’origine HTTPS de chaque client autorisé; les valeurs locales par défaut couvrent Vite et `http://tauri.localhost`. Les cookies d’authentification ne justifient pas d’autoriser `*`.
- Pour une base distante, `DATABASE_SSL=true` est obligatoire. Le certificat serveur est vérifié; ne mettez pas d’options TLS dans les paramètres de `DATABASE_URL`. Pour Docker local sur `localhost` ou `127.0.0.1`, TLS reste désactivé par défaut.
- Limitation Steam par défaut : 10 requêtes par fenêtre de 15 minutes sur chacune des routes de démarrage et de retour OpenID, et 3 créations de compte par heure. Ces compteurs sont en mémoire et partagés par tous les clients de cette instance.
- Les limites applicatives n’utilisent pas `X-Forwarded-For` ni un en-tête fourni par le client pour calculer son adresse. Derrière Cloudflare Tunnel, configurez aussi une règle Cloudflare de limitation par IP cliente; les compteurs locaux sont globaux à l’instance et sont réinitialisés au redémarrage.
- Pour préparer les deux administrateurs initiaux, ajouter `INITIAL_ADMIN_STEAM_IDS` à `backend/.env.local`, avec exactement deux SteamID64 distincts de 17 chiffres séparés par une virgule. Ne pas mettre cette configuration dans le code source. L’ancienne variable `INITIAL_ADMIN_STEAM_ID` reste acceptée comme alias temporaire à un seul identifiant.

```powershell
npm install
docker compose up -d
npm run migrate
npm run dev
```

Le service écoute par défaut sur `127.0.0.1:8080`. `GET /health/live` vérifie le processus et `GET /health/ready` vérifie PostgreSQL.
En production, placer l’API derrière un reverse proxy TLS et ne pas exposer directement son port HTTP public.

`backend/.env.local` est ignoré par Git. Conserver `POSTGRES_PASSWORD` dans `backend/.env` pour Docker Compose; le chargement du backend lit les deux fichiers et n’affiche pas les SteamID. Le journal de démarrage indique uniquement le nombre d’identifiants initiaux configurés.

Les limites peuvent être ajustées dans `backend/.env.local` avec `STEAM_AUTH_RATE_LIMIT_MAX_REQUESTS`, `STEAM_AUTH_RATE_LIMIT_WINDOW_MS`, `STEAM_ACCOUNT_CREATION_RATE_LIMIT_MAX_REQUESTS` et `STEAM_ACCOUNT_CREATION_RATE_LIMIT_WINDOW_MS`. Les valeurs doivent être des entiers positifs dans les plages supportées.

## Migrations

Les migrations SQL numérotées sont immuables et exécutées dans une transaction. Le runner vérifie leur checksum et sérialise les exécutions concurrentes avec un verrou PostgreSQL consultatif. Toute évolution doit ajouter un fichier de migration; ne pas modifier ou supprimer les migrations déjà appliquées. Les contraintes de suppression sont restrictives pour préserver les historiques.

Les tests utilisent PGlite, moteur PostgreSQL embarqué, pour appliquer les migrations sans serveur local. Ils ne remplacent pas un test de déploiement sur la version PostgreSQL de production.

## Authentification Steam et autorisations

`GET /auth/steam` démarre Steam OpenID 2.0. Le callback valide l’état lié à un cookie HttpOnly, contrôle les champs signés et `return_to`, puis demande au point de terminaison officiel Steam de vérifier la réponse. Les SteamID ne sont acceptés qu’après cette vérification. La création d’un compte inconnu crée un compte Bonobos actif `UTILISATEUR`; les comptes suspendus ne peuvent pas ouvrir de session.

Les sessions durent sept jours. Le cookie de session est HttpOnly, SameSite=Lax et Secure sous HTTPS; seule l’empreinte SHA-256 du jeton est conservée en PostgreSQL. Un cookie CSRF double-submit doit accompagner les requêtes mutantes faites avec une session cookie. `POST /v1/logout` révoque la session courante. L’identifiant de session n’est jamais renvoyé dans les réponses JSON.

Les permissions sont contrôlées dans l’API. Les rôles système `ADMINISTRATEUR` et `UTILISATEUR` sont créés par migration. Lors d’une connexion Steam vérifiée, chaque identité de la liste `INITIAL_ADMIN_STEAM_IDS` peut recevoir le rôle `ADMINISTRATEUR` une seule fois; tous les autres comptes reçoivent `UTILISATEUR`. Les réclamations initiales et leur journal d’activité sont conservés en base.

`POST /v1/bootstrap/claim-admin` n’accepte aucun SteamID fourni par l’appelant : il requiert une session authentifiée, puis vérifie que l’identité Steam déjà vérifiée en base correspond à un identifiant configuré côté serveur. L’opération est transactionnelle et chaque identifiant ne peut être réclamé qu’une fois. Une promotion ou rétrogradation ultérieure reste réservée aux administrateurs autorisés et n’est pas annulée par les connexions suivantes.

`GET /v1/me` expose le compte connecté et ses autorisations; `GET /v1/admin/permissions` fournit le catalogue des permissions aux administrateurs; `GET /v1/admin/users` liste les comptes; `PATCH /v1/admin/users/:userId` modifie leur nom ou statut; `PUT /v1/admin/users/:userId/role` modifie leur rôle. Ces actions sont vérifiées côté serveur et journalisées. La modification de rôle sur son propre compte est refusée et la suspension protège le dernier administrateur actif. Les changements administratifs révoquent les sessions des comptes suspendus.

## Authentification depuis l’application Tauri

Le client lance `/auth/desktop/start`, qui amorce le même flux OpenID Steam et lie la tentative à un défi PKCE. Steam revient au callback HTTPS du backend; celui-ci redirige ensuite vers le schéma de l’application avec un code temporaire à usage unique et l’état. Le client échange ce code contre une session via `/auth/desktop/exchange`; le vérificateur PKCE est stocké dans le magasin d’identifiants du système, tandis que le backend ne stocke que le hash du code temporaire.

Le navigateur externe ne partage pas ses cookies avec la WebView. L’échange desktop crée donc une session directement dans la WebView et utilise des cookies `HttpOnly`, `Secure`, `SameSite=None`; `/v1/me` fournit le jeton CSRF destiné aux requêtes mutantes cross-origin. Aucun identifiant de session, SteamID ou rôle ne transite dans le deep link.

Le client utilise `VITE_BONOBOS_API_URL`, défini au moment du build, comme origine de l’API. En développement, il utilise `http://127.0.0.1:8080` par défaut. Un build de production sans URL API explicite échoue à se connecter volontairement; configurer une origine HTTPS avant de produire le client et ajouter les origines requises à `BONOBOS_CORS_ORIGINS`. Les tests backend et de type ne remplacent pas la validation des cookies, du navigateur Steam et des retours deep link sur l’installation Windows réelle.

Les opérations CRUD de projets/configurations, la validation applicative du JSON de mise en page, le stockage serveur des objets et le déploiement restent à développer. Les mises en page locales restent exclusivement dans le dépôt `localStorage` de l’application.
