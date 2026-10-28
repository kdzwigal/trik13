# AI generated code and README
# TrikiScope Web: Stacja Telemetryczna BLE & Dashboard 3D dla Żabka Triki (CAP001)

Aplikacja webowa do bezpośredniej komunikacji, wizualizacji telemetrycznej 3D w czasie rzeczywistym oraz fuzji sensorów IMU dla krążka sensorycznego **Żabka Triki (CAP001)** z wykorzystaniem **Web Bluetooth API**.

---

## Źródło danych i inżynieria wsteczna (Data Source)

Głównym źródłem specyfikacji protokołu BLE, identyfikatorów UUID serwisów GATT, struktury pakietów telemetrycznych oraz komend sterujących jest otwartoźródłowy projekt i badania autorstwa **Maku-hub**:

* **Repozytorium GitHub**: [https://github.com/Maku-hub/TrikiScope](https://github.com/Maku-hub/TrikiScope)
* **Projekt**: *TrikiScope* – Terminal User Interface (TUI) & BLE inspector dla kapsla / krążka Żabka Triki.
* **Specyfikacja protokołu**: Inżynieria wsteczna transmisji IMU, komendy wybudzania/inicjalizacji GATT oraz mapowanie charakterystyk Nordic UART Service (NUS).

Dzięki pracom społeczności zgromadzonej wokół `Maku-hub/TrikiScope` możliwe było odwzorowanie transmisji z krążka Triki bezpośrednio w przeglądarce bez instalacji zewnętrznych sterowników.

---

## Specyfikacja techniczna protokołu BLE (Nordic UART Service)

Krążek Żabka Triki komunikuje się za pośrednictwem profilu **Nordic UART Service (NUS)**:

| Element | UUID / Wartość | Opis |
| :--- | :--- | :--- |
| **GATT Service** | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | Główny serwis transmisyjny (NUS) |
| **RX Characteristic** | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Kanał zapisu komend (Write Without Response / With Response) |
| **TX Characteristic** | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Kanał notyfikacji strumienia IMU (~98–100 Hz) |
| **LED Characteristic** | `6e400004-b5a3-f393-e0a9-e50e24dcca9e` | Bezpośrednie sterowanie diodą LED (Bajt `0x01` = WŁ, `0x00` = WYŁ) |

### Komenda inicjalizacyjna strumienia (START)
Wysłanie poniższej sekwencji bajtów na charakterystykę NUS RX uruchamia ciągłe przesyłanie pakietów IMU:
```
HEX: 20 10 00 D0 07 68 00 03
```

### Format 14-bajtowej ramki IMU (Maku-hub format)
Każdy pakiet z charakterystyki `6E400003` zawiera:
- **Bajt 0**: Bajt synchronizacji / nagłówka (`0x22`)
- **Bajt 1**: Stan przycisku (`0x01` = wciśnięty, `0x00` = puszczony)
- **Bajty 2–7**: Akcelerometr X, Y, Z (`int16_le`)
- **Bajty 8–13**: Żyroskop X, Y, Z (`int16_le`)
- **Bajt 14** (opcjonalny): Poziom naładowania baterii w procentach (0–100%)

---

## Kalibracja sprzętowa i korekta sensorów

W toku analizy fizycznego krążka wdrożono kluczowe poprawki kalibracyjne:

1. **Poprawa skali obrotu Yaw (pełne 360°)**:
   - Domyślny przelicznik bazujący na $131.0\ \text{LSB}/(^\circ/\text{s})$ odpowiadał zakresowi $\pm 250^\circ/\text{s}$, podczas gdy krążek Triki ma przetwornik skonfigurowany na zakres **$\pm 2000^\circ/\text{s}$** ($16.384\ \text{LSB}/(^\circ/\text{s})$).
   - Skutkowało to 8-krotnym zaniżaniem prędkości kątowej (obrót o 360° dawał odczyt 44–46°).
   - Zastosowanie czułości **$16.384\ \text{LSB}/(^\circ/\text{s})$** zapewnia matematycznie poprawny, pełny obrót o 360° wokół osi pionowej Z.
2. **Kalibracja ziemskiego przyspieszenia (G-Force 1.00 g)**:
   - Przy domyślnym dzielniku $2048.0\ \text{LSB}/g$ krążek leżący płasko na biurku generował odczyt $0.89\ g$.
   - Zaktualizowano sprzętowy przelicznik akcelerometru do $1.0 / (2048.0 \times 0.89) = 1.0 / 1822.72\ \text{LSB}/g$, dzięki czemu w stanie spoczynku siła ciążenia wynosi dokładnie **$1.00\ g$** (1G static equilibrium).
3. **Mapowanie osi krążka**:
   - **Zamiana Pitch ⇄ Roll**: Aktywna na stałe na poziomie rdzenia fuzji.
   - **Zwrot osi**: Odwrócenie Pitch (`invertPitch: true`), zachowanie kierunku Roll (`invertRoll: false`), odwrócenie Yaw (`invertYaw: true`).
4. **Sterowanie diodą LED**:
   - Obsługa włączania, wyłączania oraz procedury diagnostycznej 3-krotnego mignięcia (Blink 3x) z synchronizacją wizualną na modelu 3D.

---

## Główne moduły aplikacji

* **Wizualizator 3D (Three.js)**:
  - Wieloczęściowy model krążka (obudowa, pierścień chwytny, świecący halo LED, wklęsły przycisk dotykowy, port USB-C, osie współrzędnych XYZ).
  - PBR (Physically Based Rendering) z oświetleniem studyjnym i mapą odbić `RoomEnvironment`.
  - Animacja fizycznego ugięcia przycisku w czasie rzeczywistym pod wpływem kliknięć.
* **Silnik fuzji orientacji**:
  - **Filtr komplementarny (polecany)**: Pełny zakres 360° bez blokady kardanowej (gimbal lock), wysoka responsywność.
  - **Madgwick AHRS**: Estymacja orientacji w postaci kwaternionów metodą spadku gradientowego.
* **Panel edycji filtracji (Modal)**:
  - Suwaki wagi żyroskopu Alpha, współczynnika Beta, filtru dolnoprzepustowego akcelerometru (LPF) oraz strefy martwej żyroskopu (deadband).
  - Suwaki mikro-kalibracji czułości obrotu Yaw oraz siły ciążenia G-Force.
  - Presety: Zbalansowany, Dynamiczny (gry), Laboratoryjny (wysokie wygładzenie), Madgwick AHRS.
* **Wielokanałowy oscyloskop Skia Canvas**:
  - Wykresy w czasie rzeczywistym renderowane na HTML5 Canvas z prędkością 60 FPS z bufora cyklicznego (`RingBuffer`).
* **Sztuczny horyzont lotniczy (Attitude Indicator) & G-Meter**:
  - Wskaźnik przechyłu i pochylenia wzorowany na instrumentach pokładowych awioniki.
  - Cyfrowy miernik wypadkowego przeciążenia G-Force z oznaczeniem punktu odniesienia 1.00g.
* **Style wizualne**:
  - `Clean Light`: Nowoczesny, techniczny styl ze stonowaną paletą barw.
  - `E-Ink`: Monochromatyczny tryb wysokiego kontrastu, idealny dla czytników z papierem elektronicznym lub pracy w ostrym świetle.

---

## Uruchomienie projektu lokalnie

### Wymagania
* Node.js 18+
* Przeglądarka z obsługą **Web Bluetooth API** (Google Chrome, Microsoft Edge, Opera na systemach Windows, macOS, Linux, ChromeOS lub Android).

### Instalacja i start
```bash
# Instalacja zależności
npm install

# Uruchomienie serwera deweloperskiego
npm run dev

# Kompilacja produkcyjna (TypeScript + Vite)
npm run build
```

---

## Podziękowania i referencje

Specjalne podziękowania dla twórcy repozytorium **[Maku-hub/TrikiScope](https://github.com/Maku-hub/TrikiScope)** za dokumentację techniczną krążka Żabka Triki i wkład w społeczność inżynierii wstecznej urządzeń IoT.
