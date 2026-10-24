// The 3D agent: a self-made procedural character (no downloaded model), three.js only.
// States: idle (float + blink), listening (halo pulse), thinking (halo spin), speaking (mouth + eyes follow speech).
// Renders only while visible, pixel ratio capped, ~5k triangles: built for an old phone.
import * as THREE from "../../vendor/three.module.js";
import { nextFrame } from "./motion.js";

export class Agent3D {
  constructor(container) {
    this.el = container;
    this.state = "idle";
    this.level = 0; // speech envelope 0..1
    this.target = 0;
    this.visible = false;
    this.nextBlink = 2;
    this.blink = 0;

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);
    // the self-test's picture (snap.js): draw and read in one go, no preserveDrawingBuffer cost on every frame
    r.domElement.__snap = () => { r.render(this.scene, this.camera); return r.domElement.toDataURL(); };

    const scene = (this.scene = new THREE.Scene());
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    this.camera.position.set(0, 0.25, 7.2);

    scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x120a24, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2.5, 3, 4);
    scene.add(key);
    this.rim = new THREE.PointLight(0x38e1d0, 30, 12);
    this.rim.position.set(-2.6, 1.2, -1.5);
    scene.add(this.rim);
    this.rim2 = new THREE.PointLight(0x8b6cff, 26, 12);
    this.rim2.position.set(2.8, -1.4, -1);
    scene.add(this.rim2);

    // everything sits a little above the centre: the caption and the mic own the bottom of the card
    const world = (this.world = new THREE.Group());
    world.position.y = 0.75;
    scene.add(world);
    const rig = (this.rig = new THREE.Group());
    world.add(rig);

    // head: glossy shell + dark visor
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 48, 36),
      new THREE.MeshStandardMaterial({ color: 0xdfe6ff, metalness: 0.15, roughness: 0.22 }),
    );
    shell.scale.set(1, 0.94, 0.96);
    rig.add(shell);
    const visor = new THREE.Mesh(
      new THREE.SphereGeometry(1.0, 48, 32, Math.PI * 0.08, Math.PI * 0.84, Math.PI * 0.26, Math.PI * 0.5),
      new THREE.MeshStandardMaterial({ color: 0x0a0f22, metalness: 0.6, roughness: 0.18 }),
    );
    visor.position.z = 0.29;
    visor.scale.set(1.06, 0.9, 1);
    rig.add(visor);

    // eyes
    this.eyeMat = new THREE.MeshBasicMaterial({ color: 0x38e1d0 });
    const eyeGeo = new THREE.CapsuleGeometry(0.11, 0.16, 6, 12);
    this.eyes = [-0.36, 0.36].map((x) => {
      const e = new THREE.Mesh(eyeGeo, this.eyeMat);
      e.position.set(x, 0.14, 1.2);
      rig.add(e);
      return e;
    });

    // mouth: 7 bars that follow the speech envelope
    this.mouthMat = new THREE.MeshBasicMaterial({ color: 0x8b6cff });
    const barGeo = new THREE.BoxGeometry(0.06, 0.24, 0.04);
    this.bars = [...Array(7)].map((_, i) => {
      const b = new THREE.Mesh(barGeo, this.mouthMat);
      b.position.set((i - 3) * 0.1, -0.3, 1.19);
      b.scale.y = 0.15;
      rig.add(b);
      return b;
    });

    // ear pods
    for (const s of [-1, 1]) {
      const pod = new THREE.Mesh(
        new THREE.CylinderGeometry(0.22, 0.26, 0.18, 32),
        new THREE.MeshStandardMaterial({ color: 0x1a2140, metalness: 0.7, roughness: 0.3, emissive: 0x111a44 }),
      );
      pod.rotation.z = Math.PI / 2;
      pod.position.set(s * 1.2, 0.05, 0);
      rig.add(pod);
    }

    // halo ring + particles
    this.haloMat = new THREE.MeshBasicMaterial({ color: 0x38e1d0, transparent: true, opacity: 0.75 });
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.018, 8, 128), this.haloMat);
    this.halo.rotation.x = Math.PI * 0.42;
    world.add(this.halo);
    this.halo2 = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.008, 6, 128), new THREE.MeshBasicMaterial({ color: 0x8b6cff, transparent: true, opacity: 0.5 }));
    this.halo2.rotation.x = Math.PI * 0.58;
    world.add(this.halo2);

    const n = 260;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, rr = 2 + Math.random() * 1.6, y = (Math.random() - 0.5) * 3.4;
      pos.set([Math.cos(a) * rr, y, Math.sin(a) * rr], i * 3);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.particles = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xbfd4ff, size: 0.035, transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }));
    world.add(this.particles);

    this.last = performance.now();
    this.t = 0;
    this.resize();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.loop = this.loop.bind(this);
  }

  setColors(a1, a2) {
    this.eyeMat.color.set(a1);
    this.haloMat.color.set(a1);
    this.rim.color.set(a1);
    this.mouthMat.color.set(a2);
    this.rim2.color.set(a2);
    this.halo2.material.color.set(a2);
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    // fit ~4.6 units of width (halo + margin) whatever the aspect, so the head never fills a narrow card
    const halfTan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    this.camera.position.z = Math.max(7.2, 2.3 / (halfTan * this.camera.aspect));
    this.camera.updateProjectionMatrix();
  }

  setVisible(v) {
    if (v === this.visible) return;
    this.visible = v;
    if (v) {
      this.last = performance.now();
      nextFrame(this.loop);
    }
  }

  setState(s) {
    this.state = s;
  }

  // Speech envelope: called on word boundaries; between words it decays.
  pulse(v = 1) {
    this.target = Math.max(this.target, v);
  }

  loop() {
    if (!this.visible) return;
    const now = performance.now();
    // idle, the 3D draws 30 times a second (the page keeps its full frame rate on an old phone); talking, every frame
    if (this.state === "idle" && now - this.last < 30) { nextFrame(this.loop); return; }
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    const t = (this.t += dt);
    const speaking = this.state === "speaking";

    if (speaking) {
      // syllable-like flutter on top of the word pulses
      this.target = Math.max(this.target, 0.35 + 0.35 * Math.abs(Math.sin(t * 13.0) * Math.sin(t * 7.3)));
    }
    this.level += (this.target - this.level) * Math.min(1, dt * 18);
    this.target *= Math.pow(0.02, dt);

    this.rig.position.y = Math.sin(t * 1.3) * 0.08;
    this.rig.rotation.y = Math.sin(t * 0.45) * 0.28 + (speaking ? Math.sin(t * 2.1) * 0.05 : 0);
    this.rig.rotation.x = Math.sin(t * 0.7) * 0.05 - (this.state === "listening" ? 0.08 : 0);
    // head tilt: toward you while listening, the other way while thinking, a slow sway otherwise
    const tilt = this.state === "listening" ? 0.16 : this.state === "thinking" ? -0.1 : 0;
    this.tiltZ = (this.tiltZ || 0) + (tilt - (this.tiltZ || 0)) * Math.min(1, dt * 4);
    this.rig.rotation.z = this.tiltZ + Math.sin(t * 0.37) * 0.025;

    // blink
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) { this.blink = 1; this.nextBlink = 2.5 + Math.random() * 4; }
    this.blink = Math.max(0, this.blink - dt * 7);
    const open = 1 - Math.sin(Math.min(1, this.blink) * Math.PI) * 0.92;
    for (const e of this.eyes) e.scale.set(1 + this.level * 0.15, open * (1 + this.level * 0.25), 1);

    this.bars.forEach((b, i) => {
      const shape = 1 - Math.abs(i - 3) / 4;
      const wob = 0.6 + 0.4 * Math.sin(t * 20 + i * 1.7);
      b.scale.y = 0.15 + this.level * shape * wob * 1.6;
    });

    const spin = this.state === "thinking" ? 2.4 : 0.35;
    this.halo.rotation.z += dt * spin;
    this.halo2.rotation.z -= dt * spin * 0.6;
    const pulse = this.state === "listening" ? 1 + Math.sin(t * 6) * 0.06 : 1 + this.level * 0.05;
    this.halo.scale.setScalar(pulse);
    this.haloMat.opacity = 0.55 + this.level * 0.4;
    this.particles.rotation.y += dt * (0.05 + this.level * 0.3);

    this.renderer.render(this.scene, this.camera);
    nextFrame(this.loop);
  }
}
