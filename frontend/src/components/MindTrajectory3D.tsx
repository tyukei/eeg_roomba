/**
 * 3D trajectory through (focus, relax, time) cognitive space.
 *
 * x = focus index (β/(α+θ)) normalized 0..1
 * z = relax index (α/(α+β)) 0..1
 * y = time, oldest at the bottom, newest at the top
 *
 * The curve reveals state evolution: a tall vertical streak means the
 * subject is locked into one quadrant, a wide diagonal means they are
 * swinging between focused and relaxed. The current sample is rendered
 * as a glowing accent sphere on top.
 *
 * React.lazy-imported so three.js stays out of the initial bundle.
 */
import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Line, OrbitControls, Text } from "@react-three/drei";
import * as THREE from "three";

import { BandName, NCH } from "../types";

interface Props {
  bandsBuf: React.MutableRefObject<{
    ts: number[];
    bands: Record<BandName, number[][]>;
  }>;
  tick: number;
}

const EPS = 1e-6;
const FOCUS_MAX = 2; // β/(α+θ) tends to live in 0..~2

function meanAtTime(grid: number[][], i: number): number {
  let s = 0, n = 0;
  for (let c = 0; c < NCH; c++) {
    const v = grid[c][i];
    if (Number.isFinite(v)) { s += v; n++; }
  }
  return n ? s / n : 0;
}

function Trajectory({ bandsBuf, tick: _tick }: Props) {
  const groupRef = useRef<THREE.Group>(null);

  const data = useMemo(() => {
    const buf = bandsBuf.current;
    const n = buf.ts.length;
    if (n < 2) return null;
    const points: [number, number, number][] = [];
    const colors: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = meanAtTime(buf.bands.alpha, i);
      const b = meanAtTime(buf.bands.beta, i);
      const t = meanAtTime(buf.bands.theta, i);
      if (a + b === 0) continue;
      const focus = b / (a + t + EPS);                  // 0..~2
      const relax = a / (a + b + EPS);                  // 0..1
      const xNorm = Math.max(0, Math.min(1, focus / FOCUS_MAX));
      const zNorm = Math.max(0, Math.min(1, relax));
      const yNorm = i / Math.max(1, n - 1);             // 0..1 oldest→newest
      // Center the cube at origin (-0.5..+0.5 on each axis)
      points.push([xNorm - 0.5, yNorm - 0.5, zNorm - 0.5]);
      // Color gradient: orange (focus) ↔ blue (relax)
      // R goes with focus, B goes with relax, G stays mid for visibility.
      colors.push([
        0.4 + 0.55 * xNorm,
        0.4 + 0.3 * yNorm,    // age tint
        0.4 + 0.55 * zNorm,
      ]);
    }
    return points.length >= 2 ? { points, colors } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_tick]);

  useFrame((_state, dt) => {
    if (groupRef.current) groupRef.current.rotation.y += dt * 0.15;
  });

  if (!data) return null;

  const head = data.points[data.points.length - 1];
  const headColor = data.colors[data.colors.length - 1];

  return (
    <group ref={groupRef}>
      {/* Floor grid in the focus-relax plane (y = -0.5) */}
      <gridHelper args={[1, 10, "#3a3f4a", "#2a2e36"]} position={[0, -0.5, 0]} />

      {/* Axis frame edges */}
      <AxisLine from={[-0.5, -0.5, -0.5]} to={[0.5, -0.5, -0.5]} color="#7aa2f7" />
      <AxisLine from={[-0.5, -0.5, -0.5]} to={[-0.5, 0.5, -0.5]} color="#a8acb5" />
      <AxisLine from={[-0.5, -0.5, -0.5]} to={[-0.5, -0.5, 0.5]} color="#d97757" />

      {/* Axis labels */}
      <Text position={[0.55, -0.5, -0.5]} fontSize={0.07} color="#7aa2f7" anchorX="left">
        focus →
      </Text>
      <Text position={[-0.5, 0.55, -0.5]} fontSize={0.07} color="#a8acb5" anchorX="left">
        time →
      </Text>
      <Text position={[-0.5, -0.5, 0.55]} fontSize={0.07} color="#d97757" anchorX="left">
        relax →
      </Text>

      {/* Vertical "now" marker dropline so the head doesn't float
          disconnected from the floor */}
      <Line
        points={[[head[0], -0.5, head[2]], head]}
        color="#a8acb5"
        lineWidth={1}
        dashed
        dashScale={20}
      />

      {/* Trajectory — vertex-colored line */}
      <Line
        points={data.points}
        vertexColors={data.colors}
        lineWidth={2.5}
        transparent
      />

      {/* Head sphere — current state */}
      <mesh position={head}>
        <sphereGeometry args={[0.025, 16, 16]} />
        <meshBasicMaterial color={new THREE.Color(headColor[0], headColor[1], headColor[2])} />
      </mesh>
      {/* Glow halo */}
      <mesh position={head}>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshBasicMaterial
          color={new THREE.Color(headColor[0], headColor[1], headColor[2])}
          transparent
          opacity={0.18}
        />
      </mesh>
    </group>
  );
}

function AxisLine({ from, to, color }:
                   { from: [number, number, number]; to: [number, number, number]; color: string }) {
  return <Line points={[from, to]} color={color} lineWidth={1} transparent opacity={0.6} />;
}

export default function MindTrajectory3D({ bandsBuf, tick }: Props) {
  return (
    <div className="mind3d-canvas">
      <Canvas
        camera={{ position: [1.0, 0.8, 1.4], fov: 45 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <ambientLight intensity={0.85} />
        <pointLight position={[2, 2, 2]} intensity={0.6} />
        <Trajectory bandsBuf={bandsBuf} tick={tick} />
        <OrbitControls
          enablePan={false}
          enableZoom={false}
          enableDamping
          dampingFactor={0.08}
        />
      </Canvas>
    </div>
  );
}
