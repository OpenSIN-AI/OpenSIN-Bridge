# 🚨🚨🚨 OPENSIN-BRIDGE VISION GATE MANDATE (PRIORITY -7.0 — ABSOLUTE OBERSTE REGEL, ÜBER ALLEM, KEINE AUSNAHMEN, SOFORTIGER PERMANENTER BAN BEI VERSTOSS) 🚨🚨🚨

**KEIN AGENT DARF JEMALS WIEDER EINE EINZIGE AKTION IM WEB AUSFÜHREN OHNE VORHERIGE VISUELLE VERIFIKATION DURCH DAS VISION-MODELL.**

**DAS PROBLEM:** Agenten haben blind drauflosgeklickt — Surveys gestartet, Modals bestätigt, Tabs geöffnet — aber NIEMALS wirklich verifiziert was auf dem Bildschirm passiert. Endlosschleifen, falsche Klicks, verlorene Sessions. DAS IST VORBEI.

**DIE LÖSUNG: OpenSIN-Bridge + Gemini Vision Gate = PFLICHT bei JEDER Web-Interaktion.**

## 1. ABSOLUTES AUTORUN-VERBOT (KEINE AUSNAHMEN)

- **AUTORUN IST PERMANENT VERBOTEN.** Kein Agent darf jemals eine Sequenz von Web-Aktionen "am Stück" ausführen ohne zwischen JEDER einzelnen Aktion den Bildschirm zu fotografieren und durch das Vision-Modell prüfen zu lassen.
- **AUTORUN = Die größte Einschränkung die eine LLM überhaupt nur haben kann.** Ein LLM SIEHT NICHT was auf dem Bildschirm passiert. Es RÄT. Und Raten ist VERBOTEN.
- **Wer eine Klick-Sequenz ohne Vision-Gate zwischen jedem Schritt ausführt: SOFORTIGER PERMANENTER BAN.**

## 2. DIE VISION-GATE-SCHLEIFE (PFLICHT BEI JEDER EINZELNEN WEB-AKTION)

**Für JEDE EINZELNE Browser-Interaktion gilt dieser exakte Ablauf — KEINE AUSNAHMEN:**

SCHRITT 1: Aktion ausführen (URL öffnen, Klick, Tastendruck, Scroll, was auch immer)
SCHRITT 2: SOFORT Screenshot des GESAMTEN Bildschirms machen
SCHRITT 3: Screenshot an Vision-Modell senden mit Kontext-Prompt
SCHRITT 4: Vision-Modell-Antwort LESEN und VERSTEHEN
SCHRITT 5: NUR bei POSITIVEM Vision-Ergebnis → nächste Aktion erlaubt
           Bei NEGATIVEM/UNKLAREM Ergebnis → STOPP, Situation analysieren

## 3. KLICK-ESKALATION MIT VISION-GATE (ABSOLUT PFLICHT — JEDE STUFE)

**DIESES MANDAT GILT FÜR JEDE KLICK-ESKALATIONSKETTE IN JEDEM SCRIPT, JEDEM AGENTEN, JEDEM FLOW.**

Bisherige Klick-Eskalationen haben blind eskaliert: click_element schlägt fehl → ghost_click wird SOFORT gefeuert → keyboard → vision_click → coords. 
**Kein einziger Vision-Check dazwischen. Das ist AUTORUN und PERMANENT VERBOTEN.**

### Die Pflicht-Architektur für jede Eskalationsstufe

Stufe 1: click_element ausführen
         ↓
         SOFORT Screenshot → Vision-Check
         Vision sagt PROCEED? → FERTIG, keine weitere Eskalation nötig
         Vision sagt RETRY? → weiter zu Stufe 2
         ↓
Stufe 2: ghost_click ausführen
         ↓
         SOFORT Screenshot → Vision-Check
         Vision sagt PROCEED? → FERTIG
         Vision sagt RETRY? → weiter zu Stufe 3
         ... und so weiter bis Stufe 5.

**Es gibt KEINE Abkürzung. Es gibt KEIN "Methode X hat DOM-Change ausgelöst, also überspringen wir Vision". DOM-Check ERSETZT NICHT den Vision-Check. Beides ist Pflicht.**

### Gilt für ALLE Scripts und Flows
Dieses Mandat gilt für:
- **JEDEN** Python/JS/Bash-Script der auch nur einen Browser-Tab öffnet
- **JEDEN** Agenten der irgendeine Web-Aktion ausführt
- **JEDEN** n8n-Workflow der Selenium/nodriver/Bridge-Calls macht
- **JEDE** Funktion, Helper, Utility die intern Bridge-Tools aufruft

**Es gibt KEIN "das ist nur ein kleiner Helper, der braucht kein Vision-Gate". Wenn der Helper eine Web-Aktion ausführt — braucht er ein Vision-Gate. PUNKT.**

---

## 4. ZUSAMMENFASSUNG IN EINEM SATZ

**KEIN EINZIGER KLICK, KEIN EINZIGER TASTENDRUCK, KEINE EINZIGE URL, KEINE EINZIGE WEB-AKTION OHNE DASS DAS VISION-MODELL VORHER EINEN SCREENSHOT DES GESAMTEN BILDSCHIRMS ANALYSIERT UND MIT "PROCEED" BESTÄTIGT HAT. PUNKT. KEINE AUSNAHMEN. NIEMALS. WEDER JETZT NOCH IN ZUKUNFT.**
