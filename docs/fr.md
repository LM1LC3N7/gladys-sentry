# Sentry

Suivez les projets de votre organisation **Sentry** dans Gladys : problèmes
non résolus, erreurs de la dernière heure et des dernières 24 heures, problème
le plus récent, et lancez une scène sur un **nouveau problème** ou un **pic
d'erreurs**. Fonctionne avec sentry.io (stockage aux États-Unis ou dans l'UE)
et avec un Sentry auto-hébergé. En lecture seule : Gladys ne change jamais rien
dans Sentry.

Intégration non officielle, sans lien avec Sentry. Elle n'a **jamais été testée avec un vrai Sentry** : elle est écrite d'après la documentation officielle de
l'API Sentry et testée contre un Sentry simulé. Les retours sont bienvenus.

## Ce qu'il faut

- Une organisation Sentry, sur sentry.io ou auto-hébergée.
- Un **jeton personnel** : dans Sentry, _User settings_, _Personal Tokens_,
  _Create New Token_, avec seulement les droits de lecture **org:read**,
  **project:read** et **event:read** (aucun droit d'écriture n'est utile). Un
  jeton d'organisation (`sntrys_…`) est limité aux versions et ne peut pas lire
  les problèmes.

## Configuration

- **Jeton d'authentification** : gardé par Gladys dans sa base, jamais
  réaffiché, envoyé seulement au Sentry choisi ci-dessous, dans l'en-tête
  `Authorization`. Il n'apparaît ni dans les journaux, ni dans le statut, ni
  dans les fichiers de l'intégration.
- **Où est votre Sentry ?** : _sentry.io, États-Unis_ (`sentry.io`), _sentry.io,
  Union européenne_ (`de.sentry.io` : voyez _Settings_, _General_, _Data
  Storage Location_ de votre organisation), ou _Sentry auto-hébergé_.
- **URL du Sentry auto-hébergé** (auto-hébergé seulement) :
  `https://sentry.exemple.fr`, avec un chemin si Sentry est derrière un proxy
  inverse (`https://exemple.fr/sentry`). Le certificat doit être accepté par un
  navigateur (un certificat auto-signé n'est pas encore pris en charge). Le
  `http://` simple n'est accepté que pour une adresse IP privée de votre réseau
  (`http://192.168.1.5:9000`) : ailleurs, le jeton traverserait Internet en
  clair.
- **Slug de l'organisation** : le nom court dans vos adresses Sentry
  (`https://<slug>.sentry.io` ou `/organizations/<slug>/`).
- **Projets** (facultatif) : les slugs des projets à suivre, séparés par des
  virgules, 20 au plus. Vide : les 20 premiers projets de l'organisation, dans
  l'ordre des slugs (le statut dit combien sont laissés de côté).
- **Rafraîchissement** : toutes les 5, 10 (par défaut), 15, 30 ou 60 minutes.
- **Seuil du pic d'erreurs** : 100 erreurs dans la dernière heure par défaut
  (de 10 à 1 000 000).

Appuyez sur **Tester la connexion** : le bouton lit une fois la liste des
projets (au plus une fois par minute) et dit combien de projets le jeton voit.

## Appareils

Chaque projet suivi apparaît dans l'onglet _Découverte_ ; ajoutez ceux que vous
voulez. Fonctionnalités (lecture seule) :

- **Problèmes non résolus** : les problèmes non résolus vus dans les 90
  derniers jours. Quand Sentry ne donne pas le total et qu'il y en a plus de 25,
  la valeur n'est pas publiée (un nombre inconnu n'est jamais affiché comme un
  chiffre).
- **Erreurs de la dernière heure** : les erreurs acceptées de l'heure en
  cours, plus la part de l'heure précédente encore dans les 60 dernières
  minutes.
- **Erreurs des dernières 24 h**.
- **Problème le plus récent** : le titre du dernier problème non résolu (`-`
  quand il n'y en a aucun).

## Déclencheurs de scène

- **Nouveau problème Sentry** : un nouveau problème non résolu, vu pour la
  première fois il y a moins de 2 heures selon l'horloge de Sentry. Filtres :
  le projet, les niveaux. Variables : nom du projet, titre, identifiant court,
  niveau, lien du problème. Jamais à la première lecture d'un projet (les
  problèmes déjà là ne sont pas « nouveaux ») ; la référence est gardée, donc un
  redémarrage ne répète aucun problème et ne perd pas ceux apparus moins de 2 heures avant. Cinq problèmes par projet et
  par lecture au plus (une rafale ne lance que cinq scènes).
- **Pic d'erreurs Sentry** : un projet compte, dans la dernière heure, au moins
  le seuil **et** trois fois son heure habituelle (la moyenne des heures
  complètes de la veille). Une fois par pic : il ne se déclenche de nouveau qu'après
  que les erreurs sont repassées sous la moitié du seuil. Pas à la première
  lecture, ni après un long trou sans lecture (2 intervalles). Variables : nom
  du projet, erreurs de la dernière heure, erreurs habituelles par heure,
  seuil.

Les scènes démarrent jusqu'à un intervalle de rafraîchissement après les faits.

## Requêtes et limites

Chaque tour envoie deux requêtes par projet (ses problèmes, ses erreurs), une
à la fois, plus la liste des projets une fois par heure (et au tour suivant
après une recherche dans Découverte). Avec 20 projets toutes les 10 minutes,
cela fait environ 240 requêtes par heure. Sentry déconseille les interrogations
fréquentes : gardez un intervalle long si vous suivez beaucoup de projets.

- Les en-têtes de limite de débit de Sentry sont lus : quand plus aucune
  requête ne reste dans la fenêtre de Sentry, la suivante attend la remise à
  zéro (10 s au plus, sinon le reste du tour attend le tour suivant, qui
  reprend là où il s'est arrêté).
- **HTTP 429** ou **5xx** : toutes les requêtes attendent (le `Retry-After` de
  Sentry, sinon 1 minute, doublée tant que cela dure, 6 heures au plus). La
  pause est gardée après un redémarrage ; le bouton de test n'envoie rien
  pendant ce temps.
- Une lecture d'un projet qui échoue (HTTP 403, 404, réponse inattendue) est
  espacée, en doublant jusqu'à une heure ; les autres projets continuent.
- Les réponses sont bornées en taille (2 Mo pour la liste des projets) et en
  durée (15 s) ; les redirections ne sont jamais suivies (le jeton suivrait).
- Un redémarrage (ou une reconnexion de Gladys) ne lit jamais plus tôt que
  l'intervalle : l'heure du dernier tour est gardée dans `/data`.

## Erreurs

- **Sentry a refusé le jeton (HTTP 401)** sur la liste des projets : plus rien
  n'est envoyé, même après un redémarrage, jusqu'à ce que vous enregistriez un
  nouveau jeton dans la configuration ou qu'un appui sur _Tester la connexion_
  réussisse. Un 401 sur les problèmes ou les erreurs d'un seul projet n'est pas
  pris pour un refus : la liste des projets est redemandée au tour suivant, et
  seule sa réponse décide.
- **HTTP 403** sur la liste des projets : il manque un droit au jeton
  (org:read, project:read, event:read).
- **HTTP 404** : mauvais slug d'organisation, ou mauvaise région (US / UE).
- **Redirection non suivie** : souvent la mauvaise région, ou une URL http qui
  redirige vers https.

## Vie privée

Gladys ne garde dans `/data` que l'heure du dernier tour, une pause demandée
par Sentry, les identifiants et dates d'apparition des problèmes les plus
récents (pour le déclencheur « nouveau problème ») et, après un refus, 8 bits
d'une empreinte salée de la configuration refusée (trop peu pour aider à
deviner un jeton ; effacés par un succès). Les titres des problèmes restent
dans Gladys (états des appareils, variables de scène) : ils peuvent citer des
données de vos applications.
