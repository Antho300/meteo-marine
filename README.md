# Météo marine — plongée et pêche

Application web personnelle d’Anthony Navarro pour consulter les conditions météo-marines autour des côtes de France métropolitaine : Manche, Atlantique, Méditerranée et Corse.

L’application est statique : HTML, CSS et JavaScript natifs, sans serveur applicatif. La carte utilise MapLibre GL JS et les prévisions affichées proviennent de fichiers JSON créés par le collecteur Python.

> **Sécurité en mer :** cette application est un outil informatif. Elle ne remplace pas les bulletins officiels de Météo-France, les consignes du CROSS, les cartes marines ni les informations nautiques officielles.

## Fonctionnalités

- Carte interactive plein écran, adaptée au mobile, avec points de grille cliquables.
- Couches météo pour le vent, les vagues, la température de l’eau, les courants et la bathymétrie.
- Menu des contrôles repliable et commandes de carte espacées pour faciliter l’usage sur mobile.
- Apparence générale au choix (`Bleu pétrole` par défaut ou `Clair`), modifiable depuis l’en-tête et mémorisée dans le navigateur.
- Styles de fond de carte OpenFreeMap et couche de profondeur/isobathes EMODnet.
- Prévisions horaires jusqu’à cinq jours, avec curseur temporel.
- Panneau détaillé au point choisi : vent, rafales, vagues, houle, température, courant, niveau marin, pression et profondeur EMODnet si disponible.
- Panneau inférieur redimensionnable jusqu’à presque tout l’écran en faisant glisser sa poignée ; le menu de gauche adapte automatiquement sa hauteur.
- Graphiques horaires sur 48 heures pour la température de l’eau, la hauteur des vagues et la vitesse du courant.
- Vecteurs mesurés aux points de grille et champ de vecteurs interpolé.
- Boussole compacte dans l’angle supérieur droit, avec points cardinaux et cap de la carte au centre.
- Estimation au clic par pondération des points de grille voisins ; les estimations sont signalées et ne constituent pas des observations locales.
- Heure de collecte affichée dans l’interface ; données manquantes indiquées par `n/d`.

## Données et limites

Le collecteur `scripts/fetch_data.py` interroge les API Open-Meteo par lots de coordonnées. Il récupère notamment :

- **Forecast API** : `wind_speed_10m`, `wind_gusts_10m`, `wind_direction_10m` et `pressure_msl`.
- **Marine API** : `wave_height`, `wave_period`, `wave_direction`, `swell_wave_height`, `swell_wave_period`, `swell_wave_direction`, `sea_surface_temperature`, `ocean_current_velocity`, `ocean_current_direction` et `sea_level_height_msl`.

Les valeurs Open-Meteo sont écrites dans `data/forecast.json`. Le vent et le courant sont fournis en km/h et convertis en nœuds dans l’interface ; les vagues et le niveau marin sont en mètres, les périodes en secondes et la température en degrés Celsius. Certaines variables marines peuvent être absentes, notamment près des terres ou hors de la couverture du modèle.

La grille, d’environ 150 à 240 positions, est indicative. L’interpolation au clic et la propagation des vecteurs lissent les valeurs entre points : elles ne tiennent pas compte précisément du trait de côte ni des obstacles sous-marins.

Le collecteur vérifie maintenant que les deux API répondent pour chacun des lots et renvoie un code d’erreur au moindre lot incomplet, sans remplacer le JSON déjà publié. Après avoir envoyé une modification du collecteur, vous pouvez relancer **Mettre à jour les prévisions marines** depuis l’onglet **Actions** du dépôt GitHub pour régénérer immédiatement les données.

La bathymétrie et la profondeur ponctuelle sont fournies par le WMS EMODnet Bathymetry. Les couches utilisées sont `emodnet:mean` (profondeur) et `emodnet:contours` (isobathes). La profondeur demandée au point estimé correspond aux coordonnées cliquées ; si elle n’est pas accessible, l’interface affiche `n/d`.

`sea_level_height_msl` est une hauteur par rapport au niveau moyen de la mer, et non une prédiction de marée portuaire. Le projet pourra accueillir ultérieurement une source de marée telle que le SHOM, sous réserve de ses conditions d’accès et de licence.

## Arborescence

```text
.
├── .github/
│   └── workflows/
│       └── update-data.yml   # collecte planifiée toutes les trois heures
├── data/
│   ├── forecast.example.json # exemple de format, données fictives
│   └── forecast.json         # prévisions utilisées par l’application
├── scripts/
│   └── fetch_data.py         # collecte et génération du JSON
├── app.js                    # interface et carte
├── config.js                 # cadrage et seuils modifiables
├── index.html
├── requirements.txt
└── style.css
```

## Lancer l’application en local

Pour afficher le site, aucun paquet Python n’est nécessaire. Depuis PowerShell, ouvrez le dossier du projet puis lancez un serveur statique :

```powershell
py -m http.server 8000
```

Ouvrez ensuite <http://localhost:8000>. Arrêtez le serveur avec `Ctrl+C`.

Le site a besoin d’être servi en HTTP (ne pas ouvrir `index.html` directement avec `file://`). Si `data/forecast.json` n’existe pas, il utilise `data/forecast.example.json` et affiche un avertissement indiquant que les données sont fictives.

### Régénérer les prévisions manuellement

Python 3.10 ou plus récent est requis pour le collecteur. Dans PowerShell, à la racine du projet :

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe .\scripts\fetch_data.py
```

Le collecteur appelle Open-Meteo ; il n’utilise pas de clé API côté navigateur. Les dépendances de l’environnement `.venv` ne doivent pas être publiées.

## Publier le projet sur GitHub

Le dépôt doit contenir le code du site, les fichiers de données et le workflow. **Tout dépôt public et le site GitHub Pages associé sont visibles par tous** ; ne publiez pas de données personnelles ou de secrets. Ce projet n’a pas besoin de clé API secrète.

1. Connectez-vous à [GitHub](https://github.com) et créez un dépôt vide avec **New repository**. Choisissez un nom, par exemple `meteo-marine`. Pour héberger gratuitement avec GitHub Pages, rendez le dépôt public. Ne cochez pas les options qui créent un README, un `.gitignore` ou une licence : ces fichiers existent déjà dans le dossier du projet.
2. Ouvrez PowerShell dans le dossier local du projet :

   ```powershell
   cd "C:\Users\Anthony\Desktop\ANTHO\Projets\carte_maritime"
   ```

3. Initialisez le dépôt local, ajoutez les fichiers et créez le premier commit :

   ```powershell
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   ```

   Si Git demande votre identité, configurez votre nom et votre adresse e-mail avec `git config --global user.name "Votre nom"` et `git config --global user.email "votre-adresse@example.com"`.

4. Remplacez `VOTRE-NOM` et `meteo-marine` par le nom de votre compte et celui du dépôt créés à l’étape 1, puis reliez et envoyez le projet :

   ```powershell
   git remote add origin https://github.com/VOTRE-NOM/meteo-marine.git
   git push -u origin main
   ```

   Si GitHub vous demande une authentification, utilisez la fenêtre de connexion ouverte par Git Credential Manager ou la méthode d’authentification proposée par GitHub ; un mot de passe de compte ne fonctionne pas comme mot de passe Git.

> Si `git init` indique que le dépôt existe déjà, ne le relancez pas et ne remplacez pas le dépôt : vérifiez d’abord `git status` et poursuivez avec `git remote -v` pour savoir s’il est déjà relié à GitHub.

## Hébergement gratuit avec GitHub Pages

GitHub Pages est le choix le plus direct pour ce site statique.

1. Après avoir envoyé les fichiers sur GitHub, ouvrez le dépôt, puis **Settings → Pages**.
2. Dans **Build and deployment**, choisissez **Deploy from a branch**.
3. Sélectionnez la branche `main` et le dossier `/(root)`, puis cliquez sur **Save**.
4. Attendez la fin de la publication. L’adresse est généralement :

   ```text
   https://VOTRE-NOM.github.io/meteo-marine/
   ```

   GitHub affiche aussi l’adresse du site dans **Settings → Pages**.

### Activer la collecte automatique des données

Le workflow `.github/workflows/update-data.yml` récupère les prévisions toutes les trois heures et peut aussi être lancé manuellement.

1. Dans le dépôt, ouvrez **Settings → Actions → General**.
2. À **Workflow permissions**, sélectionnez **Read and write permissions**, puis enregistrez.
3. Ouvrez **Actions**, sélectionnez **Mettre à jour les prévisions marines**, puis **Run workflow** pour faire une première collecte.
4. Vérifiez que l’exécution réussit et que `data/forecast.json` est présent dans le dépôt. Les prochaines exécutions sont planifiées automatiquement ; GitHub peut décaler leur démarrage.

Chaque collecte réussie met à jour le JSON et crée un commit automatique. Le site lit ce fichier avec un chemin relatif, ce qui fonctionne aussi pour une publication GitHub Pages à l’adresse d’un dépôt.

## Autre hébergement gratuit : Cloudflare Pages

Cloudflare Pages peut aussi servir ce site statique et se connecter au dépôt GitHub :

1. Dans le tableau de bord Cloudflare, ouvrez **Workers & Pages → Create application → Pages → Connect to Git**.
2. Sélectionnez le dépôt GitHub `meteo-marine` et la branche `main`.
3. Pour un site sans étape de compilation, laissez la commande de build vide et indiquez `/` comme répertoire de sortie.
4. Lancez le déploiement. Cloudflare fournira une adresse en `pages.dev`.
5. Activez également les Actions GitHub et les permissions d’écriture décrites ci-dessus : le workflow continue de mettre à jour `data/forecast.json`, et les mises à jour du dépôt sont publiées par Cloudflare.

Vous pouvez utiliser GitHub Pages **ou** Cloudflare Pages ; il n’est pas nécessaire de configurer les deux.

## Modifier la configuration et ajouter une source

- Modifiez les seuils d’indicateurs et le cadrage initial dans `config.js`.
- Pour ajouter une variable Open-Meteo, mettez à jour `scripts/fetch_data.py`, conservez `null` lorsqu’une valeur manque, puis ajoutez son affichage dans `app.js`.
- Décrivez la source, ses unités et ses limites de couverture dans cette documentation.

Les prévisions sont enregistrées avec le fuseau `Europe/Paris` et au format JSON compact.
