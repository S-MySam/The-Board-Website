/**
 * Cloudflare Worker — MySam CV Generator
 *
 * DÉPLOIEMENT :
 * 1. Créer un compte Cloudflare (gratuit) → https://dash.cloudflare.com
 * 2. Workers & Pages → Create Worker → coller ce code
 * 3. Settings → Variables → ajouter :  ANTHROPIC_API_KEY = <ta clé>
 * 4. Copier l'URL du worker (ex: https://mysam-cv.xxx.workers.dev)
 * 5. Dans accompagnement.html → remplacer WORKER_URL par cette URL
 *
 * FONCTIONNEMENT :
 * - Le frontend POST en JSON avec { userContent: "..." }
 * - Ce Worker appelle l'API Anthropic en gardant la clé côté serveur
 * - Retourne le JSON du CV structuré
 * - Rate limiting : 10 req/IP/heure (configurable)
 */

const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const MODEL          = 'claude-sonnet-4-6';
const MAX_TOKENS     = 4096;
const RATE_LIMIT_MAX = 10;    /* requêtes max par IP par heure */
const RATE_LIMIT_WIN = 3600;  /* fenêtre en secondes */

const SYSTEM_PROMPT = `Tu es un expert en rédaction de CV pour le marché français.
Tu reçois des informations brutes sur un candidat.
RETOURNE UNIQUEMENT un objet JSON valide. Aucun texte avant ou après. Aucun backtick.
Structure JSON :
{"poste_recherche":"","nom":"","contact":{"ville_cp":"","email":"","telephone":"","linkedin":""},"accroche":"3-4 lignes : qui tu es + ce que tu apportes + ce que tu cherches","competences":[{"categorie":"","items":[]}],"langues":[{"langue":"","niveau":""}],"experiences":[{"titre":"","entreprise":"","lieu":"","dates":"","bullets":[]}],"formations":[{"diplome":"","ecole":"","dates":"","detail":""}],"interets":[{"icone":"emoji","titre":"","detail":""}]}
RÈGLES :
- Compétences : 6-8 max groupées par thème
- Langues : niveau CECRL textuel (ex: "Courant C1")
- Expériences : ordre antéchronologique, bullets avec verbe d'action
- JAMAIS inventer des informations absentes`;

/* Simple rate limiter using Cloudflare KV (si disponible) ou en mémoire */
const inMemoryRateMap = new Map();

function getRateKey(ip) { return `rl:${ip}`; }

function checkRateLimit(ip) {
  const key = getRateKey(ip);
  const now = Date.now();
  const entry = inMemoryRateMap.get(key);

  if (!entry || now - entry.start > RATE_LIMIT_WIN * 1000) {
    inMemoryRateMap.set(key, { count: 1, start: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

function corsHeaders(origin) {
  const allowed = ['https://s-mysam.github.io', 'https://mysam-conseil.fr', 'http://localhost:3000'];
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin':  allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonResponse(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const ip     = request.headers.get('CF-Connecting-IP') || 'unknown';

    /* Preflight CORS */
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    /* Uniquement POST */
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Méthode non autorisée' }, 405, origin);
    }

    /* Rate limiting */
    if (!checkRateLimit(ip)) {
      return jsonResponse(
        { error: 'Trop de requêtes. Veuillez patienter avant de réessayer.' },
        429, origin
      );
    }

    /* Parse le body */
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Corps de requête invalide (JSON attendu)' }, 400, origin);
    }

    const userContent = (body.userContent || '').trim();
    if (!userContent || userContent.length < 10) {
      return jsonResponse({ error: 'Contenu insuffisant pour générer un CV.' }, 400, origin);
    }
    if (userContent.length > 8000) {
      return jsonResponse({ error: 'Contenu trop long (max 8000 caractères).' }, 400, origin);
    }

    /* Clé API depuis les Variables du Worker (jamais côté client) */
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return jsonResponse({ error: 'Service non configuré (clé API manquante côté serveur).' }, 500, origin);
    }

    /* Appel Anthropic API */
    let anthropicRes;
    try {
      anthropicRes = await fetch(ANTHROPIC_API, {
        method:  'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system:     SYSTEM_PROMPT,
          messages:   [{ role: 'user', content: userContent }],
        }),
      });
    } catch (networkErr) {
      return jsonResponse({ error: 'Erreur réseau lors de la connexion à l\'IA.' }, 502, origin);
    }

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text().catch(() => '');
      console.error('[Anthropic error]', anthropicRes.status, errBody);
      return jsonResponse(
        { error: `Erreur API (${anthropicRes.status}). Veuillez réessayer.` },
        502, origin
      );
    }

    const data = await anthropicRes.json();

    /* Extraire et valider le JSON du CV */
    const rawText = data?.content?.[0]?.text || '';
    let cvJson;
    try {
      const cleaned = rawText.replace(/```json\n?|```/g, '').trim();
      cvJson = JSON.parse(cleaned);
    } catch {
      console.error('[JSON parse error] rawText:', rawText.slice(0, 300));
      return jsonResponse({ error: 'L\'IA a retourné un format inattendu. Réessayez.' }, 500, origin);
    }

    return jsonResponse(cvJson, 200, origin);
  },
};
