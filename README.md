# Schussental Showdown 🚩🚗💥

Ein Browser-Autospiel im Capture-the-Flag-Stil: zwei Teams, Springen, Turbo, Minen, Rampen –
gespielt auf echten Stadtplänen von **Ravensburg** (Altstadt & Marienplatz), **Weingarten**
(Basilika) und **Friedrichshafen** (Hafen & Bodensee).

## Spielen
- `site/index.html` öffnen (oder `python3 -m http.server` im Ordner `site` starten).
- Online stellen, Variante 1: `schussental-showdown-netlify.zip` auf <https://app.netlify.com/drop> ziehen – fertig.
- Online stellen, Variante 2: Auf Netlify „Add new site → Import from Git“ und dieses Repository wählen.
  Die `netlify.toml` sagt Netlify, dass das Spiel im Ordner `site/` liegt. Jede Änderung hier geht dann automatisch online.

## Online mit Freunden
1. Spiel auf Netlify hochladen (siehe oben) und die Seite öffnen.
2. **🌐 Online mit Freunden → Raum erstellen** – du bekommst einen 5-stelligen Code.
3. **🔗 Link kopieren** und an die anderen schicken (oder sie geben den Code unter „Raum beitreten“ ein).
4. Teams in der Lobby einteilen, Stadt wählen, **Match starten**. Freie Plätze füllen Bots auf (bis 12 Menschen).

Technik: WebRTC über [PeerJS](https://peerjs.com) (MIT-Lizenz, liegt in `site/js/vendor/`). Der kostenlose
PeerJS-Vermittlungsserver stellt nur die Verbindung her, danach läuft alles direkt zwischen den Geräten.
Der Host simuliert das Spiel und sendet 20× pro Sekunde den Zustand, die Mitspieler senden ihre Eingaben
und sagen ihr eigenes Auto lokal voraus (fühlt sich ohne Verzögerung an).

Hinweise:
- Der Host muss den Tab offen und im Vordergrund lassen, sonst bremst der Browser das Spiel.
- Verlässt jemand das Match, übernimmt ein Bot sein Auto.
- In sehr strengen Netzwerken (manche Firmen-/Schul-WLANs) kann WebRTC blockiert sein – dann über mobiles Netz oder ein anderes WLAN probieren.

## Inhalt
| Ordner | Was |
|---|---|
| `site/` | Das komplette Spiel (HTML/CSS/JS, keine Abhängigkeiten) |
| `site/js/maps.js` | Kartendaten, generiert aus OpenStreetMap |
| `site/img/fahrer/` | Fahrer-Porträts aus dem Drive-Ordner „Fette Bilder“ |
| `site/js/net.js` | Online-Modus (Räume, Lobby, Netzwerk) |
| `tools/build_maps.py` | Erzeugt `maps.js` aus OSM-Exporten (`pip install shapely scipy numpy pillow`) |

## Autos
| Auto | Stärke | Waffe |
|---|---|---|
| Schussen-Flitzer | sehr schnell | Doppel-MG |
| Hornisse | schnelles Feuer | Minigun |
| Mehlsack-Panzer | guter Schutz | Kanone (Flächenschaden) |
| Raketen-Rudi | explosiv | Zielsuch-Raketen |
| Allgäu-Bock | springt am höchsten | Schrotflinte |

Jedes Auto hat 6 Upgrades (Motor, Panzerung, Waffe, Feuerrate, Turbo, Sprungfeder) mit je 5 Stufen.
Bezahlt wird mit „Kohle“ aus Matches (Abschüsse, Flaggen, Siege). Der Spielstand liegt im Browser (localStorage).

## Neue Stadt hinzufügen
1. OSM-Ausschnitt laden: `https://api.openstreetmap.org/api/0.6/map?bbox=<minLon>,<minLat>,<maxLon>,<maxLat>` (ca. 800 × 650 m) als `<id>.osm` speichern.
2. Eintrag in `MAPS` in `tools/build_maps.py` ergänzen (Name, bbox, Basen in Metern).
3. `python3 tools/build_maps.py <osm-ordner> site/js/maps.js`

Kartendaten © OpenStreetMap-Mitwirkende, lizenziert unter ODbL.
