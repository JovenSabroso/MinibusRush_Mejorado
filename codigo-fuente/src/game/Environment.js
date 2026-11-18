import * as THREE from 'three';

/**
 * Environment
 * Mapa de entorno generado por codigo (sin archivos externos): un cielo
 * degradado con un lobulo solar, convertido a PMREM. Da reflejos creibles a
 * la pintura y vidrios del minibus, a los vehiculos y al asfalto mojado, y
 * una luz ambiental mas rica que una simple luz hemisferica.
 * La intensidad se ajusta desde DayNightSystem (dia / noche / lluvia).
 */
export function createEnvironmentMap(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 zenith = vec3(0.16, 0.34, 0.68);
        vec3 horizon = vec3(0.78, 0.86, 0.95);
        vec3 ground = vec3(0.17, 0.15, 0.13);
        vec3 col = h > 0.0 ? mix(horizon, zenith, pow(h, 0.55)) : mix(horizon * 0.45, ground, smoothstep(0.0, -0.5, h));
        // Lobulo solar (hacia +X/+Y, como la luz principal) y calidez en el horizonte.
        vec3 sunDir = normalize(vec3(0.55, 0.62, 0.38));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        col += vec3(1.0, 0.86, 0.62) * (pow(s, 24.0) * 1.6 + pow(s, 6.0) * 0.35);
        // Parches claros tipo fachadas altas para que los costados metalicos reflejen algo.
        float band = smoothstep(0.02, 0.12, h) * (1.0 - smoothstep(0.12, 0.3, h));
        col += vec3(0.25, 0.22, 0.2) * band * (0.5 + 0.5 * sin(atan(vDir.z, vDir.x) * 7.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), mat);
  envScene.add(dome);

  const target = pmrem.fromScene(envScene, 0.035);
  dome.geometry.dispose();
  mat.dispose();
  pmrem.dispose();
  return target.texture;
}
