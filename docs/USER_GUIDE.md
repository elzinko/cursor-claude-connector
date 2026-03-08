# User Guide — Appeler le proxy Cursor Claude Connector

Guide pour utilisateurs et LLM : comment appeler ce proxy déployé sur Vercel.

---

## Base URL

```
https://elzinko-cursor-claude-connector.vercel.app/v1
```

---

## Authentification

Toutes les requêtes API nécessitent :

```
Authorization: Bearer <API_KEY>
```

`API_KEY` est le secret défini dans le fichier `.env`. Ce n’est pas une clé Anthropic.

---

## Prérequis

Avant d’appeler l’API, le proxy doit être authentifié avec Claude via OAuth :

1. Ouvre `https://elzinko-cursor-claude-connector.vercel.app/` dans un navigateur
2. Clique sur **"Connect with Claude"**
3. Connecte-toi avec ton compte Claude Pro/Max et autorise l’app
4. Une fois terminé, le proxy peut transmettre les requêtes à Anthropic

---

## Endpoints API

### Lister les modèles

```
GET /v1/models
Authorization: Bearer <API_KEY>
```

Retourne une liste de modèles au format OpenAI. IDs supportés :

| Model ID | Correspond à |
|----------|--------------|
| `claude-proxy-opus-4.6` | claude-opus-4-6 |
| `claude-proxy-sonnet-4.6` | claude-sonnet-4-6 |
| `claude-proxy-sonnet-4.5` | claude-sonnet-4-5 |
| `claude-proxy-haiku-4.5` | claude-haiku-4-5 |
| `claude-proxy` | claude-sonnet-4-6 (par défaut) |

### Chat completions (format OpenAI)

```
POST /v1/chat/completions
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

Corps de la requête (compatible OpenAI) :

```json
{
  "model": "claude-proxy-sonnet-4.6",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": false,
  "max_tokens": 4096,
  "temperature": 0.7
}
```

Endpoint alternatif (même comportement) :

```
POST /v1/messages
```

Le proxy convertit les requêtes au format OpenAI vers l’API Anthropic. Champs supportés : `model`, `messages`, `system`, `max_tokens`, `stream`, `temperature`, `top_p`, `top_k`, `tools`, `tool_choice`.

---

## Exemple : cURL

```bash
curl -X POST "https://elzinko-cursor-claude-connector.vercel.app/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-proxy-sonnet-4.6",
    "messages": [{"role": "user", "content": "Say hello"}],
    "stream": false,
    "max_tokens": 1024
  }'
```

---

## Exemple : JavaScript / fetch

```javascript
const response = await fetch('https://elzinko-cursor-claude-connector.vercel.app/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer YOUR_API_KEY',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'claude-proxy-sonnet-4.6',
    messages: [{ role: 'user', content: 'Say hello' }],
    stream: false,
    max_tokens: 1024,
  }),
});
const data = await response.json();
```

---

## Streaming

Mets `"stream": true` dans le corps de la requête. La réponse est en Server-Sent Events (SSE), format compatible OpenAI.

---

## Erreurs

| Status | Signification |
|--------|---------------|
| 401 | `API_KEY` invalide ou manquante |
| 401 | OAuth non effectué — visite l’URL du proxy et connecte-toi avec Claude |
| 429 | Limite de requêtes dépassée |
| 500 | Erreur proxy ou API Anthropic |

---

## Configuration Cursor IDE

Pour utiliser le proxy avec Cursor :

1. **Settings → Models** (`Cmd+Shift+J` / `Ctrl+Shift+J`)
2. Active **"Override OpenAI Base URL"** → `https://elzinko-cursor-claude-connector.vercel.app/v1`
3. Active **"OpenAI API Key"** → colle ton `API_KEY`
4. Ajoute un modèle personnalisé : `claude-proxy-sonnet-4.6` (ou un autre de la table ci-dessus)
