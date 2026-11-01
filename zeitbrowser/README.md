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

## Wächter für Brave und die YouTube-App

Der Wächter (eine Android-Bedienungshilfe) zählt limitierte Seiten auch in Brave, Chrome, Firefox,
Samsung Internet und anderen Browsern sowie in der YouTube-App. Alles teilt sich dasselbe Tagesbudget.
Ist es aufgebraucht, holt er die Sperrseite nach vorne und das Video stoppt.

Einschalten (einmalig):
1. App-Info von ZeitBrowser öffnen, oben rechts ⋮, "Eingeschränkte Einstellungen zulassen" (Android 13+, weil die App nicht aus dem Play Store kommt).
2. Einstellungen, Bedienungshilfen, Installierte Apps, "ZeitBrowser Wächter" einschalten.

Der Wächter liest nur die Adressleiste der Browser. Gespeichert werden nur Minuten pro Domain, nichts verlässt das Handy.
