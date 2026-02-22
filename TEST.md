# 🧪 Test du Proxy

## Test Rapide

```bash
# 1. Vérifier que le serveur tourne
curl http://localhost:9095/

# 2. Lister les modèles disponibles
curl http://localhost:9095/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"

# 3. Tester une requête de chat
curl -X POST http://localhost:9095/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Say hello"}],
    "max_tokens": 20
  }'
```

## Vérifier les Logs

Après chaque requête, vous devriez voir dans les logs du serveur :

```
[default] claude-sonnet-4-6 | REQUEST START
[default] claude-sonnet-4-6 | 24→16 tokens | 1234ms | 200
```

## Stats Automatiques

Toutes les 5 secondes, les stats s'affichent automatiquement :

```
────────────────────────────────────────────────────────────────────────────────
📊 Stats: 5 requests | 2,000 tokens | $0.0123 | 5 req/h
────────────────────────────────────────────────────────────────────────────────
```

## API de Stats

```bash
# Obtenir les stats globales
curl http://localhost:9095/api/stats

# Obtenir les stats d'un projet spécifique
curl http://localhost:9095/api/stats?project=frontend

# Obtenir les logs récents
curl http://localhost:9095/api/stats/logs?limit=10
```
