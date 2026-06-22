# Briefing: Dynamische Open-Graph-Cards für DRepTalk

## 0. Kontext

Wir generieren Share-Bilder (das Vorschaubild beim Teilen auf X/Twitter, Discord,
Telegram) zur Laufzeit aus echten Daten. Du lieferst **keine fertigen Bilder**,
sondern **zwei Layout-Vorlagen plus Bausteine**. Der konkrete Text (Titel, Name,
Zahlen) und der DRep-Avatar werden vom System eingesetzt.

Zwei wichtige Grundregeln vorab:

1. **Nur ein Theme, hell.** Ein Vorschaubild kann sich nicht an den Dark-/Light-Mode
   des Betrachters anpassen, es ist immer dasselbe Bild. Also: ein fixes, helles
   Design auf weißem Grund (passend zum bestehenden hellen `og.png`).
2. **Technische Render-Beschränkung (bindend, sonst rendert es nicht 1:1):** Das
   Layout wird mit einer Flexbox-Engine gerendert. Erlaubt sind: Flexbox-Anordnung,
   Vollton-Flächen, einfache lineare Verläufe, eingebettete SVG/PNG, echter Text.
   Nicht möglich: Schlagschatten, Blur, `filter`, Glow, CSS-Grid, überlappende
   Effekte, ausgefallene Maskierungen. Halte das Design flach und Flexbox-bar.

---

## 1. Canvas & Raster (gilt für beide Cards)

- **Format: exakt 1200 x 630 px** (Standard für alle Plattformen).
- **Hintergrund:** Vollton Weiß `#ffffff`.
- **Sicherheitsrand:** 44 px links/rechts, 40 px oben/unten. Alle Inhalte innerhalb.
- **Akzentbalken links:** senkrechter Balken, volle Höhe 630 px, Breite 12 px. Das ist
  das einzige Element, das pro Governance-Typ die Farbe wechselt (plus die Farbe des
  Typ-Pills). Bei der DRep-Card hat er die Marken-Akzentfarbe.
- Schrift überall: **Plus Jakarta Sans**.

---

## 2. Card A: Governance Action

Drei horizontale Zonen von oben nach unten.

**Zone 1, Kopf (oben):**

- Links: Logo-Mark 44 x 44 px + Wortmarke "DRepTalk", 28 px, Gewicht 700.
- Rechts: Typ-Pill, Text = Aktionstyp ("Treasury Withdrawal", "Parameter Change"
  usw.), 24 px, Gewicht 600, Innenabstand 12 x 24 px, voll abgerundet. Hintergrund =
  Akzentfarbe bei 12 % Deckkraft, Text = volle Akzentfarbe.

**Zone 2, Titel (Mitte, das Herzstück):**

- Der Aktionstitel. 56 px, Gewicht 800, Zeilenhöhe 1.15, Farbe `#14101c`, Laufweite
  leicht negativ (ca. -1 px).
- Max. 3 Zeilen, danach Ellipse. Max. Breite ca. 1000 px.
- Das ist das, was jede Card unverwechselbar macht. Größtmögliche Lesbarkeit hat
  Priorität vor Deko.

**Zone 3, Daten-Anker (unten):**

- Status-Badge, z. B. "Active", 26 px, Gewicht 700, Akzent-getönt.
- Meta-Zeile daneben: "~3 days left, epoch 294, by Intersect", 24 px, Gewicht 500,
  Farbe `#5f6672`.
- Tally-Balken: volle Inhaltsbreite, Höhe 20 px, abgerundet 10 px. Drei Segmente
  Yes/No/Abstain.
- Darunter Labels: "62% Yes, 9% No, 29% Abstain", 24 px (Zahlen 700, Rest 500).

---

## 3. Card B: DRep

Gleicher Rahmen, gleiche drei Zonen.

**Zone 1, Kopf:** Logo + Wortmarke wie oben, dazu ein kleines Pill "DRep"
(Marken-Akzent getönt).

**Zone 2, Identität (Mitte):**

- Avatar links: 160 x 160 px, abgerundetes Quadrat (Radius 24 px). Wird vom System
  generiert (cardenticon), du musst ihn nicht liefern, aber im Layout den Platz und
  die Form definieren.
- Rechts daneben: Name, 64 px, Gewicht 800 (bei langem Namen auf 48 px / 2 Zeilen).
  Darunter die gekürzte ID "drep1qy8x…f3k2", 24 px, Gewicht 500, monospaced, Farbe
  `#9aa0aa`.

**Zone 3, Statistik (unten):** drei Blöcke nebeneinander, Abstand 64 px:

- "12.4M ₳" / "voting power", "0.83%" / "influence", "47" / "votes cast".
- Wert: 40 px, Gewicht 800. Label darunter: 22 px, Gewicht 500, `#5f6672`.

---

## 4. Farb-Tokens (verbindlich, exakt diese Hex)

Damit die Cards zur Seite passen. Pro Governance-Typ wechselt nur Akzentbalken + Typ-Pill.

| Verwendung | Hex |
|---|---|
| Marken-Akzent (DRep-Card, Pills) | `#6d28d9` |
| Treasury | `#15692e` |
| Parameter | `#2563c9` |
| Constitution | `#7c3aed` |
| Info | `#5b54d6` |
| Hard Fork | `#b45309` |
| Committee | `#0f766e` |
| No Confidence | `#b1281c` |
| Text dunkel (Ink) | `#14101c` |
| Text gedämpft | `#5f6672` |
| Haarlinie / Rahmen | `#e3e6ea` |
| Tally Yes | `#5cb88a` |
| Tally No | `#e07d75` |
| Tally Abstain | `#cfd3d8` |

Pill-Hintergrund = jeweilige Akzentfarbe bei 12 % Deckkraft auf Weiß; Pill-Text =
volle Akzentfarbe.

---

## 5. Zustände, die du mitdesignen musst

Echte Daten sind unsauber. Bitte je Card diese Varianten als Frames.

**Governance Action:**

- kurzer Titel (1 Zeile) und langer Titel (3 Zeilen + Ellipse).
- mit Tally und ohne Tally (noch keine Stimmen): statt Balken ein Pill "Voting open".
- Status abgeschlossen (z. B. "Enacted" grün, "Expired"/"Dropped" rot/grau):
  Badge-Farbe ändert sich.
- mit und ohne Proposer-Zeile.

**DRep:**

- langer Name (Umbruch) und kein Name (nur Avatar + gekürzte ID, dann größer).
- große vs. kleine Zahlen ("12.4M ₳" vs. "850 ₳").

---

## 6. Was du als Dateien lieferst

1. **Figma-Datei** mit beiden Master-Frames (1200 x 630) inkl. aller Zustände aus
   Punkt 5, mit den exakten Maßen/Farben oben.
2. **Schrift:** Bestätigung der genutzten Gewichte (Empfehlung: 800 für Titel/Werte,
   600 für Pills, 500 für Meta). Bitte statische Schnitte dieser Gewichte als TTF/OTF
   mitliefern (wir haben aktuell nur eine variable woff2; die Render-Engine arbeitet
   zuverlässiger mit statischen Schnitten).
3. **Logo** als sauberes SVG plus eine einfarbige Variante für die Ecke; bitte
   gegenchecken, dass es bei 44 px noch klar lesbar ist.
4. **Referenz-PNGs** beider Cards in exakt 1200 x 630 (zum Abgleich mit dem
   gerenderten Ergebnis).
5. Optional: ein dezentes Hintergrund-Element (z. B. sehr blasses Logo-Wasserzeichen
   in einer Ecke oder ganz feiner Verlauf oben), als einzelnes wiederverwendbares SVG
   für beide Cards.

Zur Orientierung und Markenkontinuität: die bestehenden Bilder liegen unter
`public/og/` (7 Typ-Cards + `discussion.png`) und `public/og.png`.
