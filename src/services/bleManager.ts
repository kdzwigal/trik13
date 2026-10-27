/**
 * Triki BLE Manager service for Web Bluetooth API
 * Reverse-engineered for Żabka Triki (CAP001) puck
 * Protocol: Nordic UART Service (NUS) & binary IMU stream
 * Based on Maku-hub/TrikiScope specifications
 */

import { Capacitor } from '@capacitor/core';
import { BleClient, ConnectionPriority } from '@capacitor-community/bluetooth-le';
import { RawSensorSample, BLEConnectionState, LedCommand, ButtonMode, LedControlMethod } from '../types/triki';

// Nordic UART Service UUIDs
export const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const NUS_RX_CHARACTERISTIC = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write commands to Triki
export const NUS_TX_CHARACTERISTIC = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify IMU stream from Triki
export const NUS_LED_CHARACTERISTIC = '6e400004-b5a3-f393-e0a9-e50e24dcca9e'; // Read/Write LED control

// Triki official initialization start command from TrikiScope (starts IMU streaming at ~98 Hz)
// Hex: 20 10 00 D0 07 68 00 03
export const TRIKI_START_COMMAND_BYTES = new Uint8Array([
  0x20, 0x10, 0x00, 0xd0, 0x07, 0x68, 0x00, 0x03,
]);

export type PacketCallback = (sample: RawSensorSample) => void;
export type StateCallback = (state: BLEConnectionState) => void;

interface BluetoothDeviceWithGatt extends EventTarget {
  id: string;
  name?: string;
  gatt?: {
    connected: boolean;
    connect(): Promise<BluetoothRemoteGATTServer>;
    disconnect(): void;
  };
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

interface BluetoothRemoteGATTServer {
  connected: boolean;
  getPrimaryService(service: string): Promise<BluetoothRemoteGATTService>;
  disconnect(): void;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

export class TrikiBleManager {
  private device: BluetoothDeviceWithGatt | null = null;
  private gattServer: BluetoothRemoteGATTServer | null = null;
  private txCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private rxCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private ledCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;

  // Native Capacitor BLE state (Android/iOS APK)
  private nativeDeviceId: string | null = null;
  private hasNativeRxChar: boolean = false;
  private hasNativeLedChar: boolean = false;

  private onPacketCallback: PacketCallback | null = null;
  private onStateCallback: StateCallback | null = null;

  private packetsCount: number = 0;
  private lastRateCalcTime: number = performance.now();
  private lastPacketsCount: number = 0;
  private currentRateHz: number = 0;
  private rateIntervalId: number | null = null;
  private packetSequence: number = 0;

  // Triki hardware scale factors:
  // IMU sensor configured for ±2000 dps full-scale range:
  // Sensitivity = 32768 / 2000 = 16.384 LSB / (deg/s) (131.0 / 8.0).
  private gyroScaleTriki: number = (1.0 / 16.384) * (Math.PI / 180.0); // in rad/s
  // Accel scale: Triki hardware raw 1g at rest produces ~1823 counts (1823/2048 = 0.89g).
  // Scaled by 1.0 / (2048.0 * 0.89) = 1.0 / 1822.72 so resting on desk measures exactly 1.00g.
  private accelScaleTriki: number = 1.0 / (2048.0 * 0.89); // in g

  // Button state management
  public buttonMode: ButtonMode = 'exact-01';
  public buttonPressCount: number = 0;
  private lastButtonState: boolean = false;
  private lastButtonEdgeTime: number = 0;
  private virtualButtonUntil: number = 0;

  // Packet sensor order: false (default) = Bytes [2..7] Accel, Bytes [8..13] Gyro
  // true = Bytes [2..7] Gyro, Bytes [8..13] Accel
  public swapAccelGyroBytes: boolean = false;

  // LED state management
  public ledControlMethod: LedControlMethod = 'auto';
  public isLedOn: boolean = false;
  private isBlinking: boolean = false;

  public setSwapAccelGyroBytes(swap: boolean): void {
    this.swapAccelGyroBytes = swap;
    this.addLog(
      `Kolejność sensorów w ramce 0x22: ${
        swap
          ? 'Bajty [2..7]=Żyroskop, [8..13]=Akcelerometr'
          : 'Bajty [2..7]=Akcelerometr, [8..13]=Żyroskop (Domyślne)'
      }`
    );
  }

  public getSwapAccelGyroBytes(): boolean {
    return this.swapAccelGyroBytes;
  }

  public setButtonMode(mode: ButtonMode): void {
    this.buttonMode = mode;
    this.addLog(`Zmieniono tryb przycisku na: ${mode}`);
    this.updateState({ buttonMode: mode });
  }

  public getButtonMode(): ButtonMode {
    return this.buttonMode;
  }

  public getButtonPressCount(): number {
    return this.buttonPressCount;
  }

  public resetButtonPressCount(): void {
    this.buttonPressCount = 0;
    this.updateState({ buttonPressCount: 0 });
    this.addLog('Zresetowano licznik wciśnięć przycisku do 0');
  }

  public triggerVirtualButtonPress(durationMs: number = 220): void {
    this.virtualButtonUntil = performance.now() + durationMs;
    this.buttonPressCount++;
    this.updateState({ buttonPressCount: this.buttonPressCount });
    this.addLog(`Wyzwolono wirtualne wciśnięcie przycisku (${durationMs}ms)`);

    // Give visual haptic pulse on physical Triki LED if connected
    this.toggleLed(true);
    setTimeout(() => {
      this.toggleLed(false);
    }, durationMs);
  }

  public setButtonInverted(inverted: boolean): void {
    this.setButtonMode(inverted ? 'inverted' : 'exact-01');
  }

  public setLedControlMethod(method: LedControlMethod): void {
    this.ledControlMethod = method;
    this.addLog(`Zmieniono metodę sterowania LED na: ${method}`);
    this.updateState({ ledMethod: method });
  }

  public getLedControlMethod(): LedControlMethod {
    return this.ledControlMethod;
  }

  public getIsLedOn(): boolean {
    return this.isLedOn;
  }

  private state: BLEConnectionState = {
    status: 'disconnected',
    packetsReceived: 0,
    packetRateHz: 0,
    latencyMs: 0,
    isWebBluetoothSupported:
      Capacitor.isNativePlatform() || (typeof navigator !== 'undefined' && 'bluetooth' in navigator),
    buttonMode: 'exact-01',
    buttonPressCount: 0,
    ledEnabled: false,
    ledMethod: 'auto',
    debugLogs: [],
  };

  constructor() {
    this.startRateMonitor();
  }

  public isSupported(): boolean {
    return Capacitor.isNativePlatform() || (typeof navigator !== 'undefined' && 'bluetooth' in navigator);
  }

  public getState(): BLEConnectionState {
    return { ...this.state };
  }

  public onPacket(callback: PacketCallback): void {
    this.onPacketCallback = callback;
  }

  public onStateChange(callback: StateCallback): void {
    this.onStateCallback = callback;
  }

  public addLog(message: string): void {
    const timestamp = new Date().toLocaleTimeString();
    const entry = `[${timestamp}] ${message}`;
    const newLogs = [entry, ...this.state.debugLogs].slice(0, 30);
    this.updateState({ debugLogs: newLogs });
    console.log(`[TrikiBLE] ${message}`);
  }

  private updateState(partial: Partial<BLEConnectionState>): void {
    this.state = { ...this.state, ...partial };
    if (this.onStateCallback) {
      this.onStateCallback(this.state);
    }
  }

  private startRateMonitor(): void {
    if (this.rateIntervalId !== null) return;
    this.rateIntervalId = window.setInterval(() => {
      const now = performance.now();
      const elapsedSec = (now - this.lastRateCalcTime) / 1000.0;
      if (elapsedSec > 0.5) {
        const packetsDelta = this.packetsCount - this.lastPacketsCount;
        this.currentRateHz = Math.round((packetsDelta / elapsedSec) * 10) / 10;
        this.lastPacketsCount = this.packetsCount;
        this.lastRateCalcTime = now;

        if (this.state.status === 'connected') {
          this.updateState({
            packetRateHz: this.currentRateHz,
            packetsReceived: this.packetsCount,
          });
        }
      }
    }, 500);
  }

  /**
   * Safe GATT Characteristic write helper.
   * Checks properties (write vs writeWithoutResponse) to avoid DOMException on Web Bluetooth.
   */
  private async writeCharacteristic(
    char: BluetoothRemoteGATTCharacteristic,
    buffer: BufferSource
  ): Promise<void> {
    const anyChar = char as unknown as {
      properties?: { write?: boolean; writeWithoutResponse?: boolean };
      writeValueWithResponse?: (val: BufferSource) => Promise<void>;
      writeValueWithoutResponse?: (val: BufferSource) => Promise<void>;
      writeValue?: (val: BufferSource) => Promise<void>;
    };

    const hasWriteWoResp = Boolean(anyChar.properties?.writeWithoutResponse);
    const hasWriteWithResp = Boolean(anyChar.properties?.write);

    // If characteristic ONLY supports writeWithoutResponse:
    if (hasWriteWoResp && !hasWriteWithResp && typeof anyChar.writeValueWithoutResponse === 'function') {
      try {
        await anyChar.writeValueWithoutResponse(buffer);
        return;
      } catch (err) {
        console.warn('writeValueWithoutResponse rejected, trying writeValueWithResponse:', err);
      }
    }

    // Try standard writeValueWithResponse (Required for Triki 0x6E400004 LED)
    if (typeof anyChar.writeValueWithResponse === 'function') {
      try {
        await anyChar.writeValueWithResponse(buffer);
        return;
      } catch (err) {
        console.warn('writeValueWithResponse rejected, fallback to writeValue:', err);
      }
    }

    // Standard Web Bluetooth writeValue
    if (typeof anyChar.writeValue === 'function') {
      try {
        await anyChar.writeValue(buffer);
        return;
      } catch (err) {
        console.warn('writeValue rejected, trying writeValueWithoutResponse:', err);
      }
    }

    // Fallback
    if (typeof anyChar.writeValueWithoutResponse === 'function') {
      await anyChar.writeValueWithoutResponse(buffer);
    }
  }

  /**
   * Native Capacitor BLE write helper (Android/iOS)
   */
  private async writeNativeCharacteristic(charUuid: string, bytes: Uint8Array): Promise<void> {
    if (!this.nativeDeviceId) {
      throw new Error('Brak połączonego urządzenia natywnego BLE.');
    }
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    try {
      await BleClient.write(this.nativeDeviceId, NUS_SERVICE_UUID, charUuid, dv);
    } catch {
      await BleClient.writeWithoutResponse(this.nativeDeviceId, NUS_SERVICE_UUID, charUuid, dv);
    }
  }

  /**
   * Send the official Triki start command (20 10 00 D0 07 68 00 03) to NUS RX
   */
  public async sendStartCommand(): Promise<boolean> {
    if (Capacitor.isNativePlatform()) {
      if (!this.nativeDeviceId || !this.hasNativeRxChar) {
        this.addLog('Błąd: Charakterystyka NUS RX (0x6E400002) nie jest dostępna');
        return false;
      }
      try {
        this.addLog('Wysyłanie komendy startowej (Natywne BLE): 20 10 00 D0 07 68 00 03...');
        await this.writeNativeCharacteristic(NUS_RX_CHARACTERISTIC, TRIKI_START_COMMAND_BYTES);
        this.addLog('Komenda startowa wysłana pomyślnie. Triki powinien rozpocząć nadawanie IMU.');
        this.updateState({ lastCommandStatus: 'Wysłano komendę START (201000D007680003)' });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.addLog(`Błąd zapisu do NUS RX: ${msg}`);
        this.updateState({ lastCommandStatus: `Błąd zapisu START: ${msg}` });
        return false;
      }
    }

    if (!this.rxCharacteristic) {
      this.addLog('Błąd: Charakterystyka NUS RX (0x6E400002) nie jest dostępna');
      return false;
    }

    try {
      this.addLog('Wysyłanie komendy startowej: 20 10 00 D0 07 68 00 03...');
      await this.writeCharacteristic(this.rxCharacteristic, TRIKI_START_COMMAND_BYTES);
      this.addLog('Komenda startowa wysłana pomyślnie. Triki powinien rozpocząć nadawanie IMU.');
      this.updateState({ lastCommandStatus: 'Wysłano komendę START (201000D007680003)' });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.addLog(`Błąd zapisu do NUS RX: ${msg}`);
      this.updateState({ lastCommandStatus: `Błąd zapisu START: ${msg}` });
      return false;
    }
  }

  /**
   * Native Android / iOS BLE connection via @capacitor-community/bluetooth-le
   */
  private async connectNative(): Promise<void> {
    try {
      this.updateState({ status: 'searching', errorMessage: undefined });
      this.addLog('[Android BLE] Inicjalizacja natywnego stosu Bluetooth LE...');

      await BleClient.initialize({ androidNeverForLocation: true });

      const enabled = await BleClient.isEnabled();
      if (!enabled) {
        this.addLog('[Android BLE] Bluetooth wyłączony — prośba o włączenie...');
        try {
          await BleClient.requestEnable();
        } catch {
          // User may enable manually or on older SDK
        }
      }

      await BleClient.setDisplayStrings({
        scanning: 'Skanowanie urządzeń BLE (Triki CAP001)...',
        cancel: 'Anuluj',
        availableDevices: 'Wybierz krążek Triki (CAP001)',
        noDeviceFound: 'Nie wykryto urządzenia BLE w pobliżu',
      });

      this.addLog('[Android BLE] Otwieranie skanera urządzeń BLE...');
      const device = await BleClient.requestDevice({
        optionalServices: [
          NUS_SERVICE_UUID,
          '0000180f-0000-1000-8000-00805f9b34fb',
          '0000180a-0000-1000-8000-00805f9b34fb',
        ],
      });

      const deviceName = device.name || 'Triki Puck (CAP001)';
      this.nativeDeviceId = device.deviceId;
      this.addLog(`[Android BLE] Wybrano: ${deviceName} (${device.deviceId})`);

      this.updateState({
        status: 'connecting',
        deviceName,
        deviceId: device.deviceId,
      });

      await BleClient.connect(device.deviceId, () => {
        this.handleDisconnect();
      });
      this.addLog('[Android BLE] Połączono z serwerem GATT.');

      // Request high priority low-latency connection for ~98Hz IMU stream
      try {
        await BleClient.requestConnectionPriority(
          device.deviceId,
          ConnectionPriority.CONNECTION_PRIORITY_HIGH
        );
        this.addLog('[Android BLE] Ustawiono priorytet połączenia: HIGH (niskie opóźnienie IMU).');
      } catch {
        // Ignore if not supported
      }

      this.hasNativeRxChar = true;
      this.hasNativeLedChar = false;

      try {
        const services = await BleClient.getServices(device.deviceId);
        const nus = services.find((s) => s.uuid.toLowerCase() === NUS_SERVICE_UUID.toLowerCase());
        if (!nus) {
          throw new Error('Nie znaleziono serwisu Nordic UART (NUS 0x6E400001) w wybranym urządzeniu.');
        }
        this.addLog(`Wykryto ${nus.characteristics.length} charakterystyk GATT w serwisie NUS:`);
        for (const c of nus.characteristics) {
          const uuidLower = c.uuid.toLowerCase();
          this.addLog(` • ${uuidLower}`);
          if (uuidLower.includes('6e400002')) {
            this.hasNativeRxChar = true;
          } else if (uuidLower.includes('6e400004')) {
            this.hasNativeLedChar = true;
            this.addLog('   -> Zmapowano dedykowaną charakterystykę LED (0x6E400004)!');
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Nie znaleziono serwisu Nordic UART')) {
          throw e;
        }
        this.addLog(`Uwaga podczas skanowania charakterystyk: ${msg}`);
      }

      this.addLog('Włączanie powiadomień TX (startNotifications)...');
      await BleClient.startNotifications(
        device.deviceId,
        NUS_SERVICE_UUID,
        NUS_TX_CHARACTERISTIC,
        (dataView: DataView) => {
          const now = performance.now();
          this.packetsCount++;
          const sample = this.parsePacket(dataView, now);
          if (sample && this.onPacketCallback) {
            this.onPacketCallback(sample);
          }
        }
      );
      this.addLog('Powiadomienia TX włączone pomyślnie!');

      this.packetsCount = 0;
      this.lastPacketsCount = 0;
      this.lastRateCalcTime = performance.now();

      this.updateState({
        status: 'connected',
        serviceUuid: NUS_SERVICE_UUID,
        errorMessage: undefined,
      });

      this.addLog('Wysyłanie inicjalizacyjnej komendy START do Triki...');
      await this.sendStartCommand();

      setTimeout(async () => {
        if (this.nativeDeviceId && this.packetsCount === 0) {
          this.addLog('Ponawianie komendy START po 300ms...');
          await this.sendStartCommand();
        }
      }, 300);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.addLog(`Błąd połączenia BLE: ${message}`);
      this.updateState({
        status: 'error',
        errorMessage:
          message.includes('cancelled') || message.includes('canceled')
            ? 'Anulowano wybór urządzenia BLE.'
            : message,
      });
      throw err;
    }
  }

  /**
   * Request Bluetooth device and establish connection
   */
  public async connect(): Promise<void> {
    if (Capacitor.isNativePlatform()) {
      return this.connectNative();
    }

    if (!this.isSupported()) {
      const err = 'Web Bluetooth API nie jest obsługiwane w tej przeglądarce. Użyj Chrome, Edge lub aplikacji Android APK.';
      this.updateState({ status: 'error', errorMessage: err });
      throw new Error(err);
    }

    try {
      this.updateState({ status: 'searching', errorMessage: undefined });
      this.addLog('Rozpoczęto skanowanie urządzeń BLE (NUS Service 0x6E400001)...');

      const nav = navigator as unknown as {
        bluetooth: {
          requestDevice(options: unknown): Promise<BluetoothDeviceWithGatt>;
        };
      };

      const device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          NUS_SERVICE_UUID,
          '0000180f-0000-1000-8000-00805f9b34fb', // Battery Service
          '0000180a-0000-1000-8000-00805f9b34fb', // Device Info
        ],
      });

      this.device = device;
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);

      const deviceName = device.name || 'Triki Puck (CAP001)';
      this.addLog(`Wybrano urządzenie: ${deviceName} (ID: ${device.id})`);

      this.updateState({
        status: 'connecting',
        deviceName,
        deviceId: device.id,
      });

      if (!device.gatt) {
        throw new Error('GATT server niedostępny na urządzeniu');
      }

      this.addLog('Łączenie z serwerem GATT...');
      const gattServer = await device.gatt.connect();
      this.gattServer = gattServer;
      this.addLog('Serwer GATT połączony.');

      // Discover NUS service
      this.addLog(`Wyszukiwanie serwisu Nordic UART: ${NUS_SERVICE_UUID}...`);
      let nusService: BluetoothRemoteGATTService | null = null;
      try {
        nusService = await gattServer.getPrimaryService(NUS_SERVICE_UUID);
        this.addLog('Znaleziono serwis Nordic UART (NUS).');
      } catch {
        throw new Error('Nie znaleziono serwisu Nordic UART (NUS 0x6E400001) w wybranym urządzeniu.');
      }

      // Discover Characteristics in NUS service
      this.addLog('Skanowanie charakterystyk serwisu NUS (0x6E400001)...');
      try {
        const anyService = nusService as unknown as {
          getCharacteristics?: () => Promise<BluetoothRemoteGATTCharacteristic[]>;
        };
        if (typeof anyService.getCharacteristics === 'function') {
          const chars = await anyService.getCharacteristics();
          this.addLog(`Wykryto ${chars.length} charakterystyk GATT w serwisie NUS:`);
          for (const c of chars) {
            const uuidLower = (c as unknown as { uuid: string }).uuid.toLowerCase();
            const props = (c as unknown as { properties?: Record<string, boolean> }).properties || {};
            const propList = Object.keys(props).filter((k) => props[k]).join(', ');
            this.addLog(` • ${uuidLower} [${propList}]`);
            if (uuidLower.includes('6e400003')) {
              this.txCharacteristic = c;
            } else if (uuidLower.includes('6e400002')) {
              this.rxCharacteristic = c;
            } else if (uuidLower.includes('6e400004')) {
              this.ledCharacteristic = c;
              this.addLog('   -> Zmapowano dedykowaną charakterystykę LED (0x6E400004)!');
            }
          }
        }
      } catch (err) {
        console.warn('getCharacteristics enumeration failed, using fallback:', err);
      }

      // Discover TX Characteristic if not yet assigned
      if (!this.txCharacteristic) {
        this.addLog(`Wyszukiwanie TX Characteristic (Notify): ${NUS_TX_CHARACTERISTIC}...`);
        this.txCharacteristic = await nusService.getCharacteristic(NUS_TX_CHARACTERISTIC);
      }
      this.txCharacteristic.addEventListener(
        'characteristicvaluechanged',
        this.handleCharacteristicValueChanged
      );

      this.addLog('Włączanie powiadomień TX (startNotifications)...');
      await this.txCharacteristic.startNotifications();
      this.addLog('Powiadomienia TX włączone pomyślnie!');

      // Discover RX Characteristic if not yet assigned
      if (!this.rxCharacteristic) {
        try {
          this.addLog(`Wyszukiwanie RX Characteristic (Write): ${NUS_RX_CHARACTERISTIC}...`);
          this.rxCharacteristic = await nusService.getCharacteristic(NUS_RX_CHARACTERISTIC);
          this.addLog('Znaleziono RX Characteristic.');
        } catch (e) {
          console.warn('Triki RX characteristic niedostępna:', e);
          this.addLog('Ostrzeżenie: RX characteristic niedostępna');
        }
      }

      // Discover LED Characteristic 6e400004 if not yet assigned
      if (!this.ledCharacteristic) {
        try {
          this.ledCharacteristic = await nusService.getCharacteristic(NUS_LED_CHARACTERISTIC);
          this.addLog('Znaleziono dedykowaną LED Characteristic (0x6E400004).');
        } catch {
          this.addLog('Charakterystyka 0x6E400004 nie odpowiada bezpośrednio (będzie używany kanał RX).');
        }
      }

      this.packetsCount = 0;
      this.lastPacketsCount = 0;
      this.lastRateCalcTime = performance.now();

      this.updateState({
        status: 'connected',
        serviceUuid: NUS_SERVICE_UUID,
        errorMessage: undefined,
      });

      // Send the Triki start command immediately
      this.addLog('Wysyłanie inicjalizacyjnej komendy START do Triki...');
      await this.sendStartCommand();

      // Send once again after 300ms to guarantee puck awakens
      setTimeout(async () => {
        if (this.gattServer?.connected && this.rxCharacteristic && this.packetsCount === 0) {
          this.addLog('Ponawianie komendy START po 300ms...');
          await this.sendStartCommand();
        }
      }, 300);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.addLog(`Błąd połączenia: ${message}`);
      this.updateState({
        status: 'error',
        errorMessage: message.includes('User cancelled')
          ? 'Anulowano wybór urządzenia BLE w oknie przeglądarki.'
          : message,
      });
      throw err;
    }
  }

  /**
   * Disconnect current device
   */
  public disconnect(): void {
    if (Capacitor.isNativePlatform() && this.nativeDeviceId) {
      const devId = this.nativeDeviceId;
      this.nativeDeviceId = null;
      BleClient.stopNotifications(devId, NUS_SERVICE_UUID, NUS_TX_CHARACTERISTIC).catch(() => {});
      BleClient.disconnect(devId).catch(() => {});
      this.addLog('Rozłączono natywne urządzenie BLE.');
      this.updateState({
        status: 'disconnected',
        packetRateHz: 0,
      });
      return;
    }

    if (this.txCharacteristic) {
      try {
        this.txCharacteristic.removeEventListener(
          'characteristicvaluechanged',
          this.handleCharacteristicValueChanged
        );
        this.txCharacteristic.stopNotifications().catch(() => {});
      } catch (e) {
        console.warn('Error stopping notifications:', e);
      }
      this.txCharacteristic = null;
    }

    if (this.gattServer && this.gattServer.connected) {
      this.gattServer.disconnect();
    }
    this.gattServer = null;

    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnect);
      this.device = null;
    }

    this.addLog('Rozłączono urządzenie BLE.');
    this.updateState({
      status: 'disconnected',
      packetRateHz: 0,
    });
  }

  private handleDisconnect = (): void => {
    this.nativeDeviceId = null;
    this.addLog('Urządzenie Triki rozłączyło się.');
    this.updateState({
      status: 'disconnected',
      packetRateHz: 0,
      errorMessage: 'Urządzenie Triki zostało odłączone.',
    });
  };

  /**
   * Handle incoming BLE characteristic data notification
   */
  private handleCharacteristicValueChanged = (event: Event): void => {
    const target = event.target as unknown as { value?: DataView };
    if (!target || !target.value) return;

    const dataView = target.value;
    const now = performance.now();
    this.packetsCount++;

    const sample = this.parsePacket(dataView, now);
    if (sample && this.onPacketCallback) {
      this.onPacketCallback(sample);
    }
  };

  /**
   * Parse binary byte packet received from Triki puck
   *
   * Official Triki / TrikiScope 14-byte format:
   * Header: [0x22, btn_byte]
   * Gyroscope: gx (int16_le), gy (int16_le), gz (int16_le) [bytes 2..7] (131.0 LSB/deg/s)
   * Accelerometer: ax (int16_le), ay (int16_le), az (int16_le) [bytes 8..13] (2048.0 LSB/g)
   */
  public parsePacket(dataView: DataView, timestamp: number): RawSensorSample | null {
    const len = dataView.byteLength;
    if (len < 6) return null;

    const rawBytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);

    // Format hex string for debug
    const hex = Array.from(rawBytes)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');

    if (this.packetsCount === 1 || this.packetsCount % 50 === 0) {
      this.updateState({ rawBytesHex: hex });
    }

    let ax = 0;
    let ay = 0;
    let az = 0;
    let gx = 0;
    let gy = 0;
    let gz = 0;
    let button = false;
    let buttonRawByte: number = 0;
    let batteryLevel: number | undefined = undefined;

    // Scan for Triki magic header 0x22 anywhere in the frame (handles any transport offset)
    let headerOffset = -1;
    for (let i = 0; i <= len - 8; i++) {
      if (dataView.getUint8(i) === 0x22) {
        headerOffset = i;
        break;
      }
    }

    if (headerOffset >= 0) {
      // Byte [headerOffset + 1]: Button state byte
      const btnByte = dataView.getUint8(headerOffset + 1);
      buttonRawByte = btnByte;

      // Decode button state based on configured ButtonMode
      switch (this.buttonMode) {
        case 'exact-01':
          button = btnByte === 0x01;
          break;
        case 'inverted':
          button = btnByte === 0x00;
          break;
        case 'bit0':
          button = (btnByte & 0x01) === 0x01;
          break;
        case 'nonzero':
          button = btnByte > 0;
          break;
        case 'manual':
          // Driven exclusively by UI or click
          button = false;
          break;
        case 'tap':
          button = false;
          break;
        default:
          button = btnByte === 0x01;
          break;
      }

      if (!this.swapAccelGyroBytes) {
        // Default hardware order:
        // Bytes [headerOffset + 2..7]: Accelerometer X, Y, Z (int16_le)
        if (len >= headerOffset + 8) {
          const rawAx = dataView.getInt16(headerOffset + 2, true);
          const rawAy = dataView.getInt16(headerOffset + 4, true);
          const rawAz = dataView.getInt16(headerOffset + 6, true);
          ax = rawAx * this.accelScaleTriki;
          ay = rawAy * this.accelScaleTriki;
          az = rawAz * this.accelScaleTriki;
        }

        // Bytes [headerOffset + 8..13]: Gyroscope X, Y, Z (int16_le)
        if (len >= headerOffset + 14) {
          const rawGx = dataView.getInt16(headerOffset + 8, true);
          const rawGy = dataView.getInt16(headerOffset + 10, true);
          const rawGz = dataView.getInt16(headerOffset + 12, true);
          gx = rawGx * this.gyroScaleTriki;
          gy = rawGy * this.gyroScaleTriki;
          gz = rawGz * this.gyroScaleTriki;
        }
      } else {
        // Alternative swapped order:
        // Bytes [headerOffset + 2..7]: Gyroscope X, Y, Z (int16_le)
        if (len >= headerOffset + 8) {
          const rawGx = dataView.getInt16(headerOffset + 2, true);
          const rawGy = dataView.getInt16(headerOffset + 4, true);
          const rawGz = dataView.getInt16(headerOffset + 6, true);
          gx = rawGx * this.gyroScaleTriki;
          gy = rawGy * this.gyroScaleTriki;
          gz = rawGz * this.gyroScaleTriki;
        }

        // Bytes [headerOffset + 8..13]: Accelerometer X, Y, Z (int16_le)
        if (len >= headerOffset + 14) {
          const rawAx = dataView.getInt16(headerOffset + 8, true);
          const rawAy = dataView.getInt16(headerOffset + 10, true);
          const rawAz = dataView.getInt16(headerOffset + 12, true);
          ax = rawAx * this.accelScaleTriki;
          ay = rawAy * this.accelScaleTriki;
          az = rawAz * this.accelScaleTriki;
        }
      }

      // Check for battery byte at offset + 14 if frame length allows
      if (len > headerOffset + 14) {
        const bat = dataView.getUint8(headerOffset + 14);
        if (bat <= 100) batteryLevel = bat;
      }
    } else {
      // Fallback only if no 0x22 header exists (e.g. raw 12-byte gyro/accel emulator)
      if (len >= 6) {
        const rawAx = dataView.getInt16(0, true);
        const rawAy = dataView.getInt16(2, true);
        const rawAz = dataView.getInt16(4, true);
        ax = rawAx / (2048.0 * 0.89);
        ay = rawAy / (2048.0 * 0.89);
        az = rawAz / (2048.0 * 0.89);
      }
      if (len >= 12) {
        const rawGx = dataView.getInt16(6, true);
        const rawGy = dataView.getInt16(8, true);
        const rawGz = dataView.getInt16(10, true);
        gx = (rawGx / 16.384) * (Math.PI / 180.0);
        gy = (rawGy / 16.384) * (Math.PI / 180.0);
        gz = (rawGz / 16.384) * (Math.PI / 180.0);
      }
      // CRITICAL: NEVER read byte 12 (Accelerometer Z noise) as button!
      button = false;
      buttonRawByte = 0x00;
    }

    // Apply active virtual click override (from 3D viewer click or UI button)
    if (this.virtualButtonUntil > timestamp) {
      button = true;
    }

    // Debounce & click event rising edge detection (60ms hysteresis)
    if (button && !this.lastButtonState) {
      if (timestamp - this.lastButtonEdgeTime > 60) {
        this.buttonPressCount++;
        this.lastButtonEdgeTime = timestamp;
        this.updateState({
          buttonPressCount: this.buttonPressCount,
          lastButtonRawByte: buttonRawByte,
        });
      }
    }
    this.lastButtonState = button;

    this.packetSequence++;

    return {
      timestamp,
      packetIndex: this.packetSequence,
      accel: { x: ax, y: ay, z: az },
      gyro: { x: gx, y: gy, z: gz },
      button,
      buttonRawByte,
      batteryLevel,
      rawBytes,
    };
  }

  /**
   * Toggle LED on puck.
   * Supports:
   * - Characteristic 0x6E400004 (TrikiScope official reverse-engineered LED control)
   * - Fallback to NUS RX (0x6E400002) with single byte 0x01/0x00 or vendor payload
   */
  public async toggleLed(enable: boolean, explicitMethod?: LedControlMethod): Promise<boolean> {
    const method = explicitMethod || this.ledControlMethod;
    const byteVal = new Uint8Array([enable ? 0x01 : 0x00]);
    let success = false;
    let targetsUsed: string[] = [];

    if (Capacitor.isNativePlatform()) {
      if ((method === 'char-6e400004' || method === 'auto' || method === 'both') && this.nativeDeviceId && this.hasNativeLedChar) {
        try {
          await this.writeNativeCharacteristic(NUS_LED_CHARACTERISTIC, byteVal);
          targetsUsed.push('char 0x6E400004 (Native)');
          success = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog(`Błąd zapisu do 0x6E400004: ${msg}`);
        }
      }

      if ((method === 'nus-rx-01' || method === 'both' || (method === 'auto' && !success)) && this.nativeDeviceId && this.hasNativeRxChar) {
        try {
          await this.writeNativeCharacteristic(NUS_RX_CHARACTERISTIC, byteVal);
          targetsUsed.push('NUS RX (0x01/0x00 Native)');
          success = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog(`Błąd zapisu byte do RX: ${msg}`);
        }
      }

      if (method === 'nus-rx-vendor' && this.nativeDeviceId && this.hasNativeRxChar) {
        try {
          const vendorPayload = new Uint8Array([0x20, 0x02, enable ? 0x01 : 0x00]);
          await this.writeNativeCharacteristic(NUS_RX_CHARACTERISTIC, vendorPayload);
          targetsUsed.push('NUS RX (Vendor 0x2002 Native)');
          success = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog(`Błąd zapisu vendor payload do RX: ${msg}`);
        }
      }
    } else {
      // Method 1: Dedicated characteristic 6e400004
      if ((method === 'char-6e400004' || method === 'auto' || method === 'both') && this.ledCharacteristic) {
        try {
          await this.writeCharacteristic(this.ledCharacteristic, byteVal);
          targetsUsed.push('char 0x6E400004');
          success = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog(`Błąd zapisu do 0x6E400004: ${msg}`);
        }
      }

      // Method 2: NUS RX single byte 0x01 / 0x00
      if ((method === 'nus-rx-01' || method === 'both' || (method === 'auto' && !success)) && this.rxCharacteristic) {
        try {
          await this.writeCharacteristic(this.rxCharacteristic, byteVal);
          targetsUsed.push('NUS RX (0x01/0x00)');
          success = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog(`Błąd zapisu byte do RX: ${msg}`);
        }
      }

      // Method 3: NUS RX vendor packet [0x20, 0x02, state]
      if (method === 'nus-rx-vendor' && this.rxCharacteristic) {
        try {
          const vendorPayload = new Uint8Array([0x20, 0x02, enable ? 0x01 : 0x00]);
          await this.writeCharacteristic(this.rxCharacteristic, vendorPayload);
          targetsUsed.push('NUS RX (Vendor 0x2002)');
          success = true;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.addLog(`Błąd zapisu vendor payload do RX: ${msg}`);
        }
      }
    }

    if (success) {
      this.isLedOn = enable;
      const targetStr = targetsUsed.join(' + ');
      this.addLog(`Dioda LED: ${enable ? 'WŁĄCZONA (0x01)' : 'WYŁĄCZONA (0x00)'} [${targetStr}]`);
      this.updateState({
        ledEnabled: enable,
        lastCommandStatus: `Dioda LED ${enable ? 'WŁ' : 'WYŁ'} (${targetStr})`,
      });
      return true;
    } else {
      this.addLog(`Nie udało się zmienić stanu LED (${method}) - brak połączonej charakterystyki.`);
      this.updateState({
        lastCommandStatus: `Błąd zapisu LED (${method})`,
      });
      return false;
    }
  }

  /**
   * Diagnostic test: Blinks physical LED 3 times to immediately verify hardware reaction
   */
  public async testBlink(times: number = 3): Promise<void> {
    if (this.isBlinking) return;
    this.isBlinking = true;
    this.addLog(`[LED Test] Rozpoczęcie sekwencji migania LED (${times} powtórzeń)...`);

    try {
      for (let i = 0; i < times; i++) {
        await this.toggleLed(true);
        await new Promise((r) => setTimeout(r, 220));
        await this.toggleLed(false);
        await new Promise((r) => setTimeout(r, 220));
      }
      this.addLog('[LED Test] Sekwencja testowa zakończona.');
    } catch (err) {
      this.addLog(`[LED Test] Błąd w trakcie migania: ${err}`);
    } finally {
      this.isBlinking = false;
    }
  }

  /**
   * Send RGB LED command to Triki puck
   */
  public async sendLedCommand(cmd: LedCommand): Promise<void> {
    const isBright = cmd.brightness > 30 && (cmd.r > 30 || cmd.g > 30 || cmd.b > 30);
    // 1. Toggle physical LED on puck
    await this.toggleLed(isBright);

    // 2. Also try writing 5-byte RGB buffer to RX if supported by firmware
    const buffer = new Uint8Array([0x02, cmd.r, cmd.g, cmd.b, cmd.brightness]);
    if (Capacitor.isNativePlatform() && this.nativeDeviceId && this.hasNativeRxChar) {
      try {
        await this.writeNativeCharacteristic(NUS_RX_CHARACTERISTIC, buffer);
      } catch {
        // Optional
      }
    } else if (this.rxCharacteristic) {
      try {
        await this.writeCharacteristic(this.rxCharacteristic, buffer);
      } catch {
        // Optional
      }
    }
  }
}

// Global singleton instance
export const trikiBle = new TrikiBleManager();
