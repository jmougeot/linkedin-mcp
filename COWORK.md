# LinkedIn sur Claude Cowork

L'approche retenue pour Cowork est **efficace** : Cowork n'utilise PAS son
pilotage navigateur natif (lent, vision) mais appelle notre serveur comme
**connecteur MCP distant**, et c'est l'**extension Chrome locale** (manipulation
directe du DOM) qui exécute dans votre session LinkedIn.

```
Cowork ──MCP HTTPS──▶ serveur sur VM (file + quotas + délais) ──▶ extension locale ──▶ LinkedIn
```

Pourquoi cette voie : Cowork n'accepte que des **connecteurs MCP distants**
(pas de serveur MCP local). Il faut donc héberger le serveur sur une VM en
HTTPS. Toute la mise en place est décrite dans **[DEPLOY.md](DEPLOY.md)**.

En deux mots :
1. Déployer `server.js` sur la VM en mode `LI_TRANSPORT=http` avec un `LI_TOKEN`,
   derrière un reverse-proxy HTTPS (Caddy).
2. Ajouter le connecteur dans Claude/Cowork : URL `https://votre-domaine/mcp/<TOKEN>`.
3. Régler l'extension locale (popup) : adresse `https://votre-domaine`, jeton `<TOKEN>`.

Ensuite, dans Cowork : *« envoie un message LinkedIn à … »*, *« lis mes
conversations »* — avec les mêmes garde-fous anti-ban (quotas, délais, pause)
imposés par le serveur.

> L'alternative « tout natif » (demander à Cowork de cliquer lui-même dans
> LinkedIn) reste possible sans rien installer, mais elle est lente, fragile et
> sans garde-fous imposés — d'où le choix du connecteur ci-dessus.
