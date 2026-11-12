# Schussental Showdown 🚩🚗💥

Ein Browser-Autospiel im Capture-the-Flag-Stil: zwei Teams, Springen, Turbo, Minen, Rampen –
gespielt auf echten Stadtplänen von **Ravensburg** (Altstadt & Marienplatz), **Weingarten**
(Basilika) und **Friedrichshafen** (Hafen & Bodensee).

## Spielen & online stellen
**Variante A – GitHub Pages (wie Make-It-Meme):**
1. Repository auf **öffentlich** stellen (Settings → General → ganz unten „Change visibility“). GitHub Pages ist im Gratis-Tarif nur für öffentliche Repositories verfügbar.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. Nach 1–2 Minuten läuft das Spiel unter `https://marlonm05.github.io/CapturetheFlag/`. Jede Änderung auf `main` wird automatisch veröffentlicht.

**Variante B – Netlify:** `schussental-showdown-netlify.zip` auf <https://app.netlify.com/drop> ziehen oder das Repo per „Import from Git“ verbinden.
Wichtig: Unter *Site configuration → Access & security → Visitor access* muss der Seitenschutz **aus** sein, sonst sehen Freunde nur eine Netlify-Anmeldeseite.

Lokal: im Ordner `site` `python3 -m http.server` starten und `http://localhost:8000` öffnen.

## Online mit Freunden
1. **🌐 Online mit Freunden → Raum erstellen** – du bekommst einen 5-stelligen Code.
2. **🔗 Link kopieren** und verschicken (oder die anderen geben den Code unter „Raum beitreten“ ein).
3. Teams einteilen, Stadt wählen, **Match starten**. Freie Plätze füllen Bots auf (bis 12 Menschen).

Technik (wie Make-It-Meme): Räume, Codes und Lobby laufen über **Supabase Realtime** (Projekt „giffig“,
öffentlicher Browser-Schlüssel in `site/js/net.js`). Das Fahren läuft danach über eine **direkte WebRTC-Verbindung**
zwischen Host und Mitspielern (flüssig, ~20 Updates/s). Klappt die direkte Verbindung nicht (strenges WLAN, Mobilfunk),
leitet Supabase die Daten automatisch mit ~10 Updates/s weiter. In der Lobby steht bei jedem Spieler 🟢 *direkt* oder 🟡 *über Server*.

Hinweise:
- Der Host muss den Tab offen und im Vordergrund lassen.
- Verlässt jemand das Match, übernimmt ein Bot sein Auto.
- Supabase-Gratisprojekte werden nach einer Woche ohne Nutzung pausiert → im Supabase-Dashboard „Restore“ klicken.
- Gratis-Limit: 2 Mio. Realtime-Nachrichten/Monat. Direkte Verbindungen verbrauchen davon fast nichts.

## Grafik
Standardmäßig **3D** mit Three.js: echte Häuser aus OpenStreetMap mit Sattel-/Walmdächern, Schatten, 3D-Autos,
Bäume, Rampen und Flaggen. Für schwache Geräte lässt sich im Hauptmenü „3D-Grafik“ abschalten (klassische 2D-Ansicht).

## Inhalt
| Ordner | Was |
|---|---|
| `site/` | Das komplette Spiel (HTML/CSS/JS, keine Abhängigkeiten) |
| `site/js/maps.js` | Kartendaten, generiert aus OpenStreetMap |
| `site/img/fahrer/` | Fahrer-Porträts aus dem Drive-Ordner „Fette Bilder“ |
| `site/js/net.js` | Online-Modus (Supabase-Räume + WebRTC) |
| `site/js/render3d.js` | 3D-Ansicht (Three.js) |
| `site/js/vendor/` | Three.js r149 und supabase-js 2.118 (beide MIT-Lizenz) |
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
