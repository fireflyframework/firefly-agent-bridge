/* Copyright 2026 Firefly Software Foundation. SPDX-License-Identifier: Apache-2.0
 * https://www.apache.org/licenses/LICENSE-2.0 */
import * as THREE from "three";
import { mountScene } from "./lifecycle.mjs";

function disposeObjects(scene) {
  const geometry = new Set(),
    materials = new Set(),
    textures = new Set();
  scene.traverse((object) => {
    if (!object.isMesh) return;
    geometry.add(object.geometry);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value?.isTexture) textures.add(value);
    }
  });
  textures.forEach((item) => item.dispose());
  materials.forEach((item) => item.dispose());
  geometry.forEach((item) => item.dispose());
}
function setup(viewport, margin = 1.04) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  if (!context) throw new Error("WebGL unavailable");
  const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0, 0);
  const scene = new THREE.Scene();
  const world = new THREE.Group();
  scene.add(world);
  const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 150);
  const hemi = new THREE.HemisphereLight(0xf3f1eb, 0x34372e, 2.3);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff1db, 3.3);
  key.position.set(-8, 18, 10);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xe3e9df, 1.35);
  fill.position.set(10, 9, -9);
  scene.add(fill);
  viewport.append(canvas);
  function resize(width, height) {
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    const bounds = new THREE.Box3().setFromObject(world),
      center = bounds.getCenter(new THREE.Vector3());
    camera.position.copy(center).add(new THREE.Vector3(10, 14, 27));
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    const corners = [];
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z])
          corners.push(
            new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse),
          );
    const horizontal =
      Math.max(...corners.map((p) => p.x)) -
      Math.min(...corners.map((p) => p.x));
    const vertical =
      Math.max(...corners.map((p) => p.y)) -
      Math.min(...corners.map((p) => p.y));
    const span = Math.max(vertical, horizontal / (width / height)) * margin;
    camera.left = (-span * width) / height / 2;
    camera.right = -camera.left;
    camera.top = span / 2;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
  }
  return {
    canvas,
    renderer,
    scene,
    world,
    hemi,
    key,
    camera,
    resize,
    dispose() {
      disposeObjects(scene);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
function mesh(parent, geometry, material, x, y, z = 0) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(x, y, z);
  parent.add(object);
  return object;
}
async function build(viewport) {
  const view = setup(viewport);
  const shell = new THREE.MeshStandardMaterial({
    color: 0xc5c5b6,
    roughness: 0.75,
    metalness: 0.12,
  });
  const graphite = new THREE.MeshStandardMaterial({
    color: 0x474a42,
    roughness: 0.85,
  });
  const amber = new THREE.MeshStandardMaterial({
    color: 0xffb34a,
    roughness: 0.4,
    metalness: 0.15,
  });
  const warm = new THREE.MeshStandardMaterial({
    color: 0xf3f1eb,
    roughness: 0.7,
  });
  // First-party span silhouette from the Bridge mark, extruded as architecture.
  const shape = new THREE.Shape();
  const point = (x, y) => [(x - 74) * 0.028, -y * 0.028];
  shape.moveTo(...point(12, -88));
  shape.lineTo(...point(136, -88));
  shape.lineTo(...point(136, 0));
  shape.lineTo(...point(110, 0));
  shape.lineTo(...point(110, -44));
  shape.bezierCurveTo(...point(110, -82), ...point(38, -82), ...point(38, -44));
  shape.lineTo(...point(38, 0));
  shape.lineTo(...point(12, 0));
  shape.closePath();
  mesh(
    view.world,
    new THREE.ExtrudeGeometry(shape, {
      depth: 0.65,
      bevelEnabled: true,
      bevelSegments: 4,
      steps: 1,
      bevelSize: 0.035,
      bevelThickness: 0.035,
    }),
    shell,
    0,
    0.336,
    -0.325,
  );
  // One continuous deck supported by the logo arch and landing pad columns.
  mesh(view.world, new THREE.BoxGeometry(9.4, 0.28, 1.1), graphite, 0, 2.94);
  const top = mesh(
    view.world,
    new THREE.BoxGeometry(9.4, 0.045, 1.1),
    warm,
    0,
    3.102,
  );
  for (const z of [-0.52, 0.52]) {
    mesh(
      view.world,
      new THREE.BoxGeometry(9.4, 0.055, 0.045),
      amber,
      0,
      3.24,
      z,
    );
    for (let i = 0; i < 19; i++)
      mesh(
        view.world,
        new THREE.BoxGeometry(0.028, 0.22, 0.028),
        graphite,
        -4.5 + i * 0.5,
        3.16,
        z,
      );
  }
  for (const x of [-3.65, 3.65]) {
    mesh(view.world, new THREE.BoxGeometry(2.1, 0.28, 1.8), graphite, x, 2.94);
    mesh(view.world, new THREE.BoxGeometry(2.1, 0.045, 1.8), warm, x, 3.102);
    for (const dx of [-0.72, 0.72])
      for (const z of [-0.62, 0.62])
        mesh(
          view.world,
          new THREE.BoxGeometry(0.18, 2.8, 0.18),
          graphite,
          x + dx,
          1.4,
          z,
        );
    // Generic application and subscription-chat windows; no provider marks.
    const node = new THREE.Group();
    view.world.add(node);
    node.position.set(x, 3.125, -0.54);
    mesh(node, new THREE.BoxGeometry(1.6, 0.12, 0.3), graphite, 0, 0.06);
    mesh(node, new THREE.BoxGeometry(1.45, 1.05, 0.14), shell, 0, 0.64);
    mesh(node, new THREE.BoxGeometry(1.28, 0.82, 0.025), warm, 0, 0.6, 0.09);
    mesh(
      node,
      new THREE.BoxGeometry(1.28, 0.14, 0.035),
      graphite,
      0,
      1.04,
      0.105,
    );
    if (x < 0) {
      for (let i = 0; i < 3; i++)
        mesh(
          node,
          new THREE.SphereGeometry(0.028, 12, 8),
          amber,
          -0.49 + i * 0.11,
          1.04,
          0.145,
        );
      mesh(
        node,
        new THREE.BoxGeometry(0.22, 0.65, 0.025),
        shell,
        -0.47,
        0.6,
        0.12,
      );
      for (let i = 0; i < 3; i++)
        mesh(
          node,
          new THREE.BoxGeometry(0.66 - i * 0.08, 0.035, 0.025),
          graphite,
          0.12,
          0.81 - i * 0.16,
          0.12,
        );
      mesh(
        node,
        new THREE.BoxGeometry(0.34, 0.12, 0.028),
        amber,
        0.24,
        0.36,
        0.13,
      );
    } else {
      for (let i = 0; i < 2; i++) {
        const bubble = new THREE.Shape();
        bubble.moveTo(-0.42, -0.11);
        bubble.lineTo(-0.42, 0.11);
        bubble.quadraticCurveTo(-0.42, 0.17, -0.36, 0.17);
        bubble.lineTo(0.36, 0.17);
        bubble.quadraticCurveTo(0.42, 0.17, 0.42, 0.11);
        bubble.lineTo(0.42, -0.11);
        bubble.quadraticCurveTo(0.42, -0.17, 0.36, -0.17);
        bubble.lineTo(-0.2, -0.17);
        bubble.lineTo(-0.32, -0.28);
        bubble.lineTo(-0.32, -0.17);
        bubble.lineTo(-0.36, -0.17);
        bubble.quadraticCurveTo(-0.42, -0.17, -0.42, -0.11);
        mesh(
          node,
          new THREE.ExtrudeGeometry(bubble, {
            depth: 0.025,
            bevelEnabled: false,
          }),
          i === 0 ? amber : shell,
          i === 0 ? -0.1 : 0.1,
          0.79 - i * 0.37,
          0.12,
        );
        for (let line = 0; line < 2; line++)
          mesh(
            node,
            new THREE.BoxGeometry(0.56 - line * 0.12, 0.022, 0.018),
            graphite,
            i === 0 ? -0.1 : 0.1,
            0.82 - i * 0.37 - line * 0.07,
            0.16,
          );
      }
      const badge = mesh(
        node,
        new THREE.CylinderGeometry(0.12, 0.12, 0.025, 24),
        amber,
        0.56,
        1.15,
        0.13,
      );
      badge.rotation.x = Math.PI / 2;
    }
  }
  for (const z of [-0.2, 0.2])
    mesh(
      view.world,
      new THREE.BoxGeometry(9.25, 0.012, 0.024),
      amber,
      0,
      3.134,
      z,
    );
  const packets = [];
  for (const direction of [-1, 1])
    for (let i = 0; i < 3; i++) {
      const packet = new THREE.Group();
      view.world.add(packet);
      packet.position.set(0, 3.17, direction * 0.24);
      mesh(packet, new THREE.BoxGeometry(0.44, 0.025, 0.34), amber, 0, 0);
      mesh(packet, new THREE.BoxGeometry(0.39, 0.028, 0.29), warm, 0, 0.027);
      for (let line = 0; line < 3; line++)
        mesh(
          packet,
          new THREE.BoxGeometry(0.26 - line * 0.04, 0.01, 0.015),
          graphite,
          -0.015,
          0.047,
          -0.075 + line * 0.065,
        );
      packets.push({ packet, direction, phase: i / 3 });
    }
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0xe5e3db,
    roughness: 1,
    transparent: true,
    opacity: 0.3,
  });
  const floor = mesh(
    view.scene,
    new THREE.PlaneGeometry(13, 5),
    floorMaterial,
    0,
    -0.03,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  view.renderer.shadowMap.enabled = true;
  view.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  view.key.castShadow = true;
  view.key.shadow.mapSize.set(1024, 1024);
  Object.assign(view.key.shadow.camera, {
    left: -8,
    right: 8,
    top: 6,
    bottom: -6,
    near: 1,
    far: 45,
  });
  view.key.shadow.bias = -0.0003;
  view.key.shadow.normalBias = 0.03;
  view.world.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  let lastTheme;
  return {
    ...view,
    render(time, dark) {
      for (const { packet, direction, phase } of packets) {
        const progress = (time / 7 + phase) % 1;
        packet.position.x = direction * (progress * 8.7 - 4.35);
        packet.scale.setScalar(
          Math.max(0, Math.min(1, progress / 0.06, (1 - progress) / 0.06)),
        );
      }
      if (dark !== lastTheme) {
        lastTheme = dark;
        shell.color.set(dark ? 0xc5c5b6 : 0xb6b8a8);
        graphite.color.set(dark ? 0x474a42 : 0x62645b);
        top.material.color.set(dark ? 0xbfb8ab : 0xf3f1eb);
        floorMaterial.color.set(dark ? 0x272820 : 0xe5e3db);
        view.hemi.intensity = dark ? 1.8 : 2.4;
        view.renderer.toneMappingExposure = dark ? 1.15 : 1.02;
      }
      view.renderer.render(view.scene, view.camera);
    },
  };
}

for (const host of document.querySelectorAll("[data-docs-scene]"))
  mountScene(host, build);
