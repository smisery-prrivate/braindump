# Braindump

Eine minimalistische PWA gegen vollen Kopf: alles rein, maximal fünf zählen.

**Prinzip: asymmetrische Reibung.** Gedanken loswerden ist reibungslos (tippen oder
sprechen, senden, weg). Zugriff und Priorisierung kosten bewusst Aufwand (Archiv
hinter Passwort). Im Archiv werden per Tipp (hell = mach ich auch) oder Doppeltipp
(dunkel = essenziell) maximal **fünf** Dinge gewählt — hart begrenzt. Unpriorisierte
Gedanken verblassen mit dem Alter und werden nach 30 Tagen gelöscht. Gewählt = gerettet.

- Reine Client-App: alle Einträge bleiben im localStorage des Geräts, nichts verlässt das Handy.
- Voice-Eingabe über die Web Speech API (Deutsch).
- Installierbar über "Zum Startbildschirm hinzufügen", läuft offline (Service Worker).

Konzept: siehe [CONCEPT.md](CONCEPT.md). Archiv-Demopasswort: `1234`.
