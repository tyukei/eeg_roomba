/**
 * 3D particle brain with 16 PiEEG electrodes overlaid on the surface.
 *
 * Why particles vs a real mesh: a brain GLTF would push the bundle into
 * megabytes. A few thousand jittered points inside a brain-ish ellipsoid
 * look surprisingly anatomical at this size and are dependency-light. The
 * electrodes are clickable spheres on a slightly larger sphere so they
 * float just above the particle cloud.
 *
 * This module is meant to be `React.lazy`-imported from the PiEEG tab so
 * three.js isn't pulled into the initial bundle.
 */
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

import { MONTAGE, REGION_COLORS } from "../montage";
import { BAND_COLORS, BandName } from "../types";

const PARTICLE_COUNT = 4000;
// Brain-ish ellipsoid radii (x: ear-to-ear, y: top-to-chin, z: front-to-back).
const BRAIN_RX = 0.9;
const BRAIN_RY = 0.78;
const BRAIN_RZ = 1.05;

interface BrainParticles3DProps {
  /** Per-channel value (e.g. current α power) used to size each electrode marker. */
  values: number[];
  /** Which band the `values` represent — drives the electrode tint. */
  band: BandName;
  /** Which channels are currently the "decision" set (highlighted). */
  selected: number[];
  /** The single channel under the user's pointer (cross-panel hover). */
  hovered: number | null;
  /** Notify the parent of hover/click events so they can drive other panels. */
  onHover: (ch: number | null) => void;
  onSelect?: (ch: number) => void;
}

/** Build a Float32Array of particle positions inside a brain-shaped volume.
 *  Rejection-sample within the ellipsoid, then bias each point slightly
 *  outward so the cloud looks denser at the cortex than the interior — that
 *  reads as "brain surface" without us having to compute an actual mesh. */
function buildBrainCloud(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  let i = 0;
  while (i < PARTICLE_COUNT) {
    const x = (Math.random() * 2 - 1) * BRAIN_RX;
    const y = (Math.random() * 2 - 1) * BRAIN_RY;
    const z = (Math.random() * 2 - 1) * BRAIN_RZ;
    const f = (x * x) / (BRAIN_RX * BRAIN_RX)
            + (y * y) / (BRAIN_RY * BRAIN_RY)
            + (z * z) / (BRAIN_RZ * BRAIN_RZ);
    if (f > 1) continue;
    // Bias toward the surface — points closer to f=1 are denser visually.
    const t = 0.5 + 0.5 * Math.sqrt(f);
    arr[i * 3 + 0] = x * t;
    arr[i * 3 + 1] = y * t;
    arr[i * 3 + 2] = z * t;
    i++;
  }
  return arr;
}

function ParticleBrain({ tint }: { tint: string }) {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => buildBrainCloud(), []);

  useFrame((_state, dt) => {
    if (ref.current) {
      // Subtle auto-rotation — fast enough to be alive, slow enough that
      // a user-driven OrbitControls drag doesn't have to fight it.
      ref.current.rotation.y += dt * 0.12;
    }
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[positions, 3]}
        />
      </bufferGeometry>
      <pointsMaterial
        color={tint}
        size={0.018}
        sizeAttenuation
        transparent
        opacity={0.7}
        depthWrite={false}
      />
    </points>
  );
}

function ElectrodeMarker({
  ch,
  pos,
  value,
  vmax,
  selected,
  hovered,
  onHover,
  onSelect,
}: {
  ch: number;
  pos: [number, number, number];
  value: number;
  vmax: number;
  selected: boolean;
  hovered: boolean;
  onHover: (ch: number | null) => void;
  onSelect?: (ch: number) => void;
}) {
  // Marker size scales with the channel's band power so the user can see at
  // a glance which electrodes are "hot" right now, similar to the topomap
  // but in 3D.
  const norm = vmax > 0 ? Math.min(1, value / vmax) : 0;
  const base = 0.045;
  const size = base + norm * 0.04 + (hovered ? 0.025 : 0) + (selected ? 0.01 : 0);

  const color = hovered
    ? "#d97757"            // brand accent (hover = focus)
    : selected
      ? "#86b5d9"
      : REGION_COLORS[MONTAGE[ch].region];

  return (
    <mesh
      position={pos}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        onHover(ch);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        onHover(null);
        document.body.style.cursor = "";
      }}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        onSelect?.(ch);
      }}
    >
      <sphereGeometry args={[size, 16, 16]} />
      <meshBasicMaterial color={color} transparent opacity={hovered ? 1 : 0.9} />
    </mesh>
  );
}

export default function BrainParticles3D({
  values,
  band,
  selected,
  hovered,
  onHover,
  onSelect,
}: BrainParticles3DProps) {
  const vmax = Math.max(1e-9, ...values);
  const selSet = useMemo(() => new Set(selected), [selected]);

  // Reset the body cursor on unmount in case the component disappears while
  // the user is still hovering an electrode (e.g., tab switch mid-hover). The
  // ElectrodeMarker's onPointerOut wouldn't fire in that case, leaving the
  // page cursor stuck as "pointer".
  useEffect(() => () => { document.body.style.cursor = ""; }, []);

  return (
    <div className="brain3d-canvas">
      <Canvas
        camera={{ position: [0, 0.5, 3.0], fov: 45 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.7} />
        <pointLight position={[3, 3, 3]} intensity={0.6} />
        {/* Particle cloud tinted by the current band so this panel reads
         *  distinctly from the 2D topography — otherwise it's just a fancy
         *  duplicate of the same data. */}
        <ParticleBrain tint={BAND_COLORS[band]} />
        {MONTAGE.map((e) => (
          <ElectrodeMarker
            key={e.ch}
            ch={e.ch}
            pos={e.pos3}
            value={values[e.ch] ?? 0}
            vmax={vmax}
            selected={selSet.has(e.ch)}
            hovered={hovered === e.ch}
            onHover={onHover}
            onSelect={onSelect}
          />
        ))}
        {/* Drag to rotate. enableDamping makes it feel less jerky. We keep
         *  auto-rotation on the brain itself rather than on the camera so
         *  dragging doesn't fight an orbit-camera autospin.
         *
         *  Zoom is disabled because the tab is tall and a two-finger trackpad
         *  scroll would otherwise hijack page-scroll → zoom — once the user
         *  enters the canvas they couldn't scroll past it. */}
        <OrbitControls
          enablePan={false}
          enableZoom={false}
          enableDamping
          dampingFactor={0.08}
        />
      </Canvas>
      {hovered !== null && (
        <div className="brain3d-tip">
          <strong>ch{hovered}</strong>
          <span>{MONTAGE[hovered]?.name}</span>
          <small>{(values[hovered] ?? 0).toFixed(2)}</small>
        </div>
      )}
    </div>
  );
}
