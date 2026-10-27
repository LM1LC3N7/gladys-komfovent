# Komfovent pour Gladys

Affiche une ventilation double flux **Komfovent** à régulation **C6, C6M ou
C8** (Domekt, Kompakt, Verso…) dans Gladys, par son interface **Modbus TCP**
sur votre réseau local, sans cloud ni compte. Intégration non officielle,
**sans lien avec Komfovent**. **Jamais testé avec un vrai appareil** : elle
lit et écrit les registres décrits dans les manuels Modbus de Komfovent (C6 /
C6M et C8, édition 24-10) tels que les utilise l’intégration libre
hass-komfovent (Home Assistant) ; merci de signaler ce que vous constatez.

## Avant de commencer

- La centrale doit être sur votre réseau (prise RJ-45 de la régulation),
  joignable depuis Gladys sur le **port 502**. Donnez-lui une adresse IP fixe
  dans votre routeur (adresse d’usine : 192.168.0.60).
- Le Modbus TCP n’a **pas de mot de passe** : gardez la centrale sur un
  réseau de confiance.
- L’identifiant d’unité Modbus vaut 254 par défaut (valeur de
  hass-komfovent) ; changez-le seulement si votre centrale répond sur un
  autre.

## Installation

1. Installez l’intégration depuis le store de Gladys.
2. Saisissez l’**adresse IP de la centrale** (port 502 sauf si vous en
   ajoutez un) ; enregistrez.
3. Ouvrez l’onglet **Découverte** et ajoutez la centrale.

## Ce que vous obtenez

Un appareil, **Ventilation Komfovent**, avec :

| Fonctionnalité                                        | Remarques                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Températures de l’air soufflé, extrait et extérieur   | °C                                                                                                                             |
| Température et humidité du panneau                    | seulement si le panneau 1 est raccordé                                                                                         |
| Niveaux des ventilateurs de soufflage et d’extraction | %                                                                                                                              |
| Encrassement des filtres, rendement de l’échangeur    | % ; le rendement n’est pas publié ventilateurs arrêtés                                                                         |
| CO2 et humidité extraite (sondes 1 et 2)              | selon le type de sonde réglé sur la centrale ; non publiés ventilateurs arrêtés                                                |
| Mode de ventilation                                   | liste : absence, normal, intensif, boost                                                                                       |
| Mode en cours                                         | texte : `standby`, `away`, `normal`, `intensive`, `boost`, `kitchen`, `fireplace`, `override`, `holiday`, `air-quality`, `off` |
| Centrale en marche, ventilateurs en marche, ECO, AUTO | lecture seule, 1 = oui                                                                                                         |
| Défaut (alarme F), avertissement (alarme W)           | lecture seule, 1 = actif                                                                                                       |
| Alarmes actives, codes d’alarme                       | nombre ; texte `none` ou `F9, W1` (notation du manuel)                                                                         |
| Démarrer la centrale / Arrêter la centrale            | boutons                                                                                                                        |

Une valeur hors des plages du manuel (sonde absente, panneau non raccordé,
valeurs « non utilisée » de la C8) n’est jamais publiée : Gladys garde la
dernière valeur connue. Les débits d’air (m³/h, l/s ou % selon la régulation
et le réglage) ne sont pas publiés.

La centrale est lue toutes les 60 s (réglable de 30 s à 1 h), en cinq
requêtes sur une seule connexion, fermée ensuite. Le bouton de test, une
recherche dans Découverte, une reconnexion de Gladys ou un redémarrage de
l’intégration ne la relisent jamais avant l’intervalle. Lectures hors
intervalle :

- chaque commande relit la centrale juste avant d’écrire, puis relit la
  valeur écrite ;
- « Arrêter la centrale » et ses renvois ;
- 5 s puis 20 s après une commande non confirmée, ou après un arrêt qui suit
  un démarrage ou un mode non confirmé ;
- une nouvelle adresse ou un nouvel identifiant d’unité enregistré est lu
  aussitôt.

Les alarmes, les types de sondes et la version du micrologiciel sont lus en
dernier : s’ils ne répondent pas, les valeurs lues avant sont publiées quand
même, et le bloc en échec est relu une fois par heure.

## Commandes

Le changement de mode et « Démarrer la centrale » sont refusés tant que
**Autoriser les commandes** n’est pas activé (désactivé par défaut). Aucun
interrupteur : un « éteins tout » d’un assistant vocal n’atteint jamais la
ventilation.

- Chaque commande relit la centrale juste avant d’écrire (marche/arrêt, mode,
  état, type de régulation), n’écrit rien quand la valeur est déjà la bonne,
  et n’est confirmée que si la centrale renvoie l’écho de l’écriture puis
  relit la valeur demandée. Une relecture qui montre encore l’état d’avant
  répond « pas encore appliquée » ; une commande qui a pu atteindre la
  centrale sans être confirmée répond « envoyée, sans confirmation » :
  vérifiez la centrale quelques secondes plus tard. Une exception Modbus 1, 2
  ou 3 répond « refusée » (non appliquée) ; les autres exceptions répondent
  « envoyée, sans confirmation ». Une commande qui ne peut pas être écrite
  dans les 3,5 s est refusée et rien n’est envoyé.
- Refusés aussi : sur un **défaut** (alarme F), pendant que la centrale
  **s’arrête**, si le **type de régulation** lu diffère de celui appris (voir
  plus bas), si **/data** est illisible ou ne peut pas être écrit.
- Le **mode** est refusé sur une centrale **arrêtée ou en veille** (il la
  relancerait) et tant qu’un **arrêt envoyé depuis Gladys est gardé** :
  appuyez d’abord sur « Démarrer la centrale ».

### Arrêter la centrale

« Arrêter la centrale » écrit 0 dans le registre de marche/arrêt. Il ne
dépend **ni** de l’option, **ni** d’une autre commande (une commande pas
encore écrite est annulée), **ni** d’une lecture en cours ou bloquée (elle
est interrompue), **ni** d’un échec de lecture ou d’une attente entre deux
essais, **ni** du type de régulation, **ni** de /data, **ni** de la
configuration pas encore relue depuis Gladys (il part alors vers l’adresse
gardée dans /data). Il est réessayé pendant 3,5 s après l’appui.

Il peut échouer dans ces cas seulement, et la réponse le dit :

- aucune adresse connue (jamais configurée) : « non envoyée » ;
- la centrale n’est pas joignable dans les 3,5 s : « non envoyée » (ou « pas
  encore envoyé » s’il essaie encore) ;
- la centrale répond une exception Modbus 1, 2 ou 3 : « refusée » ;
- pas de réponse, écho faux ou centrale relue en marche : « envoyée, sans
  confirmation ».

L’arrêt est ensuite **gardé** (dans /data, avec l’adresse) : il n’est jamais
levé par le temps, seulement par un appui sur « Démarrer la centrale » (avec
l’option), ou quand la centrale est relue en marche **deux fois de suite**
après avoir été vue arrêtée (démarrée depuis son panneau). Tant qu’il est
gardé, une lecture qui trouve la centrale en marche avant de l’avoir vue
arrêtée (ou après un démarrage qui pouvait encore arriver) renvoie l’arrêt,
trois fois au plus ; le statut le signale. Un arrêt qui n’avait peut-être pas
abouti quand l’intégration s’est arrêtée est renvoyé à son redémarrage,
avant même de relire la configuration.

## Identité de la centrale

Le Modbus de Komfovent ne donne pas de numéro de série. L’appareil est donc
lié à la centrale de la configuration, jamais à son adresse IP (une nouvelle
adresse garde l’appareil et son historique). Le **type de régulation** (C6,
C6M, C8) est appris à la première lecture ; s’il change, un autre appareil
répond peut-être à cette adresse : le mode et le démarrage sont refusés
jusqu’à ce que « Tester la connexion » l’accepte (l’arrêt, lui, n’en dépend
pas). Deux centrales du même type ne se distinguent pas.

## Ce que l’intégration ne fait pas

Elle ne met jamais à jour le micrologiciel, ne règle ni l’horloge, ni les
consignes, ni les plannings, n’acquitte pas les alarmes et ne remet pas à
zéro le compteur des filtres.
