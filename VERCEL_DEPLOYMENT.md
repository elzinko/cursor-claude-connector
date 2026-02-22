# 🔒 Guide de Déploiement Sécurisé sur Vercel

Ce guide vous explique comment déployer le Cursor Claude Connector sur Vercel de manière sécurisée.

## 📋 Prérequis

1. ✅ Compte Vercel (gratuit)
2. ✅ Compte GitHub avec le repository cloné
3. ✅ Compte Upstash (gratuit) pour Redis
4. ✅ Abonnement Claude (Pro ou Max)

## 🚀 Déploiement en 5 étapes

### Étape 1 : Préparer le repository

Assurez-vous que votre code est sur GitHub :

```bash
git add .
git commit -m "Prepare for Vercel deployment"
git push origin main
```

### Étape 2 : Déployer sur Vercel

#### Option A : Déploiement via le bouton (recommandé)

1. Cliquez sur le bouton de déploiement dans le README
2. Connectez votre compte GitHub
3. Sélectionnez le repository `cursor-claude-connector`
4. Vercel détectera automatiquement la configuration

#### Option B : Déploiement manuel

1. Allez sur [vercel.com](https://vercel.com)
2. Cliquez sur **"New Project"**
3. Importez votre repository GitHub
4. Vercel détectera automatiquement les paramètres

### Étape 3 : Configurer les variables d'environnement

⚠️ **IMPORTANT** : Configurez ces variables dans Vercel **AVANT** le premier déploiement.

Dans Vercel Dashboard → Votre projet → **Settings** → **Environment Variables** :

#### Variables requises

| Variable | Description | Exemple | Sécurité |
|----------|-------------|---------|----------|
| `API_KEY` | Clé secrète pour protéger votre proxy (générez une clé forte) | `votre-cle-secrete-123` | 🔒 **OBLIGATOIRE** |
| `UPSTASH_REDIS_REST_URL` | URL de votre base Redis Upstash | `https://xxx.upstash.io` | 🔒 **OBLIGATOIRE** |
| `UPSTASH_REDIS_REST_TOKEN` | Token d'authentification Redis | `xxx` | 🔒 **OBLIGATOIRE** |

#### Variables optionnelles

| Variable | Description | Recommandé |
|----------|-------------|------------|
| `CORS_ORIGINS` | Origines autorisées (séparées par des virgules) | Votre URL Vercel |
| `RATE_LIMIT_REQUESTS` | Nombre de requêtes par fenêtre (défaut: 100) | 100-200 |
| `RATE_LIMIT_WINDOW_MS` | Fenêtre de rate limiting en ms (défaut: 3600000 = 1h) | 3600000 |

#### 🔐 Générer une API_KEY sécurisée

Générez une clé forte et unique :

```bash
# Sur macOS/Linux
openssl rand -hex 32

# Ou utilisez un générateur en ligne sécurisé
# https://randomkeygen.com/
```

**Exemple de clé sécurisée** : `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6`

⚠️ **Ne partagez JAMAIS votre API_KEY publiquement !**

### Étape 4 : Configurer Redis (Upstash)

#### Option A : Via Vercel Marketplace (recommandé)

1. Dans votre projet Vercel → **Storage** tab
2. Cliquez sur **"Connect Store"** → **"Browse Marketplace"**
3. Recherchez **"Upstash Redis"**
4. Cliquez sur **"Add Integration"**
5. Créez une nouvelle base de données ou liez une existante
6. Les variables `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` sont **automatiquement injectées**

#### Option B : Configuration manuelle

1. Créez un compte sur [console.upstash.com](https://console.upstash.com/)
2. Créez une nouvelle base Redis (gratuite : 256 MB, 500K commandes/mois)
3. Copiez l'URL REST et le Token REST
4. Ajoutez-les dans Vercel → Environment Variables

### Étape 5 : Configurer CORS (sécurité)

Pour permettre à Cursor d'accéder à votre proxy :

1. Dans Vercel → Environment Variables
2. Ajoutez `CORS_ORIGINS` avec votre URL Vercel :
   ```
   CORS_ORIGINS=https://votre-app.vercel.app
   ```
   
   Pour plusieurs origines (si vous utilisez plusieurs domaines) :
   ```
   CORS_ORIGINS=https://votre-app.vercel.app,https://votre-domaine.com
   ```

⚠️ **NE PAS utiliser `CORS_ORIGINS=*` en production** - cela expose votre API à tous les sites web.

### Étape 6 : Déployer

1. Vercel déploiera automatiquement après chaque push
2. Ou cliquez sur **"Redeploy"** dans le dashboard pour appliquer les nouvelles variables d'environnement

## 🔐 Sécurité - Checklist

Avant de mettre en production, vérifiez :

- [ ] ✅ `API_KEY` est définie et forte (minimum 32 caractères)
- [ ] ✅ `CORS_ORIGINS` est configurée avec votre URL Vercel uniquement (pas `*`)
- [ ] ✅ Redis est configuré et accessible
- [ ] ✅ Les variables d'environnement sont définies pour **Production**, **Preview**, et **Development**
- [ ] ✅ Le repository GitHub est privé (si vous avez des secrets dans le code)
- [ ] ✅ `.env` est dans `.gitignore` (vérifié ✅)

## 🧪 Tester le déploiement

### 1. Vérifier que l'API répond

```bash
curl https://votre-app.vercel.app/v1/models \
  -H "Authorization: Bearer VOTRE_API_KEY"
```

Vous devriez voir la liste des modèles Claude.

### 2. Authentifier via OAuth

1. Ouvrez `https://votre-app.vercel.app/` dans votre navigateur
2. Cliquez sur **"Connect with Claude"**
3. Suivez le processus d'authentification OAuth
4. Vérifiez que vous voyez "You are successfully authenticated"

### 3. Configurer Cursor

1. Ouvrez Cursor → Settings → Models
2. Activez **"Override OpenAI Base URL"**
3. Entrez : `https://votre-app.vercel.app/v1`
4. Dans **"Anthropic API Key"**, entrez votre `API_KEY`
5. Redémarrez Cursor

## 🛡️ Mesures de sécurité implémentées

Ce projet inclut plusieurs mesures de sécurité :

### Headers de sécurité (vercel.json)

- ✅ `X-Content-Type-Options: nosniff` - Empêche le MIME sniffing
- ✅ `X-Frame-Options: DENY` - Empêche le clickjacking
- ✅ `X-XSS-Protection: 1; mode=block` - Protection XSS
- ✅ `Strict-Transport-Security` - Force HTTPS
- ✅ `Referrer-Policy: strict-origin-when-cross-origin` - Contrôle des référents

### Authentification

- ✅ Validation de l'API_KEY sur toutes les routes `/v1/*`
- ✅ OAuth avec Claude (pas de stockage de mots de passe)
- ✅ Tokens stockés de manière sécurisée dans Redis

### Rate Limiting

- ✅ Limite par défaut : 100 requêtes/heure par projet
- ✅ Configurable via variables d'environnement

### CORS

- ✅ Restriction des origines autorisées
- ✅ Headers CORS restreints (pas de wildcard `*` sur les headers)
- ✅ Support des credentials sécurisé

## 📊 Monitoring

### Logs Vercel

1. Allez dans Vercel Dashboard → Votre projet → **Logs**
2. Surveillez les erreurs et les requêtes

### Statistiques API

Accédez à `https://votre-app.vercel.app/api/stats` pour voir :
- Nombre total de requêtes
- Tokens utilisés
- Coût estimé
- Requêtes par heure

## 🔄 Mises à jour et maintenance

### Mettre à jour le code

```bash
git add .
git commit -m "Update code"
git push origin main
```

Vercel déploiera automatiquement.

### Changer les variables d'environnement

1. Vercel Dashboard → Settings → Environment Variables
2. Modifiez les valeurs
3. Cliquez sur **"Redeploy"** pour appliquer

### Révoquer l'accès OAuth

1. Visitez `https://votre-app.vercel.app/auth/logout`
2. Ou supprimez les tokens dans Redis via Upstash Console

## 🆘 Dépannage

### Erreur 401 Unauthorized

- Vérifiez que `API_KEY` est correctement configurée dans Vercel
- Vérifiez que vous utilisez la même clé dans Cursor
- Vérifiez que les variables d'environnement sont déployées (Production)

### Erreur 429 Rate Limit

- Augmentez `RATE_LIMIT_REQUESTS` dans les variables d'environnement
- Ou attendez la fin de la fenêtre de rate limiting

### Erreur de connexion Redis

- Vérifiez que `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN` sont corrects
- Vérifiez que la base Redis est active sur Upstash
- Vérifiez que vous avez redéployé après avoir ajouté les variables

### CORS errors dans Cursor

- Vérifiez que `CORS_ORIGINS` contient votre URL Vercel exacte
- Vérifiez que vous utilisez HTTPS (pas HTTP)
- Redéployez après modification de `CORS_ORIGINS`

## 📚 Ressources

- [Documentation Vercel](https://vercel.com/docs)
- [Documentation Upstash Redis](https://docs.upstash.com/redis)
- [Documentation Anthropic OAuth](https://docs.anthropic.com/claude/docs/oauth-authentication)

---

**✅ Une fois déployé, votre proxy est sécurisé et prêt à être utilisé avec Cursor !**
