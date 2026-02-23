# 🎯 Guide de Configuration Cursor avec le Proxy Local

## 📋 Prérequis

1. ✅ Le serveur proxy est démarré et accessible sur `http://localhost:9095`
2. ✅ Vous avez authentifié via OAuth (visitez `http://localhost:9095/` si nécessaire)
3. ✅ Votre `API_KEY` est configurée dans `.env`

## 🔧 Configuration dans Cursor

### Étape 1 : Ouvrir les Paramètres Cursor

1. Ouvrez Cursor
2. Allez dans **Settings** (⚙️) ou utilisez `Cmd+,` (Mac) / `Ctrl+,` (Windows)
3. Recherchez **"Models"** ou **"AI"** dans la barre de recherche

### Étape 2 : Configurer l'Override OpenAI Base URL

1. Trouvez l'option **"Override OpenAI Base URL"**
2. ✅ **Activez-la** (toggle ON)
3. Entrez l'URL : `http://localhost:9095/v1`
   - ⚠️ **Important** : Incluez bien `/v1` à la fin

### Étape 3 : Configurer l'API Key

1. Trouvez le champ **"Anthropic API Key"** ou **"OpenAI API Key"**
2. Entrez la valeur de votre `API_KEY` depuis `.env`
   - Dans votre cas : `dezuiofhleknxlcshdciurfizo16542@gchxAA`
   - ⚠️ **Note** : Cette clé sert uniquement à identifier votre projet dans les logs. L'authentification réelle se fait via OAuth.

### Étape 4 : Sélectionner le Modèle

Le proxy supporte tous les modèles Claude. Vous pouvez utiliser :

**Modèles récents (recommandés)** :
- **`claude-sonnet-4-6`** ⭐ (le plus récent, recommandé)
- **`claude-opus-4-6`** (le plus puissant)
- **`claude-haiku-4-5`** (le plus rapide)

**Modèles précédents** :
- `claude-3-5-sonnet-20241022`
- `claude-3-opus-20240229`
- `claude-3-haiku-20240307`

> 💡 **Note** : Utilisez les modèles récents (`claude-sonnet-4-6`, etc.) pour les meilleures performances.

**Dans Cursor** :
1. Allez dans **Settings → Models**
2. Sélectionnez le modèle Claude de votre choix
3. Ou utilisez le sélecteur de modèle dans l'interface

### Étape 5 : Vérifier la Connexion

1. Redémarrez Cursor (recommandé après changement de config)
2. Testez avec une requête simple dans le chat
3. Vérifiez les logs du serveur pour confirmer les requêtes

## 🔍 Vérification

### Vérifier que le serveur fonctionne

```bash
# Dans votre terminal où tourne le serveur, vous devriez voir :
✅ Already authenticated
📋 Cursor configuration :
   Base URL : http://localhost:9095/v1
   API Key : dezu******
```

### Tester l'API directement

```bash
curl http://localhost:9095/v1/models \
  -H "Authorization: Bearer dezuiofhleknxlcshdciurfizo16542@gchxAA"
```

Vous devriez voir la liste des modèles Claude disponibles.

## 📊 Monitoring des Requêtes

Une fois configuré, vous verrez dans les logs du serveur :

```
[default] claude-3-5-sonnet-20241022 | 150→250 tokens | 1234ms | 200
📊 Stats: 5 requests | 2,000 tokens | $0.0123 | 5 req/h
```

## 🎯 Modèles Disponibles

Le proxy expose automatiquement ces modèles via `/v1/models` :

- `claude-3-5-sonnet-20241022` ⭐ (recommandé)
- `claude-3-opus-20240229`
- `claude-3-sonnet-20240229`
- `claude-3-haiku-20240307`

## ⚠️ Dépannage

### Le proxy ne répond pas

1. Vérifiez que le serveur tourne : `curl http://localhost:9095/`
2. Vérifiez les logs pour les erreurs
3. Assurez-vous que le port 9095 n'est pas utilisé par un autre processus

### Erreur 401 Unauthorized

1. Vérifiez que vous avez bien authentifié via OAuth (`http://localhost:9095/`)
2. Vérifiez que votre `API_KEY` dans Cursor correspond à celle dans `.env`
3. Redémarrez Cursor après changement de config

### Erreur 429 Rate Limit

Le rate limiting est configuré par défaut à 100 requêtes/heure par projet.
Vous pouvez ajuster dans `.env` :
```env
RATE_LIMIT_REQUESTS=200
RATE_LIMIT_WINDOW_MS=3600000
```

### Cursor n'utilise pas le proxy

1. Vérifiez que "Override OpenAI Base URL" est bien activé
2. Vérifiez l'URL : doit être exactement `http://localhost:9095/v1`
3. Redémarrez Cursor complètement
4. Vérifiez les logs réseau de Cursor (si disponible)

## 🚀 Utilisation Avancée : Multi-Projets

Si vous voulez identifier différents projets dans les logs :

1. Configurez plusieurs API keys dans `.env` :
```env
API_KEY=frontend-abc123,backend-xyz789,mobile-def456
```

2. Utilisez différentes clés dans différents projets Cursor
3. Les logs afficheront : `[frontend]`, `[backend]`, `[mobile]`

## 📈 Statistiques en Temps Réel

Accédez aux stats via :
- **API** : `http://localhost:9095/api/stats`
- **Logs** : Affichés automatiquement toutes les 5 secondes dans le terminal

---

**✅ Une fois configuré, toutes vos requêtes Cursor passeront par votre proxy Claude !**
