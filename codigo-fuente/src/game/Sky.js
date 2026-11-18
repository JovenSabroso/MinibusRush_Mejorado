import * as THREE from 'three';
import { mulberry32 } from './rng.js';

/**
 * Sky
 * Domo con shader de gradiente (cenit / horizonte / suelo) + disco solar
 * con halo + luna + campo de estrellas. Sigue a la camara para que nunca
 * se vea su borde. Los colores los fija DayNightSystem segun la hora.
 */
export class Sky {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'Sky';

    this.uniforms = {
      uTop: { value: new THREE.Color(0x2f6fc0) },
      uHorizon: { value: new THREE.Color(0xb8d6ee) },
      uBottom: { value: new THREE.Color(0x5c5046) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(0xfff2d9) },
      uSunSize: { value: 1 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uNight: { value: 0 },
      uStorm: { value: 0 },
      uFlash: { value: 0 },
    };

    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(1200, 32, 16),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position = p.xyww; // siempre en el plano lejano
          }
        `,
        fragmentShader: /* glsl */ `
          uniform vec3 uTop;
          uniform vec3 uHorizon;
          uniform vec3 uBottom;
          uniform vec3 uSunDir;
          uniform vec3 uSunColor;
          uniform float uSunSize;
          uniform vec3 uMoonDir;
          uniform float uNight;
          uniform float uStorm;
          uniform float uFlash;
          varying vec3 vDir;

          void main() {
            vec3 dir = normalize(vDir);
            float h = dir.y;

            // Gradiente: el horizonte se "ensancha" con una curva suave.
            vec3 col = h > 0.0
              ? mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.55))
              : mix(uHorizon, uBottom, pow(clamp(-h, 0.0, 1.0), 0.35));

            // Sol: disco + halo amplio, mas calido cerca del horizonte.
            float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
            float disc = smoothstep(0.9993 - 0.0004 * uSunSize, 0.9997, sunDot);
            float halo = pow(sunDot, 64.0) * 0.55 + pow(sunDot, 6.0) * 0.18;
            float sunVisible = smoothstep(-0.08, 0.04, uSunDir.y) * (1.0 - uStorm * 0.85);
            col += uSunColor * (disc * 3.0 + halo) * sunVisible;

            // Luna: disco frio con un borde suave.
            float moonDot = max(dot(dir, normalize(uMoonDir)), 0.0);
            float moon = smoothstep(0.99955, 0.9998, moonDot);
            float moonGlow = pow(moonDot, 300.0) * 0.35;
            col += vec3(0.85, 0.9, 1.0) * (moon * 1.4 + moonGlow) * uNight * (1.0 - uStorm);

            // Tormenta: nubes grises que lo aplanan todo + destello del relampago.
            vec3 stormCol = mix(vec3(0.22, 0.24, 0.28), vec3(0.05, 0.06, 0.08), uNight);
            col = mix(col, stormCol + vec3(0.03) * h, uStorm * 0.75);
            col += vec3(0.75, 0.8, 1.0) * uFlash * smoothstep(-0.1, 0.4, h);

            gl_FragColor = vec4(col, 1.0);
          }
        `,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
    );
    dome.renderOrder = -10;
    dome.frustumCulled = false;
    this.group.add(dome);

    // Estrellas: puntos fijos en el hemisferio superior.
    const rng = mulberry32(31);
    const count = 1400;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u = rng();
      const v = rng() * 0.92 + 0.08;
      const theta = u * Math.PI * 2;
      const phi = Math.acos(v);
      const r = 1100;
      positions[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
      positions[i * 3 + 1] = Math.cos(phi) * r;
      positions[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
      sizes[i] = 0.6 + Math.pow(rng(), 6) * 2.6;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uTime: { value: 0 }, uPixelRatio: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize;
        uniform float uTime;
        uniform float uPixelRatio;
        varying float vTwinkle;
        void main() {
          vTwinkle = 0.65 + 0.35 * sin(uTime * 2.0 + position.x * 0.13 + position.z * 0.07);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
          gl_PointSize = aSize * uPixelRatio * 1.6;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        varying float vTwinkle;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vec3(0.92, 0.95, 1.0), a * uOpacity * vTwinkle);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const stars = new THREE.Points(starGeo, this.starMat);
    stars.renderOrder = -9;
    stars.frustumCulled = false;
    this.group.add(stars);

    scene.add(this.group);
  }

  /** Mantiene el domo centrado en la camara. */
  follow(camera, time, pixelRatio) {
    this.group.position.copy(camera.position);
    this.starMat.uniforms.uTime.value = time;
    this.starMat.uniforms.uPixelRatio.value = pixelRatio;
  }
}
