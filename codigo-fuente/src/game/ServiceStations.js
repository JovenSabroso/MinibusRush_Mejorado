import * as THREE from 'three';
import { createBillboardTexture } from './cityTextures.js';

/**
 * GasStation
 * Estructura procedural sencilla: canopy sobre columnas + dos surtidores.
 * Colores tipicos de gasolinera (rojo/blanco) para que se reconozca a la
 * distancia. El cuerpo del canopy se usa como obstaculo de colision.
 */
export class GasStation {
  constructor(position) {
    this.position = position.clone();
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.name = 'GasStation';

    this._build();
  }

  _build() {
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xd9d9d4, roughness: 0.5, metalness: 0.2 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xe8452c, roughness: 0.5 });
    const pumpMat = new THREE.MeshStandardMaterial({ color: 0xf2f0eb, roughness: 0.4 });
    const pumpTopMat = new THREE.MeshStandardMaterial({ color: 0x2b6fb3, roughness: 0.4 });

    const canopy = new THREE.Mesh(new THREE.BoxGeometry(9, 0.4, 6), canopyMat);
    canopy.position.y = 4.4;
    canopy.castShadow = true;
    this.group.add(canopy);
    this.solidMesh = canopy; // referencia para registrar colision (altura suficiente para no chocar con el bus por abajo... se registra igual como precaucion)

    // Panel de luz bajo el techo: de noche la gasolinera se ve desde lejos.
    this._lightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.3 });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.05, 5.4), this._lightMat);
    panel.position.y = 4.18;
    this.group.add(panel);

    const pillarPositions = [
      [-3.8, -2.4],
      [3.8, -2.4],
      [-3.8, 2.4],
      [3.8, 2.4],
    ];
    for (const [x, z] of pillarPositions) {
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 4.4, 8), pillarMat);
      pillar.position.set(x, 2.2, z);
      this.group.add(pillar);
    }

    for (const side of [-1, 1]) {
      const pumpBase = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.3, 0.5), pumpMat);
      pumpBase.position.set(side * 1.3, 0.65, 0);
      this.group.add(pumpBase);

      const pumpTop = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.35, 0.55), pumpTopMat);
      pumpTop.position.set(side * 1.3, 1.45, 0);
      this.group.add(pumpTop);
    }

    // Letrero vertical con texto (brilla de noche).
    const signPole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5.5, 8), pillarMat);
    signPole.position.set(-5.4, 2.75, -3.2);
    this.group.add(signPole);
    const signTex = createBillboardTexture('GASOLINA', 'Especial · Diésel · GNV', '#e8452c', '#ffffff');
    this._signMat = new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 0.1 });
    const signBoard = new THREE.Mesh(new THREE.BoxGeometry(3.3, 1.3, 0.12), [pillarMat, pillarMat, pillarMat, pillarMat, this._signMat, this._signMat]);
    signBoard.position.set(-5.4, 5.8, -3.2);
    this.group.add(signBoard);
  }

  setNight(factor) {
    this._signMat.emissiveIntensity = 0.1 + factor * 0.9;
    this._lightMat.emissiveIntensity = 0.3 + factor * 2.5;
  }
}

/**
 * Garage (taller mecanico)
 * Nave sencilla con un "porton" oscuro simulando la entrada, mas un
 * letrero. Sirve de punto de reparacion del minibus.
 */
export class Garage {
  constructor(position) {
    this.position = position.clone();
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.group.name = 'Garage';

    this._build();
  }

  _build() {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x5c6470, roughness: 0.85 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.9 });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.6 });
    
    const building = new THREE.Mesh(new THREE.BoxGeometry(8, 5, 7), wallMat);
    building.position.set(0, 2.5, 0);
    this.group.add(building);
    this.solidMesh = building;

    const roof = new THREE.Mesh(new THREE.BoxGeometry(8.3, 0.4, 7.3), roofMat);
    roof.position.set(0, 5.2, 0);
    this.group.add(roof);

    // Porton abierto (hueco oscuro) en la fachada que mira hacia la calle (-Z).
    const door = new THREE.Mesh(new THREE.BoxGeometry(4.2, 3.4, 0.15), doorMat);
    door.position.set(0, 1.9, -3.53);
    this.group.add(door);

    const signTex = createBillboardTexture('TALLER', 'Mecánica general · Chapería', '#f5b400', '#14161a');
    this._signMat = new THREE.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: 0xffffff, emissiveIntensity: 0.1 });
    const signBoard = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.35), this._signMat);
    signBoard.position.set(0, 4.45, -3.61);
    signBoard.rotation.y = Math.PI;
    this.group.add(signBoard);

    // Lampara sobre el porton.
    this._lightMat = new THREE.MeshStandardMaterial({ color: 0xfff2c9, emissive: 0xffd27a, emissiveIntensity: 0.2 });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.3), this._lightMat);
    lamp.position.set(0, 3.75, -3.75);
    this.group.add(lamp);
  }

  setNight(factor) {
    this._signMat.emissiveIntensity = 0.1 + factor * 0.9;
    this._lightMat.emissiveIntensity = 0.2 + factor * 3;
  }
}
