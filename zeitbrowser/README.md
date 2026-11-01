# ZeitBrowser

Kleiner Android-Browser mit Tageslimits pro Domain (Standard: youtube.com, 10 Minuten).

- Zeit zählt nur, solange eine limitierte Seite im Vordergrund offen ist (auch Unterseiten wie m.youtube.com).
- 5 Minuten und 1 Minute vor Ende: Hinweis und Vibration. Oben läuft ein Countdown.
- Bei 0: Video stoppt, Sperrseite bis Mitternacht.
- Limits unter ⏱. Senken wirkt sofort, Erhöhen und Löschen erst ab morgen.
- Kein Tracking, alles bleibt auf dem Handy. Links in andere Apps (z. B. YouTube-App) werden nicht geöffnet.

## Installieren

GitHub baut die APK bei jedem Push automatisch. Download: Releases, "ZeitBrowser (neueste Version)", `ZeitBrowser.apk`.
Beim ersten Mal Installation aus unbekannten Quellen erlauben.

## Damit es kein Schlupfloch gibt

Die App hilft nur, wenn YouTube woanders nicht frei erreichbar ist:
- YouTube-App in Digitales Wohlbefinden auf 1 Minute setzen oder deinstallieren.
- In Brave youtube.com blockieren, z. B. über einen eigenen Filter `||youtube.com^` in den Shields-Einstellungen (Inhaltsfilter).
