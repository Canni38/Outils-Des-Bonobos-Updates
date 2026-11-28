# Bonobos FR — Procédure de déploiement OVHcloud VPS-1

## Prérequis
- VPS Ubuntu LTS, 2 vCores, 4 Go RAM, 40 Go NVMe.
- Domaine HTTPS pointant vers le VPS (à définir).
- Docker et Docker Compose installés.
- Nginx et certbot installés.

## Étapes
1. Installer Docker : https://docs.docker.com/engine/install/ubuntu/
2. Cloner le dépôt (sans `.env`).
3. Créer `backend/.env` et `backend/.env.local` avec les valeurs de production (secrets injectés hors dépôt).
4. Lancer PostgreSQL + backend : `docker compose -f deploy/docker-compose.prod.yml up -d`.
5. Exécuter les migrations : `docker compose exec backend npm run migrate` (ou depuis l'hôte).
6. Installer Nginx et copier `deploy/nginx/bonobos.conf` dans `/etc/nginx/sites-available/`.
7. Obtenir le certificat : `certbot --nginx -d bonobos.example.com`.
8. Activer le site et recharger Nginx.
9. Configurer UFW : autoriser SSH, 80, 443 uniquement.
10. Installer fail2ban.
11. Configurer le cron de sauvegarde : `/etc/cron.d/bonobos-backup`.
12. Tester la restauration dans un environnement isolé.

## Sauvegardes
- Script : `deploy/scripts/backup.sh`
- Fréquence recommandée : quotidienne.
- Externaliser vers un stockage OVH ou autre.
- Tester la restauration trimestriellement.

## Rotation des secrets
- Modifier `POSTGRES_PASSWORD` dans les fichiers d'environnement.
- Redémarrer les conteneurs.
- Mettre à jour `DATABASE_URL` en conséquence.

## Hardening Ubuntu
- Mises à jour automatiques via unattended-upgrades.
- Utilisateur non-root pour Docker.
- Désactiver l'authentification par mot de passe SSH.
- Rotation des logs Docker et Nginx.

## Monitoring
- Health checks : `/health/live`, `/health/ready`.
- Surveiller l'espace disque, la RAM et les logs.

## Restrictions
- Ne jamais exposer PostgreSQL sur Internet.
- Ne jamais publier le port 5432.
- Ne jamais committer de secrets.
