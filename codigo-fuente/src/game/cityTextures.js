import * as THREE from 'three';

/**
 * cityTextures
 * Texturas de la ciudad generadas con Canvas2D en tiempo de ejecucion
 * (fachadas, ladrillo crudo, asfalto, baldosas, cholets, letreros). Igual
 * que las del minibus: nada de imagenes externas.
 */

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d') };
}

function makeRepeatTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Motas sobre todo el canvas (polvo, porosidad). */
function speckle(ctx, width, height, count, colors, maxSize = 2) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = colors[Math.floor(Math.random() * colors.length)];
    const s = 0.5 + Math.random() * maxSize;
    ctx.fillRect(Math.random() * width, Math.random() * height, s, s);
  }
}

/**
 * Fachada pintada: tile de 4 vanos x 4 pisos (12m x 12m). La pared es
 * casi blanca para que el color del material la tina. Devuelve `map` y un
 * `emissiveMap` con ventanas encendidas al azar (luz calida, alguna TV fria)
 * que se activa de noche subiendo emissiveIntensity.
 */
export function createFacadeTextures() {
  const size = 512;
  const bays = 4;
  const floors = 4;
  const { canvas, ctx } = makeCanvas(size, size);
  const { canvas: eCanvas, ctx: ectx } = makeCanvas(size, size);

  ctx.fillStyle = '#ece8e1';
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, size, 2400, ['rgba(0,0,0,0.05)', 'rgba(255,255,255,0.25)', 'rgba(90,70,50,0.06)']);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, size, size);

  const cellW = size / bays;
  const cellH = size / floors;
  for (let f = 0; f < floors; f++) {
    // Losa entre pisos: franja levemente mas oscura.
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, f * cellH, size, 6);

    for (let b = 0; b < bays; b++) {
      const x = b * cellW + cellW * 0.2;
      const y = f * cellH + cellH * 0.25;
      const w = cellW * 0.6;
      const h = cellH * 0.5;

      // Marco + vidrio oscuro con reflejo diagonal.
      ctx.fillStyle = '#d9d4cc';
      ctx.fillRect(x - 5, y - 5, w + 10, h + 12);
      ctx.fillStyle = '#26303a';
      ctx.fillRect(x, y, w, h);
      const grad = ctx.createLinearGradient(x, y, x + w, y + h);
      grad.addColorStop(0, 'rgba(160,190,215,0.35)');
      grad.addColorStop(0.5, 'rgba(160,190,215,0.0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#3d454d';
      ctx.fillRect(x + w / 2 - 2, y, 4, h);

      // Cortinas de colores en algunas ventanas.
      if (Math.random() < 0.35) {
        ctx.fillStyle = ['#a33b3b', '#c9a227', '#3f6e9c', '#6b8f4e'][Math.floor(Math.random() * 4)];
        ctx.globalAlpha = 0.55;
        ctx.fillRect(x, y, w * 0.35, h);
        ctx.globalAlpha = 1;
      }

      if (Math.random() < 0.45) {
        const warm = Math.random() < 0.85;
        ectx.fillStyle = warm ? (Math.random() < 0.5 ? '#ffcf7a' : '#ffe2a8') : '#9fc3ff';
        ectx.fillRect(x, y, w, h);
        ectx.fillStyle = 'rgba(0,0,0,0.35)';
        ectx.fillRect(x + w / 2 - 2, y, 4, h);
      }
    }
  }

  // Manchas de humedad que bajan por la pared.
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * size;
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, 'rgba(70,60,50,0.0)');
    grad.addColorStop(1, 'rgba(70,60,50,0.12)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, 6 + Math.random() * 14, size);
  }

  return { map: makeRepeatTexture(canvas), emissiveMap: makeRepeatTexture(eCanvas) };
}

/**
 * Ladrillo / bloque crudo de los pisos "a medio construir" de El Alto,
 * con huecos de ventana sin marco. tile = 12m x 12m.
 */
export function createRawBrickTexture(kind = 'ladrillo') {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size, size);
  const isBrick = kind === 'ladrillo';
  const base = isBrick ? [150, 78, 52] : [146, 142, 136];

  ctx.fillStyle = isBrick ? '#6e3a28' : '#6d6a65';
  ctx.fillRect(0, 0, size, size);

  const rowH = isBrick ? 10 : 18;
  const brickW = isBrick ? 26 : 40;
  for (let row = 0; row * rowH < size; row++) {
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let x = -offset; x < size; x += brickW) {
      const shade = (Math.random() - 0.5) * 30;
      ctx.fillStyle = `rgb(${base[0] + shade}, ${base[1] + shade * 0.6}, ${base[2] + shade * 0.5})`;
      ctx.fillRect(x + 1, row * rowH + 1, brickW - 2, rowH - 2);
    }
  }

  // Mortero chorreado y polvo.
  speckle(ctx, size, size, 1500, ['rgba(200,190,170,0.25)', 'rgba(40,25,20,0.2)'], 2.5);

  // Huecos de ventana (sin vidrio): 4x4 vanos.
  const cell = size / 4;
  for (let f = 0; f < 4; f++) {
    for (let b = 0; b < 4; b++) {
      if (Math.random() < 0.15) continue; // algun vano tapiado
      const x = b * cell + cell * 0.22;
      const y = f * cell + cell * 0.28;
      ctx.fillStyle = '#1a1310';
      ctx.fillRect(x, y, cell * 0.56, cell * 0.46);
      ctx.fillStyle = 'rgba(160,150,140,0.6)';
      ctx.fillRect(x - 4, y - 6, cell * 0.56 + 8, 6); // dintel de concreto
    }
  }

  return makeRepeatTexture(canvas);
}

/** Asfalto gastado: base gris oscura, granulado, parches y grietas. tile = 16m. */
export function createAsphaltTexture() {
  const size = 512;
  const { canvas, ctx } = makeCanvas(size, size);
  ctx.fillStyle = '#34353a';
  ctx.fillRect(0, 0, size, size);
  speckle(ctx, size, size, 9000, ['#2b2c30', '#3e3f44', '#46474c', '#28292c'], 1.6);

  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = Math.random() < 0.5 ? 'rgba(20,20,22,0.35)' : 'rgba(80,80,84,0.18)';
    ctx.fillRect(Math.random() * size, Math.random() * size, 40 + Math.random() * 90, 30 + Math.random() * 70);
  }

  ctx.strokeStyle = 'rgba(15,15,16,0.55)';
  ctx.lineWidth = 1.4;
  for (let i = 0; i < 10; i++) {
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 8; s++) {
      x += (Math.random() - 0.5) * 30;
      y += (Math.random() - 0.5) * 30;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return makeRepeatTexture(canvas);
}

/** Baldosas de acera (4x4 por tile = 4m). */
export function createSidewalkTexture() {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size, size);
  ctx.fillStyle = '#8f8c86';
  ctx.fillRect(0, 0, size, size);
  const cell = size / 4;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const shade = 150 + Math.floor((Math.random() - 0.5) * 22);
      ctx.fillStyle = `rgb(${shade}, ${shade - 3}, ${shade - 8})`;
      ctx.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    }
  }
  speckle(ctx, size, size, 900, ['rgba(0,0,0,0.12)', 'rgba(255,255,255,0.12)'], 1.5);
  return makeRepeatTexture(canvas);
}

/**
 * Fachada de cholet (arquitectura neoandina de El Alto): colores
 * saturados, simetria vertical, chakana escalonada, rombos y franjas.
 * `emissiveMap` contiene solo los contornos, para el neon nocturno.
 */
export function createCholetTextures(palette) {
  const w = 512;
  const h = 512;
  const { canvas, ctx } = makeCanvas(w, h);
  const { canvas: eCanvas, ctx: ectx } = makeCanvas(w, h);
  const [c0, c1, c2, c3, c4] = palette;

  ctx.fillStyle = c0;
  ctx.fillRect(0, 0, w, h);
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, w, h);

  // Franjas horizontales de color en la base y el remate.
  const bands = [c1, c2, c3];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = bands[i];
    ctx.fillRect(0, h - 26 - i * 14, w, 10);
    ctx.fillRect(0, 16 + i * 14, w, 10);
  }

  // Triangulos dentados a lo ancho.
  ctx.fillStyle = c4;
  for (let x = 0; x < w; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 70);
    ctx.lineTo(x + 16, 96);
    ctx.lineTo(x + 32, 70);
    ctx.fill();
  }

  // Chakana (cruz andina escalonada) al centro.
  const cx = w / 2;
  const cy = h * 0.5;
  const steps = [
    [150, 50],
    [110, 90],
    [70, 130],
    [50, 150],
  ];
  ctx.fillStyle = c2;
  for (const [sw, sh] of steps) ctx.fillRect(cx - sw / 2, cy - sh / 2, sw, sh);
  ctx.strokeStyle = c4;
  ctx.lineWidth = 6;
  for (const [sw, sh] of steps) ctx.strokeRect(cx - sw / 2, cy - sh / 2, sw, sh);
  ctx.fillStyle = c3;
  ctx.beginPath();
  ctx.arc(cx, cy, 22, 0, Math.PI * 2);
  ctx.fill();

  ectx.strokeStyle = c4;
  ectx.lineWidth = 6;
  for (const [sw, sh] of steps) ectx.strokeRect(cx - sw / 2, cy - sh / 2, sw, sh);

  // Rombos simetricos a cada lado.
  const diamond = (context, dx, dy) => {
    context.beginPath();
    context.moveTo(dx, dy - 28);
    context.lineTo(dx + 18, dy);
    context.lineTo(dx, dy + 28);
    context.lineTo(dx - 18, dy);
    context.closePath();
  };
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const dx = cx + side * (130 + i * 40);
      const dy = cy + (i % 2 === 0 ? -50 : 50);
      ctx.fillStyle = i % 2 ? c1 : c3;
      diamond(ctx, dx, dy);
      ctx.fill();
      ectx.strokeStyle = palette[1 + (i % 3)];
      ectx.lineWidth = 5;
      diamond(ectx, dx, dy);
      ectx.stroke();
    }
  }

  // Ventanal espejado en franja.
  const glassGrad = ctx.createLinearGradient(0, h * 0.78, 0, h * 0.9);
  glassGrad.addColorStop(0, '#9fd3e6');
  glassGrad.addColorStop(1, '#2c5d7a');
  ctx.fillStyle = glassGrad;
  ctx.fillRect(30, h * 0.78, w - 60, h * 0.1);

  // Marco neon.
  ectx.strokeStyle = c1;
  ectx.lineWidth = 6;
  ectx.strokeRect(8, 8, w - 16, h - 16);
  ectx.fillStyle = c3;
  ectx.fillRect(30, h * 0.78, w - 60, 4);
  ectx.fillRect(30, h * 0.88, w - 60, 4);

  return { map: makeRepeatTexture(canvas), emissiveMap: makeRepeatTexture(eCanvas) };
}

/** Letrero publicitario de azotea (texto pintado; brilla de noche). */
export function createBillboardTexture(title, subtitle, bg, fg) {
  const { canvas, ctx } = makeCanvas(512, 192);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 192);
  ctx.strokeStyle = fg;
  ctx.lineWidth = 8;
  ctx.strokeRect(10, 10, 492, 172);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '64px "Bungee", "Arial Black", Impact, sans-serif';
  ctx.fillText(title, 256, 84, 470);
  ctx.font = '600 30px "Barlow Condensed", "Arial Narrow", sans-serif';
  ctx.fillText(subtitle, 256, 146, 470);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Gradiente radial blanco -> transparente (charcos de luz, humo, destellos). */
export function createRadialGlowTexture(size = 128) {
  const { canvas, ctx } = makeCanvas(size, size);
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
