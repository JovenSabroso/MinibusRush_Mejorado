import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Fusiona los hijos directos (Mesh) de `group` que comparten material en
 * una sola malla por material. Un vehiculo de 12-16 piezas queda en 4-6
 * draw calls. Las mallas con varios materiales (arreglo) se dejan intactas.
 *
 * @param {THREE.Group} group
 * @param {(material: THREE.Material) => boolean} [castsShadow]
 * @returns {THREE.Group} el mismo grupo, con los hijos reemplazados
 */
export function mergeChildrenByMaterial(group, castsShadow = () => true) {
  const buckets = new Map();
  const keep = [];

  for (const child of [...group.children]) {
    if (!child.isMesh || Array.isArray(child.material)) {
      keep.push(child);
      continue;
    }
    child.updateMatrix();
    const geo = child.geometry.clone().applyMatrix4(child.matrix);
    // mergeGeometries exige los mismos atributos en todas las piezas.
    for (const name of Object.keys(geo.attributes)) {
      if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
    }
    const indexed = geo.index ? geo : geo.toNonIndexed();
    let bucket = buckets.get(child.material);
    if (!bucket) {
      bucket = { indexed: [], plain: [] };
      buckets.set(child.material, bucket);
    }
    (geo.index ? bucket.indexed : bucket.plain).push(indexed);
    group.remove(child);
  }

  for (const [material, bucket] of buckets) {
    for (const list of [bucket.indexed, bucket.plain]) {
      if (list.length === 0) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) list.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = castsShadow(material);
      group.add(mesh);
    }
  }
  for (const child of keep) group.add(child);
  return group;
}
