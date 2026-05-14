/**
 * 3D brain viz with 16 PiEEG electrodes overlaid on the surface.
 *
 * Shape: an upper-hemisphere "dome" (no GLTF — keeps bundle size small).
 * The dome is built from:
 *   • a wireframe ellipsoid shell that gives the cortex its silhouette,
 *   • a translucent inner shell so the back of the dome doesn't disappear,
 *   • a particle cloud filling the upper-half volume for cortex texture,
 *   • a vertical longitudinal-fissure line that splits the two hemispheres
 *     so the head reads as a brain rather than a featureless dome.
 *
 * Facial cues (nose / eyes / ears) glued to the +Z face make the
 * front/back/sides obvious during auto-spin. Everything rotates together
 * inside a single `<group>` so the markers stay anatomically correct.
 *
 * This module is `React.lazy`-imported from the PiEEG tab so three.js
 * stays out of the initial bundle.
 */
import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

import { MONTAGE, REGION_COLORS } from "../montage";
import { BAND_COLORS, BandName } from "../types";

const PARTICLE_COUNT = 3500;
// Brain-ish ellipsoid radii (x: ear-to-ear, y: top-to-base, z: front-to-back).
// Upper-hemisphere dome — y is sampled from 0..RY only.
const BRAIN_RX = 0.9;
const BRAIN_RY = 0.7;
const BRAIN_RZ = 1.05;
// Fissure half-width: particles within this distance of the central plane
// (x=0) are excluded so a clear groove runs front-to-back across the dome.
const FISSURE_WIDTH = 0.04;
// Slight outward offset so electrodes float just above the wireframe shell
// instead of intersecting it. 1.04 = "1.0 surface + 4% bump" — enough to
// be visible without disconnecting from the cortex.
const ELECTRODE_LIFT = 1.04;
// montage.ts builds pos3 on a sphere of radius 1.05 (right ear = +1). Map
// that unit-sphere position to our ellipsoid by axis-scaling.
const MONTAGE_SPHERE_R = 1.05;
function electrodePos(p: [number, number, number]): [number, number, number] {
  return [
    (p[0] / MONTAGE_SPHERE_R) * BRAIN_RX * ELECTRODE_LIFT,
    (p[1] / MONTAGE_SPHERE_R) * BRAIN_RY * ELECTRODE_LIFT,
    (p[2] / MONTAGE_SPHERE_R) * BRAIN_RZ * ELECTRODE_LIFT,
  ];
}

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

/**
 * Sample particle positions inside an *upper-hemisphere* brain volume.
 *
 * Rejection-sample within the ellipsoid (y >= 0 only), bias toward the
 * surface so the cortex reads denser than the interior, and carve out a
 * thin strip along x=0 to suggest the longitudinal fissure.
 */
function buildBrainCloud(): Float32Array {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  let i = 0;
  let guard = 0;
  while (i < PARTICLE_COUNT && guard++ < PARTICLE_COUNT * 20) {
    const x = (Math.random() * 2 - 1) * BRAIN_RX;
    // Allow a tiny negative lip (-0.05) so the rim of the dome isn't a
    // razor-sharp horizon — it tapers slightly under the base plane.
    const y = Math.random() * BRAIN_RY - 0.05;
    const z = (Math.random() * 2 - 1) * BRAIN_RZ;
    const f = (x * x) / (BRAIN_RX * BRAIN_RX)
            + (y * y) / (BRAIN_RY * BRAIN_RY)
            + (z * z) / (BRAIN_RZ * BRAIN_RZ);
    if (f > 1) continue;
    if (Math.abs(x) < FISSURE_WIDTH) continue;
    // Bias toward the surface so the cortex looks denser than the interior.
    const t = 0.55 + 0.45 * Math.sqrt(f);
    arr[i * 3 + 0] = x * t;
    arr[i * 3 + 1] = y * t;
    arr[i * 3 + 2] = z * t;
    i++;
  }
  // If sampling stalled (very unlikely with these radii), fill the rest with
  // zeros — the buffer length is fixed.
  return arr;
}

/**
 * Wireframe + faint backfill that gives the brain its outer silhouette.
 * Without this the particles alone read as a dust cloud; with it, the
 * dome has a clear boundary the eye can lock onto.
 */
function BrainShell({ tint }: { tint: string }) {
  return (
    <group scale={[BRAIN_RX, BRAIN_RY, BRAIN_RZ]}>
      {/* Slim wireframe — outer cortex line work. */}
      <mesh>
        <sphereGeometry args={[1.0, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial color={tint} wireframe transparent opacity={0.22} />
      </mesh>
      {/* Translucent backside fill so the dome reads as a solid object
       *  rather than a wire cage when seen from behind. */}
      <mesh>
        <sphereGeometry args={[0.97, 28, 18, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshBasicMaterial
          color={tint}
          transparent
          opacity={0.06}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/**
 * The brain, the facial markers AND the electrodes all rotate together
 * inside this group. Children are passed in so the parent (which owns the
 * React event handlers) can render the electrode meshes inline.
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
      <BrainShell tint={tint} />
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial
          color={tint}
          size={0.016}
          sizeAttenuation
          transparent
          opacity={0.85}
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
 * tell at a glance which side is the front. Anatomy reminder:
 *   eyes ABOVE the nose tip, ears on the SIDE of the head.
 *   Cone geometry's apex defaults to +Y; rotating +π/2 on X makes it
 *   point along +Z (toward the camera in the default view).
 * Convention matches montage.ts:lift3D — +x = right ear, +y = top of head,
 * +z = nose / forward.
 */
function FaceMarkers() {
  // Cooler skin tone so it doesn't fight the brand accent (#d97757) used
  // by hovered electrodes.
  const SKIN = "#c8b8a8";
  const PUPIL = "#1a1d22";

  return (
    <group>
      {/* Nose — apex points forward (+Z). Sits low on the face, *below*
       *  the eye line, matching real anatomy. */}
      <mesh position={[0, 0.02, 1.0]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.055, 0.16, 12]} />
        <meshBasicMaterial color={SKIN} />
      </mesh>

      {/* Eyes — small dark spheres ABOVE the nose, near the front of the
       *  dome. They face +Z so they're only visible from the front. */}
      <mesh position={[-0.22, 0.18, 0.92]}>
        <sphereGeometry args={[0.05, 12, 12]} />
        <meshBasicMaterial color={PUPIL} />
      </mesh>
      <mesh position={[0.22, 0.18, 0.92]}>
        <sphereGeometry args={[0.05, 12, 12]} />
        <meshBasicMaterial color={PUPIL} />
      </mesh>

      {/* Ears — torus rings on the side, hole facing outward (visible from
       *  the side view). Sat slightly below the dome's equator so they
       *  read as ears rather than parietal electrodes. */}
      <mesh position={[-0.95, 0.05, 0]} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[0.1, 0.035, 10, 24]} />
        <meshBasicMaterial color={SKIN} />
      </mesh>
      <mesh position={[0.95, 0.05, 0]} rotation={[0, Math.PI / 2, 0]}>
        <torusGeometry args={[0.1, 0.035, 10, 24]} />
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
  // a glance which electrodes are "hot" right now.
  const norm = vmax > 0 ? Math.min(1, value / vmax) : 0;
  const base = 0.04;
  const size = base + norm * 0.035 + (hovered ? 0.02 : 0);

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
  // the user is still hovering an electrode (e.g., tab switch mid-hover).
  useEffect(() => () => { document.body.style.cursor = ""; }, []);

  return (
    <div className="brain3d-canvas">
      <Canvas
        camera={{ position: [0, 0.45, 2.8], fov: 45 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.7} />
        <pointLight position={[3, 3, 3]} intensity={0.6} />
        <RotatingHead tint={BAND_COLORS[band]}>
          {MONTAGE.map((e) => (
            <ElectrodeMarker
              key={e.ch}
              ch={e.ch}
              pos={electrodePos(e.pos3)}
              value={values[e.ch] ?? 0}
              vmax={vmax}
              hovered={hovered === e.ch}
              onHover={onHover}
              onSelect={onSelect}
            />
          ))}
        </RotatingHead>
        {/* Drag to rotate. Damping smooths the inertia so it doesn't fight
         *  the auto-spin. Zoom disabled — page is tall and a trackpad
         *  scroll inside the canvas would otherwise hijack page-scroll. */}
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
