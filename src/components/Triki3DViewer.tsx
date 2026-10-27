/**
 * 3D Interactive Viewer for Żabka Triki (CAP001) puck
 * Built with Three.js according to skill directives:
 * - Multi-part procedural model (puck hull, grip ring, LED halo, concave button, USB-C port, coordinate axes)
 * - Studio PBR lighting & RoomEnvironment reflection
 * - Mathematically correct full 360-degree range of motion mapping (Pitch, Roll, Yaw)
 * - High-precision tactile button press tracking and inversion settings
 */

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CalibratedSample, ThemeMode, LedCommand, FusionFilterMode, ButtonMode, LedControlMethod } from '../types/triki';
import { trikiBle } from '../services/bleManager';
import { sensorPipeline } from '../services/sensorPipeline';
import { RotateCcw, Eye, Sparkles, Layers, MousePointerClick, RefreshCw, Sliders, Lightbulb } from 'lucide-react';

interface Triki3DViewerProps {
  latestSample: CalibratedSample | null;
  theme: ThemeMode;
  onResetOrientation: () => void;
  filterMode?: FusionFilterMode;
  onFilterModeChange?: (mode: FusionFilterMode) => void;
  onOpenFilterSettings?: () => void;
}

export const Triki3DViewer: React.FC<Triki3DViewerProps> = ({
  latestSample,
  theme,
  onResetOrientation,
  filterMode = 'complementary',
  onFilterModeChange,
  onOpenFilterSettings,
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sampleRef = useRef<CalibratedSample | null>(latestSample);
  sampleRef.current = latestSample;

  const [showAxes, setShowAxes] = useState(true);
  const [explodedView, setExplodedView] = useState(0);
  const [dockExpanded, setDockExpanded] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 768;
    }
    return false;
  });
  const [activeLedColor, setActiveLedColor] = useState('#00e5ff');
  const activeLedColorRef = useRef(activeLedColor);
  activeLedColorRef.current = activeLedColor;

  // LED and filtering state
  const [isLedOn, setIsLedOn] = useState<boolean>(trikiBle.getIsLedOn());
  const [ledMethod, setLedMethod] = useState<LedControlMethod>(trikiBle.getLedControlMethod());
  const [swapPitchRoll, setSwapPitchRoll] = useState<boolean>(sensorPipeline.getSwapPitchRoll());

  // Axis and button inversion states (Pitch & Yaw inverted: "anuluj odwrocenie roll, owroc pitch")
  const [invertPitch, setInvertPitch] = useState(true);
  const [invertRoll, setInvertRoll] = useState(false);
  const [invertYaw, setInvertYaw] = useState(true);
  const [buttonMode, setButtonMode] = useState<ButtonMode>(trikiBle.getButtonMode());
  const [currentFilter, setCurrentFilter] = useState<FusionFilterMode>(filterMode);

  // Internal references to update in render loop without React re-renders
  const sceneElementsRef = useRef<{
    puckGroup: THREE.Group;
    buttonMesh: THREE.Mesh;
    ledRingMesh: THREE.Mesh;
    axesHelper: THREE.AxesHelper;
    buttonTopY: number;
    parts: {
      hull: THREE.Mesh;
      grip: THREE.Mesh;
      button: THREE.Mesh;
      ledRing: THREE.Mesh;
      bottomBase: THREE.Mesh;
    };
  } | null>(null);

  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    // Detect software GL
    const isSoftwareGl = (() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    })();

    // 1. Scene & Camera
    const scene = new THREE.Scene();
    const isEink = themeRef.current === 'eink';
    scene.background = new THREE.Color(isEink ? 0xf5f5f0 : 0xf8fafc);
    scene.fog = new THREE.Fog(isEink ? 0xf5f5f0 : 0xf8fafc, 6, 18);

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 450;
    const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 50);
    camera.position.set(0, 3.2, 5.0);
    camera.lookAt(0, 0, 0);

    // 2. Renderer
    const renderer = new THREE.WebGLRenderer({
      antialias: !isSoftwareGl,
      powerPreference: 'high-performance',
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    container.appendChild(renderer.domElement);

    // 3. Environment Map (PMREMGenerator RoomEnvironment)
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    pmremGenerator.dispose();

    // 4. Lighting Rig
    const ambientLight = new THREE.HemisphereLight(0xffffff, 0xcfd8dc, 0.9);
    scene.add(ambientLight);

    const dirKeyLight = new THREE.DirectionalLight(0xffffff, 1.8);
    dirKeyLight.position.set(4, 8, 4);
    dirKeyLight.castShadow = !isSoftwareGl;
    if (dirKeyLight.shadow) {
      dirKeyLight.shadow.mapSize.width = 1024;
      dirKeyLight.shadow.mapSize.height = 1024;
      dirKeyLight.shadow.camera.near = 0.5;
      dirKeyLight.shadow.camera.far = 20;
      dirKeyLight.shadow.camera.left = -3;
      dirKeyLight.shadow.camera.right = 3;
      dirKeyLight.shadow.camera.top = 3;
      dirKeyLight.shadow.camera.bottom = -3;
      dirKeyLight.shadow.bias = -0.0005;
      dirKeyLight.shadow.normalBias = 0.02;
    }
    scene.add(dirKeyLight);

    const rimLight = new THREE.DirectionalLight(0x0284c7, 0.6);
    rimLight.position.set(-4, 3, -4);
    scene.add(rimLight);

    // 5. Studio Shadow Grounding Floor
    const floorGeo = new THREE.PlaneGeometry(30, 30);
    const floorMat = new THREE.ShadowMaterial({ opacity: 0.18 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Circular contact shadow decal
    const shadowCanvas = document.createElement('canvas');
    shadowCanvas.width = 128;
    shadowCanvas.height = 128;
    const sCtx = shadowCanvas.getContext('2d');
    if (sCtx) {
      const grad = sCtx.createRadialGradient(64, 64, 10, 64, 64, 60);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
      grad.addColorStop(0.5, 'rgba(0, 0, 0, 0.2)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      sCtx.fillStyle = grad;
      sCtx.fillRect(0, 0, 128, 128);
    }
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    const contactShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 3.2),
      new THREE.MeshBasicMaterial({
        map: shadowTexture,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      })
    );
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.position.y = -1.19;
    scene.add(contactShadow);

    // 6. Triki Puck Procedural Model (THREE.Group)
    const puckGroup = new THREE.Group();
    scene.add(puckGroup);

    // Material definitions based on theme (E-Ink uses crisp light paper tones with subtle contour contrast)
    const hullMat = new THREE.MeshStandardMaterial({
      color: isEink ? 0xf5f5f2 : 0x1e293b,
      metalness: isEink ? 0.05 : 0.2,
      roughness: isEink ? 0.6 : 0.35,
    });

    const gripMat = new THREE.MeshStandardMaterial({
      color: isEink ? 0xd8d8d4 : 0x0f172a,
      metalness: 0.05,
      roughness: 0.85,
    });

    const buttonMat = new THREE.MeshStandardMaterial({
      color: isEink ? 0xe6e6e0 : 0x334155,
      metalness: isEink ? 0.1 : 0.4,
      roughness: 0.4,
    });

    const ledMat = new THREE.MeshStandardMaterial({
      color: isEink ? 0xcccccc : 0x00e5ff,
      emissive: isEink ? 0x222222 : 0x00e5ff,
      emissiveIntensity: isEink ? 0.15 : 1.4,
      roughness: 0.1,
      metalness: 0.1,
    });

    const baseMat = new THREE.MeshStandardMaterial({
      color: isEink ? 0xdeded8 : 0x0f172a,
      roughness: 0.7,
      metalness: 0.1,
    });

    // Part 1: Main Puck Body
    const hullGeo = new THREE.CylinderGeometry(1.25, 1.25, 0.45, 64);
    const hullMesh = new THREE.Mesh(hullGeo, hullMat);
    hullMesh.castShadow = true;
    hullMesh.receiveShadow = true;
    puckGroup.add(hullMesh);

    // Part 2: Textured Grip Ring
    const gripGeo = new THREE.CylinderGeometry(1.28, 1.28, 0.26, 64);
    const gripMesh = new THREE.Mesh(gripGeo, gripMat);
    gripMesh.castShadow = true;
    gripMesh.position.y = 0.02;
    puckGroup.add(gripMesh);

    // Part 3: Anti-slip Bottom Base
    const baseGeo = new THREE.CylinderGeometry(1.18, 1.2, 0.08, 64);
    const bottomBase = new THREE.Mesh(baseGeo, baseMat);
    bottomBase.position.y = -0.24;
    puckGroup.add(bottomBase);

    // Part 4: RGB LED Halo Ring
    const ledGeo = new THREE.TorusGeometry(0.82, 0.045, 16, 64);
    const ledRingMesh = new THREE.Mesh(ledGeo, ledMat);
    ledRingMesh.rotation.x = Math.PI / 2;
    ledRingMesh.position.y = 0.23;
    puckGroup.add(ledRingMesh);

    // Part 5: Concave Center Tactile Button (Resting at y=0.22)
    const buttonGeo = new THREE.CylinderGeometry(0.72, 0.72, 0.12, 48);
    const buttonMesh = new THREE.Mesh(buttonGeo, buttonMat);
    buttonMesh.position.y = 0.22;
    buttonMesh.castShadow = true;
    puckGroup.add(buttonMesh);

    // Coordinate Axes Helper
    const axesHelper = new THREE.AxesHelper(1.8);
    axesHelper.position.y = 0.05;
    puckGroup.add(axesHelper);

    // Store references
    sceneElementsRef.current = {
      puckGroup,
      buttonMesh,
      ledRingMesh,
      axesHelper,
      buttonTopY: 0.22,
      parts: {
        hull: hullMesh,
        grip: gripMesh,
        button: buttonMesh,
        ledRing: ledRingMesh,
        bottomBase,
      },
    };

    // 7. Interactive Orbit (Pointer drag) & 3D Raycast Click
    let isDragging = false;
    let pointerStartX = 0;
    let pointerStartY = 0;
    let prevMouseX = 0;
    let prevMouseY = 0;
    let manualRotY = 0;
    let manualRotX = 0;

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      pointerStartX = e.clientX;
      pointerStartY = e.clientY;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;
      const deltaX = e.clientX - prevMouseX;
      const deltaY = e.clientY - prevMouseY;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;

      manualRotY += deltaX * 0.01;
      manualRotX = Math.max(-1.2, Math.min(1.2, manualRotX + deltaY * 0.01));

      camera.position.x = 5.2 * Math.sin(manualRotY) * Math.cos(manualRotX);
      camera.position.z = 5.2 * Math.cos(manualRotY) * Math.cos(manualRotX);
      camera.position.y = Math.max(0.5, 3.2 + 5.2 * Math.sin(manualRotX));
      camera.lookAt(0, 0, 0);
    };

    const onPointerUp = (e: PointerEvent) => {
      isDragging = false;
      const moveDist = Math.hypot(e.clientX - pointerStartX, e.clientY - pointerStartY);
      if (moveDist < 6) {
        // Detected user click on canvas - check if clicked on 3D puck
        const rect = domElement.getBoundingClientRect();
        const mouseX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        const mouseY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2(mouseX, mouseY), camera);
        const elements = sceneElementsRef.current;
        if (elements) {
          const intersects = raycaster.intersectObjects([elements.puckGroup], true);
          if (intersects.length > 0) {
            trikiBle.triggerVirtualButtonPress(250);
          }
        }
      }
    };

    const domElement = renderer.domElement;
    domElement.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    // Handle Resize
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
        }
      }
    });
    resizeObserver.observe(container);

    // 8. Animation & Telemetry Render Loop
    // Full 360-degree Euler mapping to Three.js coordinate system
    const _targetQuat = new THREE.Quaternion();
    const _targetEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    let animFrameId = 0;

    const tick = () => {
      const sample = sampleRef.current;
      const elements = sceneElementsRef.current;

      if (elements) {
        if (sample && sample.euler) {
          const pitch = Number.isFinite(sample.euler.pitch) ? sample.euler.pitch : 0;
          const roll = Number.isFinite(sample.euler.roll) ? sample.euler.roll : 0;
          const yaw = Number.isFinite(sample.euler.yaw) ? sample.euler.yaw : 0;

          // Convert to Three.js coordinates:
          // In Three.js: Puck sits flat on ground with button facing UP (+Y)
          // Pitch = rotation around X (tilting front/back)
          // Yaw = rotation around Y (spinning clockwise/counterclockwise)
          // Roll = rotation around Z (tilting left/right)
          const radPitch = THREE.MathUtils.degToRad(-pitch);
          const radYaw = THREE.MathUtils.degToRad(-yaw);
          const radRoll = THREE.MathUtils.degToRad(-roll);

          _targetEuler.set(radPitch, radYaw, radRoll, 'YXZ');
          _targetQuat.setFromEuler(_targetEuler);

          // Smooth interpolation without jerky jumps
          elements.puckGroup.quaternion.slerp(_targetQuat, 0.35);
        }

        // Tactile button depression animation:
        // When pressed: dips to 0.16; when released: returns to 0.22
        const isPressed = sample ? Boolean(sample.button) : false;
        const targetBtnY = isPressed ? 0.16 : 0.22;
        elements.buttonMesh.position.y += (targetBtnY - elements.buttonMesh.position.y) * 0.4;

        // Visual tactile button feedback (color and emissive glow on depression)
        const btnMat = elements.buttonMesh.material as THREE.MeshStandardMaterial;
        if (btnMat) {
          if (isPressed) {
            if (themeRef.current === 'eink') {
              btnMat.color.setHex(0xb0b0a8);
            } else {
              btnMat.color.setHex(0x0284c7);
              btnMat.emissive.setHex(0x0284c7);
              btnMat.emissiveIntensity = 0.8;
            }
          } else {
            if (themeRef.current === 'eink') {
              btnMat.color.setHex(0xe6e6e0);
            } else {
              btnMat.color.setHex(0x334155);
              btnMat.emissive.setHex(0x000000);
              btnMat.emissiveIntensity = 0;
            }
          }
        }

        // Visual feedback for physical and virtual Triki LED ring
        const ledRingMat = elements.ledRingMesh.material as THREE.MeshStandardMaterial;
        if (ledRingMat) {
          const isLedLit = trikiBle.getIsLedOn();
          if (isLedLit) {
            ledRingMat.color.set(activeLedColorRef.current);
            ledRingMat.emissive.set(activeLedColorRef.current);
            ledRingMat.emissiveIntensity = 2.8;
          } else {
            ledRingMat.color.set(themeRef.current === 'eink' ? 0xcccccc : 0x0284c7);
            ledRingMat.emissive.setHex(0x000000);
            ledRingMat.emissiveIntensity = 0.0;
          }
        }
      }

      renderer.render(scene, camera);
      animFrameId = requestAnimationFrame(tick);
    };

    tick();

    // Cleanup
    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      domElement.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);

      renderer.dispose();
      hullGeo.dispose();
      gripGeo.dispose();
      baseGeo.dispose();
      ledGeo.dispose();
      buttonGeo.dispose();
      floorGeo.dispose();
      shadowTexture.dispose();
      if (container.contains(domElement)) {
        container.removeChild(domElement);
      }
    };
  }, []);

  // Sync theme changes
  useEffect(() => {
    const isEink = theme === 'eink';
    const elements = sceneElementsRef.current;
    if (elements) {
      const { hull, grip, button, ledRing, bottomBase } = elements.parts;
      if (isEink) {
        (hull.material as THREE.MeshStandardMaterial).color.setHex(0xf5f5f2);
        (grip.material as THREE.MeshStandardMaterial).color.setHex(0xd8d8d4);
        (button.material as THREE.MeshStandardMaterial).color.setHex(0xe6e6e0);
        (bottomBase.material as THREE.MeshStandardMaterial).color.setHex(0xdeded8);
        (ledRing.material as THREE.MeshStandardMaterial).color.setHex(0xcccccc);
        (ledRing.material as THREE.MeshStandardMaterial).emissive.setHex(0x222222);
        (ledRing.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.15;
      } else {
        (hull.material as THREE.MeshStandardMaterial).color.setHex(0x1e293b);
        (grip.material as THREE.MeshStandardMaterial).color.setHex(0x0f172a);
        (button.material as THREE.MeshStandardMaterial).color.setHex(0x334155);
        (bottomBase.material as THREE.MeshStandardMaterial).color.setHex(0x0f172a);
        (ledRing.material as THREE.MeshStandardMaterial).color.setStyle(activeLedColor);
        (ledRing.material as THREE.MeshStandardMaterial).emissive.setStyle(activeLedColor);
        (ledRing.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.4;
      }
    }
  }, [theme, activeLedColor]);

  // Sync axes visibility
  useEffect(() => {
    if (sceneElementsRef.current) {
      sceneElementsRef.current.axesHelper.visible = showAxes;
    }
  }, [showAxes]);

  // Sync exploded view slider
  useEffect(() => {
    if (sceneElementsRef.current) {
      const parts = sceneElementsRef.current.parts;
      const offset = explodedView * 0.8;
      parts.button.position.y = 0.22 + offset * 1.2;
      parts.ledRing.position.y = 0.23 + offset * 0.9;
      parts.grip.position.y = 0.02 + offset * 0.4;
      parts.bottomBase.position.y = -0.24 - offset * 0.8;
    }
  }, [explodedView]);

  // Sync axis inversions to sensor pipeline
  const handleTogglePitch = () => {
    const next = !invertPitch;
    setInvertPitch(next);
    sensorPipeline.setInversions(next, invertRoll, invertYaw);
  };

  const handleToggleRoll = () => {
    const next = !invertRoll;
    setInvertRoll(next);
    sensorPipeline.setInversions(invertPitch, next, invertYaw);
  };

  const handleToggleYaw = () => {
    const next = !invertYaw;
    setInvertYaw(next);
    sensorPipeline.setInversions(invertPitch, invertRoll, next);
  };

  const handleButtonModeChange = (mode: ButtonMode) => {
    setButtonMode(mode);
    trikiBle.setButtonMode(mode);
  };

  const handleSimulateClick = () => {
    trikiBle.triggerVirtualButtonPress(250);
  };

  const handleResetClicks = () => {
    trikiBle.resetButtonPressCount();
  };

  const handleFilterChange = (mode: FusionFilterMode) => {
    setCurrentFilter(mode);
    sensorPipeline.setFilterMode(mode);
    if (onFilterModeChange) onFilterModeChange(mode);
  };

  const handleToggleSwapPitchRoll = () => {
    const next = !swapPitchRoll;
    setSwapPitchRoll(next);
    sensorPipeline.setSwapPitchRoll(next);
  };

  const handleToggleLed = async () => {
    const next = !isLedOn;
    setIsLedOn(next);
    await trikiBle.toggleLed(next, ledMethod);
  };

  const handleTestBlink = async () => {
    await trikiBle.testBlink(3);
    setIsLedOn(trikiBle.getIsLedOn());
  };

  const handleLedMethodChange = (method: LedControlMethod) => {
    setLedMethod(method);
    trikiBle.setLedControlMethod(method);
  };

  const handleColorSelect = (colorHex: string, r: number, g: number, b: number) => {
    setActiveLedColor(colorHex);
    const cmd: LedCommand = { r, g, b, brightness: 255 };
    trikiBle.sendLedCommand(cmd);
    setIsLedOn(true);
  };

  // Keep isLedOn and swapPitchRoll in sync with BLE and pipeline
  useEffect(() => {
    const unsubscribeCal = sensorPipeline.onFilterConfigChange((cfg) => {
      setSwapPitchRoll(cfg.swapPitchRoll);
      setCurrentFilter(cfg.mode);
      setInvertPitch(cfg.invertPitch);
      setInvertRoll(cfg.invertRoll);
      setInvertYaw(cfg.invertYaw);
    });

    const unsubscribeBle = trikiBle.onStateChange((state) => {
      if (state.ledEnabled !== undefined) {
        setIsLedOn(state.ledEnabled);
      }
    });

    return () => {
      unsubscribeCal();
    };
  }, []);

  const isEink = theme === 'eink';

  return (
    <div className="relative w-full h-full min-h-[320px] sm:min-h-[440px] rounded-xl overflow-hidden select-none">
      {/* Three.js canvas mount container with touch-none for smooth mobile gesture tracking */}
      <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing touch-none" />

      {/* Top Spec Badge / Orientation HUD */}
      <div
        className={`absolute top-2 left-2 sm:top-4 sm:left-4 max-w-[calc(100%-1rem)] sm:max-w-none text-[10px] sm:text-xs font-mono px-2.5 py-1.5 sm:px-3.5 sm:py-2.5 rounded-lg transition-colors ${
          isEink
            ? 'bg-white/95 text-black border border-black shadow-none backdrop-blur-xs'
            : 'bg-white/95 text-slate-800 border border-slate-200 shadow-sm backdrop-blur-sm'
        }`}
      >
        <div className="flex items-center justify-between gap-2 sm:gap-4 font-semibold text-slate-900 dark:text-white uppercase tracking-wider mb-1">
          <span className="truncate">Żabka Triki (CAP001)</span>
          <div className="flex items-center gap-1 sm:gap-1.5 pointer-events-auto shrink-0">
            {swapPitchRoll && (
              <span className={`text-[9px] sm:text-[10px] px-1.5 py-0.2 rounded font-normal ${
                isEink ? 'border border-black bg-zinc-100 text-black' : 'bg-emerald-100 text-emerald-800'
              }`} title="Zamiana Pitch ⇄ Roll na stałe włączona">
                P⇄R
              </span>
            )}
            {(invertPitch || invertYaw) && (
              <span className={`text-[9px] sm:text-[10px] px-1.5 py-0.2 rounded font-normal ${
                isEink ? 'border border-black bg-zinc-100 text-black' : 'bg-sky-100 text-sky-800'
              }`} title="Odwrócenie osi Pitch i Yaw aktywne">
                P/Y odwr.
              </span>
            )}
            {onOpenFilterSettings && (
              <button
                onClick={onOpenFilterSettings}
                className={`text-[9px] sm:text-[10px] font-semibold px-1.5 sm:px-2 py-0.5 rounded transition-colors flex items-center gap-1 cursor-pointer ${
                  isEink
                    ? 'border border-black bg-white text-black hover:bg-zinc-100'
                    : 'bg-sky-100 hover:bg-sky-200 text-sky-800'
                }`}
                title="Otwórz panel edycji filtracji sensorów"
              >
                <Sliders className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                <span className="hidden xs:inline">Filtry</span>
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-2 sm:gap-3 tabular-nums text-[10px] sm:text-xs">
          <span>R: <strong className={isEink ? 'text-black' : 'text-sky-600'}>{latestSample ? latestSample.euler.roll.toFixed(1) : '0.0'}°</strong></span>
          <span>P: <strong className={isEink ? 'text-black' : 'text-indigo-600'}>{latestSample ? latestSample.euler.pitch.toFixed(1) : '0.0'}°</strong></span>
          <span>Y: <strong className={isEink ? 'text-black' : 'text-amber-600'}>{latestSample ? latestSample.euler.yaw.toFixed(1) : '0.0'}°</strong></span>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2 mt-1 text-[10px] sm:text-[11px] flex-wrap pointer-events-none">
          <span
            className={`font-semibold px-1.5 py-0.2 rounded transition-colors ${
              latestSample?.button
                ? isEink
                  ? 'border border-black bg-zinc-200 text-black font-bold'
                  : 'bg-emerald-600 text-white shadow-xs'
                : isEink
                ? 'border border-zinc-300 bg-white text-zinc-600'
                : 'bg-slate-100 text-slate-500 border border-slate-200'
            }`}
          >
            {latestSample?.button ? '● WCIŚNIĘTY' : '○ PUSZCZONY'}
          </span>
          <span className="opacity-50">·</span>
          <span className={`px-1.5 py-0.2 rounded font-semibold text-[9px] sm:text-[10px] ${isLedOn ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-400'}`}>
            LED: {isLedOn ? '● ON' : '○ OFF'}
          </span>
          <span className="opacity-50 hidden xs:inline">·</span>
          <span className="hidden xs:inline">Kliknięcia: {latestSample?.buttonPressCount ?? 0}</span>
        </div>
      </div>

      {/* Ergonomic Collapsible Bottom Control Dock */}
      <div className="absolute bottom-2 sm:bottom-3 left-1/2 -translate-x-1/2 w-[96%] sm:w-[94%] max-w-[650px] z-10 transition-all">
        {/* Collapse toggle tab */}
        <div className="flex justify-center mb-1">
          <button
            onClick={() => setDockExpanded(!dockExpanded)}
            className={`text-[11px] font-mono px-3 py-1.5 rounded-t-md border-t border-x transition-colors min-h-[36px] flex items-center ${
              isEink
                ? 'bg-white text-black border-black font-bold'
                : 'bg-white text-slate-700 border-slate-200 hover:text-slate-900 shadow-xs'
            }`}
          >
            {dockExpanded ? '▾ Zwiń narzędzia LED & sensorów' : '▴ Narzędzia LED, filtracja & przycisk'}
          </button>
        </div>

        {dockExpanded && (
          <div
            className={`p-2.5 sm:p-3.5 max-h-[50vh] overflow-y-auto rounded-xl border flex flex-col gap-2.5 sm:gap-3 transition-colors ${
              isEink
                ? 'bg-white border-2 border-black text-black shadow-none'
                : 'bg-white text-slate-800 border-slate-200 shadow-md'
            }`}
          >
            {/* Row 1: Tare & Filter mode selection */}
            <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
              <div className="flex items-center gap-2">
                <button
                  onClick={onResetOrientation}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition-colors ${
                    isEink
                      ? 'border-2 border-black bg-white text-black hover:bg-zinc-100 font-bold'
                      : 'bg-sky-600 text-white hover:bg-sky-700 shadow-xs'
                  }`}
                  title="Ustawia obecną pozycję jako bazowe (0, 0, 0)"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Zeruj bazę (Tare 0,0,0)</span>
                </button>

                <button
                  onClick={() => setShowAxes(!showAxes)}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-medium border text-[11px] transition-colors ${
                    showAxes
                      ? isEink ? 'border border-black bg-zinc-200 text-black font-bold' : 'bg-slate-100 text-slate-900 border-slate-300'
                      : isEink ? 'border border-zinc-300 text-zinc-700' : 'border-slate-200 text-slate-600'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  <span>Osie</span>
                </button>

                {onOpenFilterSettings && (
                  <button
                    onClick={onOpenFilterSettings}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-semibold border text-[11px] transition-colors ${
                      isEink
                        ? 'border border-black bg-white text-black hover:bg-zinc-100'
                        : 'border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
                    }`}
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">Edycja filtrów...</span>
                    <span className="sm:hidden">Filtry</span>
                  </button>
                )}
              </div>

              {/* Filter Mode Selector */}
              <div className="flex items-center gap-1 border rounded-lg p-0.5 text-[11px]">
                <button
                  onClick={() => handleFilterChange('complementary')}
                  className={`px-2 py-1 rounded font-medium transition-colors ${
                    currentFilter === 'complementary'
                      ? isEink ? 'border border-black bg-zinc-200 text-black font-bold' : 'bg-slate-900 text-white'
                      : isEink ? 'text-zinc-700 hover:text-black' : 'text-slate-600 hover:text-slate-900'
                  }`}
                  title="Płynny, pełny zakres 360° (polecany dla Triki)"
                >
                  Komplementarny (360°)
                </button>
                <button
                  onClick={() => handleFilterChange('madgwick')}
                  className={`px-2 py-1 rounded font-medium transition-colors ${
                    currentFilter === 'madgwick'
                      ? isEink ? 'border border-black bg-zinc-200 text-black font-bold' : 'bg-slate-900 text-white'
                      : isEink ? 'text-zinc-700 hover:text-black' : 'text-slate-600 hover:text-slate-900'
                  }`}
                  title="Algorytm Madgwick AHRS"
                >
                  Madgwick AHRS
                </button>
              </div>
            </div>

            {/* Row 2: LED CONTROL SECTION */}
            <div
              className={`p-2.5 rounded-lg border flex items-center justify-between gap-3 flex-wrap text-[11px] ${
                isEink ? 'bg-zinc-50 border-black' : 'bg-amber-50/70 border-amber-200'
              }`}
            >
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                  <Lightbulb className={`w-4 h-4 ${isLedOn ? 'text-amber-500 fill-amber-400' : 'text-slate-400'}`} />
                  Sterowanie Diodą LED:
                </span>

                {/* Big Clear LED Toggle Button */}
                <button
                  onClick={handleToggleLed}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold transition-all shadow-xs ${
                    isLedOn
                      ? 'bg-amber-500 text-white hover:bg-amber-600 ring-2 ring-amber-300'
                      : isEink
                      ? 'border-2 border-black bg-white text-black hover:bg-zinc-100 font-bold'
                      : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                  }`}
                  title="Włącza lub wyłącza fizyczną diodę LED na krążku Triki (kod 0x01 / 0x00)"
                >
                  <span className={`w-2 h-2 rounded-full ${isLedOn ? 'bg-white animate-pulse' : 'bg-slate-400'}`}></span>
                  <span>{isLedOn ? 'WYŁĄCZ LED (ON)' : 'WŁĄCZ LED (OFF)'}</span>
                </button>

                {/* 3x Blink Diagnostic Test */}
                <button
                  onClick={handleTestBlink}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-medium border text-[11px] transition-colors ${
                    isEink
                      ? 'border border-black bg-white text-black hover:bg-zinc-100'
                      : 'border-amber-300 bg-white hover:bg-amber-100 text-amber-800 shadow-xs'
                  }`}
                  title="Wykonuje sekwencję 3 mignięć diodą LED, aby zweryfikować reakcję sprzętu"
                >
                  <span>Miganie (Blink 3x)</span>
                </button>
              </div>

              {/* Target Characteristic Selector for LED */}
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-slate-500">Kanał:</span>
                <select
                  value={ledMethod}
                  onChange={(e) => handleLedMethodChange(e.target.value as LedControlMethod)}
                  className={`px-1.5 py-1 rounded border text-[10px] font-mono cursor-pointer ${
                    isEink ? 'bg-white text-black border-black' : 'bg-white text-slate-700 border-slate-300'
                  }`}
                  title="Wybierz charakterystykę docelową BLE dla komendy diody LED"
                >
                  <option value="auto">Auto (0x6E400004 + fallback RX)</option>
                  <option value="char-6e400004">Char 0x6E400004 (Zalecane)</option>
                  <option value="nus-rx-01">NUS RX (Bajt 0x01 / 0x00)</option>
                  <option value="both">Wyślij do obu jednocześnie</option>
                  <option value="nus-rx-vendor">NUS RX (Vendor 0x2002)</option>
                </select>
              </div>
            </div>

            {/* Row 3: Dedicated Button Configuration & Live Diagnostic Bar */}
            <div
              className={`p-2.5 rounded-lg border flex items-center justify-between gap-3 flex-wrap text-[11px] ${
                isEink ? 'bg-zinc-50 border-black' : 'bg-slate-50 border-slate-200'
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-slate-700">Tryb przycisku:</span>
                <select
                  value={buttonMode}
                  onChange={(e) => handleButtonModeChange(e.target.value as ButtonMode)}
                  className={`px-2 py-1 rounded border text-[11px] font-mono cursor-pointer transition-colors ${
                    isEink
                      ? 'bg-white text-black border-black font-bold'
                      : 'bg-white text-slate-800 border-slate-300 focus:outline-sky-500'
                  }`}
                  title="Wybierz jak aplikacja interpretuje sygnał przycisku z krążka"
                >
                  <option value="exact-01">Domyślny Triki (Bajt[1] == 0x01)</option>
                  <option value="inverted">Odwrócony Triki (Bajt[1] == 0x00)</option>
                  <option value="bit0">Maska bitowa (Bajt[1] & 0x01)</option>
                  <option value="nonzero">Wartość &gt; 0 (Bajt[1] &gt; 0)</option>
                  <option value="manual">Tylko wirtualny (Kliknięcie myszką)</option>
                  <option value="tap">Gest Tap (Stuknięcie w obudowę)</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleSimulateClick}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded font-medium border text-[11px] transition-colors ${
                    isEink
                      ? 'border-2 border-black bg-white text-black hover:bg-zinc-100 font-bold'
                      : 'bg-white hover:bg-slate-100 text-sky-700 border-sky-300 shadow-xs'
                  }`}
                  title="Symuluje wciśnięcie przycisku i włącza impuls na diodzie LED krążka"
                >
                  <MousePointerClick className="w-3.5 h-3.5" />
                  <span>Testuj Klik</span>
                </button>

                <button
                  onClick={handleResetClicks}
                  className={`flex items-center gap-1 px-2 py-1 rounded border text-[11px] font-mono transition-colors ${
                    isEink
                      ? 'border-black text-black hover:bg-zinc-200'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                  }`}
                  title="Zeruj licznik kliknięć"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Zeruj ({latestSample?.buttonPressCount ?? 0})</span>
                </button>
              </div>
            </div>

            {/* Row 4: Axis Inversion & Pitch/Roll Swap Toggles */}
            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-100 text-[11px] flex-wrap">
              <div className="flex items-center gap-3 flex-wrap">
                {/* Swap Pitch ⇄ Roll Checkbox (Permanent default) */}
                <label className="flex items-center gap-1.5 font-bold cursor-pointer select-none bg-emerald-50 text-emerald-800 border border-emerald-300 px-2 py-0.5 rounded shadow-2xs" title="Zamiana Pitch ⇄ Roll na stałe włączona">
                  <input
                    type="checkbox"
                    checked={swapPitchRoll}
                    onChange={handleToggleSwapPitchRoll}
                    className="accent-emerald-600 cursor-pointer"
                  />
                  <span>Pitch ⇄ Roll (Na stałe)</span>
                </label>

                <span className="text-slate-300">|</span>

                <span className="font-semibold text-slate-600">Odwracanie:</span>
                <label className={`flex items-center gap-1 cursor-pointer select-none px-1.5 py-0.2 rounded ${invertPitch ? 'bg-indigo-50 text-indigo-800 font-semibold' : ''}`} title="Odwrócenie osi Pitch (Pochylenie)">
                  <input
                    type="checkbox"
                    checked={invertPitch}
                    onChange={handleTogglePitch}
                    className="accent-indigo-600 cursor-pointer"
                  />
                  <span>Pitch (Odwr.)</span>
                </label>
                <label className={`flex items-center gap-1 cursor-pointer select-none px-1.5 py-0.2 rounded ${invertRoll ? 'bg-sky-50 text-sky-800 font-semibold' : ''}`} title="Odwrócenie osi Roll (Przechył)">
                  <input
                    type="checkbox"
                    checked={invertRoll}
                    onChange={handleToggleRoll}
                    className="accent-sky-600 cursor-pointer"
                  />
                  <span>Roll</span>
                </label>
                <label className={`flex items-center gap-1 cursor-pointer select-none px-1.5 py-0.2 rounded ${invertYaw ? 'bg-amber-50 text-amber-800 font-semibold' : ''}`} title="Odwrócenie osi Yaw (Obrót wokół Z)">
                  <input
                    type="checkbox"
                    checked={invertYaw}
                    onChange={handleToggleYaw}
                    className="accent-amber-600 cursor-pointer"
                  />
                  <span>Yaw (Odwr.)</span>
                </label>
              </div>

              {/* Color swatches */}
              {!isEink && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-slate-500">Kolor LED:</span>
                  {[
                    { hex: '#00e5ff', r: 0, g: 229, b: 255, name: 'Cyan' },
                    { hex: '#10b981', r: 16, g: 185, b: 129, name: 'Green' },
                    { hex: '#ef4444', r: 239, g: 68, b: 68, name: 'Red' },
                    { hex: '#f59e0b', r: 245, g: 158, b: 11, name: 'Amber' },
                    { hex: '#a855f7', r: 168, g: 85, b: 247, name: 'Purple' },
                    { hex: '#ffffff', r: 255, g: 255, b: 255, name: 'White' },
                  ].map((c) => (
                    <button
                      key={c.hex}
                      onClick={() => handleColorSelect(c.hex, c.r, c.g, c.b)}
                      className={`w-3.5 h-3.5 rounded-full transition-transform ${
                        activeLedColor === c.hex ? 'scale-125 ring-2 ring-slate-400 ring-offset-1' : 'hover:scale-110'
                      }`}
                      style={{ backgroundColor: c.hex }}
                      title={`Ustaw LED: ${c.name}`}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
