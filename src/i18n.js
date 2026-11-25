// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys: the connection status and the answer of the
// "Test" button are { en, fr }. No text of Sentry (an issue title, an error
// body) and nothing the user typed goes in a status.
// -----------------------------------------------------------------------------

import { CODES } from './sentry/http.js';

const plural = (n, one, many) => (n === 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));

/** Why a request failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.REDIRECT:
      return {
        en: `redirect (HTTP ${err.status}) not followed: check the region or the URL`,
        fr: `redirection (HTTP ${err.status}) non suivie : vérifiez la région ou l'URL`,
      };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.LIMITED:
      return { en: 'Sentry rate limit reached', fr: 'limite de débit de Sentry atteinte' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const join = (parts) => ({
  en: parts.map((p) => p.en).join(' '),
  fr: parts.map((p) => p.fr).join(' '),
});

export const T = {
  join,
  problems: {
    token_missing: {
      en: 'Enter a Sentry auth token.',
      fr: "Saisissez un jeton d'authentification Sentry.",
    },
    token_invalid: {
      en: 'The token holds a space or an invisible character: paste it again.',
      fr: 'Le jeton contient un espace ou un caractère invisible : collez-le de nouveau.',
    },
    url_missing: {
      en: 'Enter the URL of your self-hosted Sentry.',
      fr: "Saisissez l'URL de votre Sentry auto-hébergé.",
    },
    url_invalid: {
      en: 'The URL of the self-hosted Sentry is not valid (https://host[:port][/path], no user, no query).',
      fr: "L'URL du Sentry auto-hébergé n'est pas valide (https://hôte[:port][/chemin], sans utilisateur ni paramètres).",
    },
    url_http: {
      en: 'Plain http is accepted only for a private IP address (the token would cross the Internet in clear): use https.',
      fr: "Le http simple n'est accepté que pour une adresse IP privée (le jeton traverserait Internet en clair) : utilisez https.",
    },
    organization_missing: {
      en: 'Enter the slug of your Sentry organization.',
      fr: 'Saisissez le slug de votre organisation Sentry.',
    },
    organization_invalid: {
      en: 'The organization slug is not valid (lowercase letters, digits, - and _).',
      fr: "Le slug de l'organisation n'est pas valide (minuscules, chiffres, - et _).",
    },
  },
  status: {
    refused: {
      en: 'Sentry refused the token (HTTP 401): enter a valid token, or press "Test the connection". Nothing is sent until then.',
      fr: "Sentry a refusé le jeton (HTTP 401) : saisissez un jeton valide, ou appuyez sur « Tester la connexion ». Rien n'est envoyé d'ici là.",
    },
    forbidden: {
      en: 'Sentry denies the project list (HTTP 403): the token needs the org:read, project:read and event:read scopes. Tried again later.',
      fr: 'Sentry refuse la liste des projets (HTTP 403) : le jeton doit avoir les droits org:read, project:read et event:read. Nouvel essai plus tard.',
    },
    notFound: {
      en: 'Organization not found (HTTP 404): check its slug and the region (US or EU). Tried again later.',
      fr: 'Organisation introuvable (HTTP 404) : vérifiez son slug et la région (US ou UE). Nouvel essai plus tard.',
    },
    paused: (ms) => ({
      en: `Sentry asked to slow down: next request in ${minutes(ms)} min.`,
      fr: `Sentry demande de ralentir : prochaine requête dans ${minutes(ms)} min.`,
    }),
    failing: (reason) => ({
      en: `Sentry not read (${reason.en}). Tried again later.`,
      fr: `Sentry non lu (${reason.fr}). Nouvel essai plus tard.`,
    }),
    waiting: { en: 'Waiting for the first reading.', fr: 'En attente de la première lecture.' },
    dataUnreadable: {
      en: '/data unreadable: readings wait a whole interval.',
      fr: '/data illisible : les lectures attendent un intervalle entier.',
    },
    noProject: {
      en: 'No project to follow in this organization (or none the token may read).',
      fr: 'Aucun projet à suivre dans cette organisation (ou aucun que le jeton peut lire).',
    },
    summary: (followed, read, unresolved) => ({
      en: `${read}/${followed} ${plural(followed, 'project', 'projects')} read${unresolved === null ? '' : `, ${unresolved} unresolved ${plural(unresolved, 'issue', 'issues')}`}.`,
      fr: `${read}/${followed} projet${followed === 1 ? '' : 's'} lu${followed === 1 ? '' : 's'}${unresolved === null ? '' : `, ${unresolved} problème${unresolved === 1 ? '' : 's'} non résolu${unresolved === 1 ? '' : 's'}`}.`,
    }),
    partial: (reason) => ({
      en: `Some readings failed (${reason.en}).`,
      fr: `Certaines lectures ont échoué (${reason.fr}).`,
    }),
    notFollowed: (n) => ({
      en: `${n} more ${plural(n, 'project is', 'projects are')} not followed (20 at most: list the slugs to follow).`,
      fr: `${n} autre${n === 1 ? ' projet n’est' : 's projets ne sont'} pas suivi${n === 1 ? '' : 's'} (20 au plus : listez les slugs à suivre).`,
    }),
    missing: (n) => ({
      en: `${n} listed ${plural(n, 'project was', 'projects were')} not found.`,
      fr: `${n} projet${n === 1 ? ' listé est introuvable' : 's listés sont introuvables'}.`,
    }),
    invalidSlugs: (n) => ({
      en: `${n} invalid ${plural(n, 'entry', 'entries')} ignored in the project list.`,
      fr: `${n} entrée${n === 1 ? ' invalide ignorée' : 's invalides ignorées'} dans la liste des projets.`,
    }),
  },
  test: {
    ok: (count) => ({
      en: `Connected to Sentry: ${count} ${plural(count, 'project', 'projects')} visible.`,
      fr: `Connecté à Sentry : ${count} projet${count === 1 ? '' : 's'} visible${count === 1 ? '' : 's'}.`,
    }),
    tooSoon: (seconds) => ({
      en: `Tested less than a minute ago: try again in ${seconds} s.`,
      fr: `Testé il y a moins d'une minute : réessayez dans ${seconds} s.`,
    }),
  },
};
