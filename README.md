# Miro Vault

Browser-Erweiterung für **Firefox und Chrome** (Manifest V3, eine Codebasis), die

- die **Passwörter passwortgeschützter Miro-Boards** verschlüsselt und **ausschließlich lokal** speichert und beim nächsten Besuch automatisch einfügt,
- ein **Dashboard aller besuchten Boards** anzeigt (Suche, Sortierung, Notizen, Besuchszähler, Export/Import).

Die Erweiterung hat **keine Netzwerkberechtigungen** und sendet nichts irgendwohin. Berechtigungen: `storage` und Zugriff auf `https://miro.com/*`.

## Installation (Entwicklermodus)

**Chrome / Edge / Brave**
1. `chrome://extensions` öffnen, oben rechts den *Entwicklermodus* aktivieren.
2. *Entpackte Erweiterung laden* → den Ordner dieses Repositorys (mit der `manifest.json`) auswählen.

**Firefox**
1. `about:debugging#/runtime/this-firefox` → *Temporäres Add-on laden…* → `manifest.json` wählen.
   (Temporär = bis zum Neustart. Für eine dauerhafte Installation muss das Add-on über
   [addons.mozilla.org](https://addons.mozilla.org/developers/) signiert werden; „unlisted“ genügt, es wird dann nicht öffentlich gelistet.)
2. Firefox erteilt den Zugriff auf miro.com unter Umständen nicht automatisch: Im Dashboard erscheint dann ein Hinweis mit dem Button *Zugriff erlauben*.

Nach der Installation öffnet sich das Dashboard. Dort ein **Master-Passwort** anlegen. Später öffnet ein Klick auf das Erweiterungs-Icon das Dashboard.

## Funktionsweise

| Teil | Datei | Aufgabe |
|---|---|---|
| Content-Script | `content.js` | Läuft auf `miro.com/app/board/*`. Meldet Board-ID und -Titel, erkennt die Passwortabfrage, speichert das Passwort, sobald die Abfrage verschwindet (= Passwort war richtig), und fügt gespeicherte Passwörter ein. |
| Hintergrund | `background.js` | Gesamte Kryptografie und alle Schreibzugriffe. Content-Scripts erhalten nur das Passwort des Boards, auf dem sie gerade laufen. |
| Dashboard | `dashboard.html/.js/.css` | Board-Liste, Entsperren/Sperren, Passwörter anzeigen/kopieren/setzen, Einstellungen, Export/Import. |

**Erkennung der Passwortabfrage:** Es wird nicht auf Miro-spezifische CSS-Klassen gesetzt, sondern jedes sichtbare `<input type="password">` auf einer Board-Seite verwendet. Das ist robust gegenüber Layout-Änderungen von Miro. Wird ein falsches Passwort gespeichert, wird es beim nächsten richtigen Eingeben automatisch überschrieben.

## Sicherheitsmodell

- Beim Einrichten entsteht ein RSA-OAEP-Schlüsselpaar (3072 Bit). Der private Schlüssel wird mit AES-256-GCM verschlüsselt, der Schlüssel dafür wird per PBKDF2-SHA256 (600.000 Iterationen) aus dem Master-Passwort abgeleitet.
- Board-Passwörter werden hybrid verschlüsselt (AES-256-GCM + RSA-OAEP). Daher können **neue Passwörter auch bei gesperrtem Tresor gespeichert** werden; **lesen** und einfügen geht nur entsperrt.
- Entsperrt liegt der private Schlüssel nur in `storage.session` (Arbeitsspeicher, für Content-Scripts nicht lesbar). Er wird beim Schließen des Browsers verworfen, ebenso nach der einstellbaren Inaktivitätszeit (Standard 30 Minuten).
- **Unverschlüsselt** gespeichert sind die Board-Liste (IDs, Titel, Notizen, Zeitstempel). Wer Zugriff auf dein Browserprofil hat, sieht also, *welche* Boards du besucht hast, aber nicht deren Passwörter.
- Master-Passwort vergessen bedeutet: Die gespeicherten Passwörter sind verloren. Es gibt keine Wiederherstellung.

## Grenzen

- Liegt die Passwortabfrage von Miro einmal in einem iframe oder in einem *geschlossenen* Shadow DOM, wird sie nicht erkannt. Dann muss `content.js` angepasst werden.
- Die Option „Automatisch bestätigen“ sucht neben dem Passwortfeld einen Button wie „Continue“ oder „Weiter“. Deshalb ist sie standardmäßig aus.

## Test

Die Abläufe (Anlegen des Tresors, Erkennen des Boards, kein Speichern bei falschem Passwort, Speichern bei richtigem, Auto-Fill, kein Auto-Fill wenn gesperrt, Entsperren, Anzeigen im Dashboard) wurden automatisiert in Chromium gegen eine nachgebaute Miro-Passwortseite getestet. Gegen das echte miro.com ist ein Test mit einem echten geschützten Board noch nötig.
