/* MySam CV Generator — Groq (GRATUIT) */

const GROQ_API = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL    = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `Tu es un expert en rédaction de CV pour le marché français.
Tu reçois des informations brutes sur un candidat.
RETOURNE UNIQUEMENT un objet JSON valide. Aucun texte avant ou après. Aucun backtick.
Structure JSON :
{"poste_recherche":"","nom":"","contact":{"ville_cp":"","email":"","telephone":"","linkedin":""},"accroche":"3-4 lignes : qui tu es + ce que tu apportes + ce que tu cherches","competences":[{"categorie":"","items":[]}],"langues":[{"langue":"","niveau":""}],"experiences":[{"titre":"","entreprise":"","lieu":"","dates":"","bullets":[]}],"formations":[{"diplome":"","ecole":"","dates":"","detail":""}],"interets":[{"icone":"emoji","titre":"","detail":""}]}
RÈGLES : Compétences 6-8 max groupées par thème. Langues niveau CECRL textuel. Expériences antéchronologiques bullets verbe action. JAMAIS inventer des infos absentes.`;

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (request.method !== 'POST') return json({ error: 'POST uniquement' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'JSON invalide' }, 400); }

    const userContent = (body.userContent || '').trim();
    if (!userContent) return json({ error: 'Contenu vide' }, 400);

    const apiKey = env.GROQ_API_KEY;
    if (!apiKey) return json({ error: 'Clé API manquante côté serveur' }, 500);

    const res = await fetch(GROQ_API, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userContent },
        ],
        temperature:      0.3,
        max_tokens:       4096,
        response_format:  { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[Groq error]', res.status, err);
      return json({ error: `Erreur Groq (${res.status})` }, 502);
    }

    const data    = await res.json();
    const rawText = data?.choices?.[0]?.message?.content || '';

    let cvJson;
    try {
      cvJson = JSON.parse(rawText.replace(/```json\n?|```/g, '').trim());
    } catch {
      return json({ error: 'Format inattendu, réessaie.' }, 500);
    }

    return json(cvJson, 200);
  },
};
