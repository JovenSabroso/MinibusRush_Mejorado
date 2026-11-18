# Prompt: mejora "Ciudad de El Alto mapeada" para Minibús Rush

Copia y pega el bloque de abajo en Claude Code (o en tu asistente) dentro de la carpeta `codigo-fuente`.

---

```text
Contexto: este proyecto es "Minibús Rush: Rutas Urbanas", un juego 3D de conducción de minibús hecho con Three.js + Vite (carpeta codigo-fuente, Node 18+). Hoy la ciudad se genera como una GRILLA regular de manzanas en src/game/City.js (≈990 líneas), con utilidades en src/game/streetGrid.js (internalStreetLines), tráfico NPC en TrafficSystem.js, semáforos en TrafficLightSystem.js, rutas en RouteSystem.js, paradas en BusStop.js, aleatoriedad con semilla en rng.js y un StaticBatcher en City.js para reducir draw calls. Lee estos archivos antes de tocar nada.

Objetivo: reemplazar la grilla genérica por un mapa REAL de una zona de la ciudad de El Alto (Bolivia), con:
1) Calles reales tomadas de OpenStreetMap.
2) Casas comunes generadas proceduralmente con una fórmula matemática (con semilla).
3) Edificios característicos (hitos) modelados aparte, más grandes, detallados y resaltantes: Unifranz, Aeropuerto Internacional de El Alto, Cristo de la Ceja, Teleférico, Mercado 16 de Julio, cholets de Freddy Mamani (elige los que quepan en la zona).

Fase 1 - Datos de calles (herramienta offline)
- Crea tools/osm-to-json.mjs que consulte la Overpass API (highway=*) para un bounding box configurable y escriba src/data/el-alto.json con: segmentos de calle (polilíneas en metros, origen local en el centro de la zona), tipo de vía (principal/secundaria/residencial) y ancho estimado.
- Proyecta lat/lon a metros locales (equirectangular alrededor del centro es suficiente).
- Zona inicial pequeña (≈1.5 x 1.5 km) alrededor de Unifranz / Ceja, bbox configurable por argumentos. NO uses toda la ciudad: debe correr a 60 FPS en navegador.
- Simplifica geometría (Douglas-Peucker) y deja el JSON liviano (< 1 MB).
- El juego no debe depender de internet en tiempo de ejecución: el JSON se commitea.

Fase 2 - Red vial y manzanas
- Nuevo módulo src/game/RoadNetwork.js que cargue el JSON, construya el grafo de calles y calcule las manzanas como polígonos delimitados por las calles (face detection del grafo planar, o inset de los polígonos). Si es demasiado complejo, usa una alternativa documentada.
- Dibuja el asfalto, aceras y marcas viales con las mismas texturas/estilo actuales.
- Mantén la interfaz que usan los otros sistemas. TrafficSystem, TrafficLightSystem y RouteSystem hoy dependen de internalStreetLines: refactorízalos para recibir nodos/aristas del grafo (intersecciones = semáforos, aristas = carriles de tráfico).

Fase 3 - Casas comunes por fórmula (procedural)
- Nuevo módulo src/game/HouseGenerator.js. Por cada manzana: divide el perímetro en lotes (ancho 6-12 m, frente a la calle) y genera una casa por lote.
- Parámetros calculados con rng.js (misma semilla = misma ciudad): ancho, fondo, número de pisos (1-4), tipo de techo (losa plana con tanque de agua / calamina), color de fachada (ladrillo visto, enlucido, colores vivos), ventanas por piso, y fierros/varillas sobre el techo (típico de El Alto: construcción inconclusa).
- La altura depende de la distancia al centro/avenida principal: más pisos cerca de la Ceja y avenidas, casas bajas en la periferia. Documenta la fórmula en un comentario.
- Rendimiento: usa THREE.InstancedMesh por tipo/material o el StaticBatcher existente. Meta: miles de casas con pocos draw calls. Añade culling por chunks y LOD simple (caja plana a distancia).

Fase 4 - Hitos / edificios característicos
- Nuevo archivo de datos src/data/landmarks.js: [{ id, nombre, pos:[x,z], rot, modelo }] (coordenadas obtenidas de OSM/lat-lon y proyectadas con la misma función de la Fase 1).
- Nuevo módulo src/game/Landmarks.js que construya cada hito con geometría propia en código (como el minibús) o cargando un .glb de src/assets/.
- Cada hito debe destacar: modelo más grande y detallado, letrero 3D con el nombre, marcador luminoso o haz de luz visible desde lejos, icono en el minimapa y posibilidad de ser parada/destino de misión en RouteSystem.
- Las casas procedurales NO deben generarse encima de un hito: reserva su huella (footprint) y excluye esos lotes.
- Aeropuerto: pista y terminal en el área abierta; si queda fuera de la zona inicial, deja el hito como destino lejano o en una segunda zona.

Fase 5 - Integración y pulido
- Ajusta config.js, la cámara, el límite del mapa y la colisión (CollisionSystem.js) con la nueva geometría (casas como cajas de colisión por chunk).
- Rutas de minibús con nombre y color que pasen por los hitos, paradas sobre las calles reales.
- Mantén funcionando: guardado, clima, ciclo día/noche, bloqueos de calle, policía y controles táctiles.
- Actualiza README.md y LEEME.txt (cómo regenerar el JSON, cómo cambiar la zona, cómo agregar un hito).
- Regenera Jugar.html con: npm run build:single

Reglas de trabajo
- Trabaja por fases y haz un commit por fase. Tras cada fase corre npm run dev y verifica en el navegador que no hay errores de consola y que se mantienen 60 FPS (Ajustes > Mostrar FPS).
- No rompas la compatibilidad: el juego debe seguir arrancando con npm run dev y npm run build.
- Comenta el código en español y deja las constantes (tamaños de lote, semilla, bbox) en config.js.
- Si una fase resulta demasiado grande, propón una versión simplificada y explícala antes de continuar.
- No subas node_modules ni dist.

Entrega esperada: el juego con calles reales de la zona elegida de El Alto, miles de casas procedurales variadas y al menos 2 hitos (Unifranz y el Aeropuerto o el Cristo de la Ceja) claramente destacados.
```

---

## Notas rápidas para quien lo ejecute
- Empezar por la **Fase 1** con una zona pequeña; ampliar solo si los FPS lo permiten.
- La parte más delicada es la **Fase 2** (tráfico y semáforos dependen de `internalStreetLines`).
- Las coordenadas de los hitos se pueden sacar de OpenStreetMap o Google Maps (clic derecho > copiar coordenadas).
