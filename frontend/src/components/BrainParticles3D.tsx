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

/**
 * The brain, the facial markers AND the electrodes all rotate together
 * inside this group so that the auto-spin (and the user's drag) keep the
 * nose/eyes/ears glued to the "front" of the head and the electrodes
 * fixed to their 10-20 positions. Children are passed in so the parent
 * (which holds the React event handlers) can render the electrode meshes.
 */
function RotatingHead({ tint, children }: { tint: string; children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const positions = useMemo(() => buildBrainCloud(), []);

  useFrame((_state, dt) => {
    if (group.current) {
      // Subtle auto-rotation — fast enough to be alive, slow enough that
      // a user-driven OrbitControls drag doesn't have to fight it.
      group.current.rotation.y += dt * 0.12;
    }
  });

  return (
    <group ref={group}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
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
      <FaceMarkers />
      {children}
    </group>
  );
}

/**
 * Tiny anatomy hints — a nose, two eyes, two ears — so the operator can
 * tell at a glance which side of the brain is the *front*. Otherwise the
 * particle cloud is rotationally symmetric and the auto-spin disorients.
 * Coordinates match the same convention as `montage.ts:lift3D`:
 *   +x = right ear, +y = top of head, +z = nose / forward.
 */
function FaceMarkers() {
  // Skin-ish tone, slightly lighter than the dark canvas background so the
  // markers read as anatomy rather than as more electrodes (electrodes use
  // saturated region colours).
  const SKIN = "#d4a791";
  const PUPIL = "#1a1d22";

  return (
    <group>
      {/* Nose — small cone pointing along +Z, sitting on the lower-front of
       *  the dome. ConeGeometry's apex defaults to +Y, so rotate -π/2 on X
       *  to make it point at the camera in the default view. */}
      <mesh position={[0, 0.1, 1.02]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.07, 0.18, 12]} />
        <meshBasicMaterial color={SKIN} />
      </mesh>

      {/* Eyes — two small dark spheres on the front-lower face. */}
      <mesh position={[-0.25, -0.05, 0.95]}>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshBasicMaterial color={PUPIL} />
      </mesh>
      <mesh position={[0.25, -0.05, 0.95]}>
        <sphereGeometry args={[0.06, 12, 12]} />
        <meshBasicMaterial color={PUPIL} />
      </mesh>

      {/* Ears — torus rings on the side of the head, oriented so the hole
       *  faces outward (visible from the side). */}
      <mesh position={[-1.02, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[0.12, 0.04, 10, 24]} />
        <meshBasicMaterial color={SKIN} />
      </mesh>
      <mesh position={[1.02, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[0.12, 0.04, 10, 24]} />
        <meshBasicMaterial color={SKIN} />
      </mesh>
    </group>
  );
}

function ElectrodeMarker({
  ch,
  pos,
  value,
  vmax,
  hovered,
  onHover,
  onSelect,
}: {
  ch: number;
  pos: [number, number, number];
  value: number;
  vmax: number;
  hovered: boolean;
  onHover: (ch: number | null) => void;
  onSelect?: (ch: number) => void;
}) {
  // Marker size scales with the channel's band power so the user can see at
  // a glance which electrodes are "hot" right now. We intentionally don't
  // bias the marker for the "decision" set: the 3D brain is an at-a-glance
  // view and the user found the default-highlighted dots distracting. The
  // decision channels are still visible in the table/topography below.
  const norm = vmax > 0 ? Math.min(1, value / vmax) : 0;
  const base = 0.042;
  const size = base + norm * 0.04 + (hovered ? 0.025 : 0);

  const color = hovered
    ? "#d97757"            // brand accent (hover = focus)
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
  hovered,
  onHover,
  onSelect,
}: BrainParticles3DProps) {
  const vmax = Math.max(1e-9, ...values);

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
        <RotatingHead tint={BAND_COLORS[band]}>
          {MONTAGE.map((e) => (
            <ElectrodeMarker
              key={e.ch}
              ch={e.ch}
              pos={e.pos3}
              value={values[e.ch] ?? 0}
              vmax={vmax}
              hovered={hovered === e.ch}
              onHover={onHover}
              onSelect={onSelect}
            />
          ))}
        </RotatingHead>
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
