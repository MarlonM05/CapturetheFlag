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

## Spielmechanik (Motor-Wars-Stil)
- **Fahrzeugklassen** (vor jedem Match frei wählbar, auch in der Online-Lobby):
  Schussen-Flitzer (ausgewogen, Doppel-MG) · Hornisse (schneller Buggy, Minigun, wenig Panzerung) ·
  Mehlsack-Panzer (schwerer Truck, Kanone mit Nachladezeit) · Raketen-Rudi (Zielsuch-Raketen) · Allgäu-Bock (Springer, Schrotflinte).
- **Drift:** `Q` + Lenken – Heck bricht aus, engere Kurven bei vollem Tempo.
- **Sprung + Nitro:** `Leertaste` springt auch im Stand; `Shift` in der Luft gibt Schub und Auftrieb → gleiten/fliegen, solange das Nitro reicht.
- **XP im Match:** Abschuss 100, Assist 40, Flagge klauen 50, Rettung 60, Punkt 300. Alle 200 XP ein Upgrade für die laufende Runde:
  `1` Tempo (+7 %), `2` Panzerung (+15 %), `3` Waffe (+12 %), je max. 3 Stufen. Bots leveln mit.
- **Karten:** 25 % größer, Häuserblöcke nach innen verkleinert → breitere Straßen; Bäume sind nur Deko; Rampen nur mit freier Anlauf- und Landebahn.
- Wandkontakt kostet kaum noch Panzerung (nur harte Frontalcrashs).

## Namen, Bots, Admin
- Eigener **Name** im Hauptmenü (Pflicht für Online). Profilbild optional (Menü „Profilbild“).
- In der Online-Lobby kann der Host **KI-Bots an/aus** schalten.
- **Bilder-Admin:** `admin.html` (Link „Admin“ unten im Hauptmenü). Anmeldung mit demselben Owner-Passwort wie die
  Giffig-/Make-It-Meme-Admin-Seite. Dort Profilbilder ein-/ausschalten, umbenennen, neue hochladen (werden auf 256×256 verkleinert)
  oder hochgeladene löschen. Das Spiel zeigt nur aktive Bilder (auch bei Bots). Technik: Tabelle `ctf_images`,
  Speicher `ctf-images` und Edge Function `ctf-admin` (Quelltext in `supabase/functions/ctf-admin/`) im Supabase-Projekt „giffig“.

## Grafik & Kamera
- **3D** mit Three.js: Häuser aus OpenStreetMap mit Fassaden, Fenstern, Ziegel-, Sattel- und Walmdächern, Schatten,
  echte Straßen mit Asphalt, Mittelstreifen, Gehwegen, Bordsteinen und Laternen, 3D-Autos, Bäume, Rampen, Flaggen.
- **Drohnen-Kamera** (Standard, Turm zielt unabhängig mit der Maus; gelber Ring = aktuelle Turmrichtung): knapp hinter und über dem Auto, folgt weich und steigt über Häuser im Weg.
  Taste **C** (am Handy „KAMERA“) wechselt zur Ansicht von oben.
- Für schwache Geräte: im Hauptmenü „3D-Grafik“ abschalten (klassische 2D-Ansicht).

## Netzcode
Jeder Spieler steuert sein eigenes Auto selbst und meldet nur die Position (keine Eingabeverzögerung, egal wie gut
die Verbindung ist). Der Host entscheidet über Treffer, Flaggen, Bots und Neustarts. Positionsdaten laufen über
einen schnellen WebRTC-Kanal ohne Nachsenden (kein Stau bei Paketverlust), Ereignisse über einen sicheren Kanal.

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
