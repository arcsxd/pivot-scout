// Leitura de KML/KMZ (área da fazenda) e teste de ponto dentro de polígono.

const r7 = (n) => Math.round(n * 1e7) / 1e7;

function parseCoords(text) {
  return String(text || '')
    .trim()
    .split(/\s+/)
    .map((c) => c.split(',').map(Number))
    .filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
    .map(([lng, lat]) => [r7(lng), r7(lat)]);
}

const byName = (el, name) => [...el.getElementsByTagNameNS('*', name)];
const childText = (el, name) => [...el.children].find((c) => c.localName === name)?.textContent.trim() || '';

function ringOf(boundary) {
  const coords = byName(boundary, 'coordinates')[0];
  const ring = parseCoords(coords?.textContent);
  if (ring.length && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) ring.push(ring[0]);
  return ring;
}

function geometryOf(pm) {
  const polys = byName(pm, 'Polygon')
    .map((poly) => {
      const outer = byName(poly, 'outerBoundaryIs')[0];
      if (!outer) return null;
      const rings = [ringOf(outer), ...byName(poly, 'innerBoundaryIs').map(ringOf)].filter((r) => r.length >= 4);
      return rings.length ? rings : null;
    })
    .filter(Boolean);
  if (polys.length === 1) return { type: 'Polygon', coordinates: polys[0] };
  if (polys.length > 1) return { type: 'MultiPolygon', coordinates: polys };

  const lines = byName(pm, 'LineString').map((l) => parseCoords(byName(l, 'coordinates')[0]?.textContent)).filter((l) => l.length >= 2);
  if (lines.length === 1) return { type: 'LineString', coordinates: lines[0] };
  if (lines.length > 1) return { type: 'MultiLineString', coordinates: lines };

  const pt = byName(pm, 'Point')[0];
  const c = pt && parseCoords(byName(pt, 'coordinates')[0]?.textContent)[0];
  return c ? { type: 'Point', coordinates: c } : null;
}

/** KML (texto) -> { name, geojson }. Lança erro se não houver geometria. */
export function parseKML(text, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Arquivo KML inválido.');
  const features = byName(doc, 'Placemark')
    .map((pm) => {
      const geometry = geometryOf(pm);
      return geometry ? { type: 'Feature', properties: { name: childText(pm, 'name') }, geometry } : null;
    })
    .filter(Boolean);
  if (!features.length) throw new Error('Nenhuma área encontrada no KML.');
  const docEl = byName(doc, 'Document')[0];
  return { name: docEl ? childText(docEl, 'name') : '', geojson: { type: 'FeatureCollection', features } };
}

/** Extrai o .kml de dentro de um .kmz (zip). */
export async function kmzToKml(buffer) {
  const bytes = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Arquivo KMZ inválido.');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count && dv.getUint32(off, true) === 0x02014b50; n++) {
    const nameLen = dv.getUint16(off + 28, true);
    entries.push({
      method: dv.getUint16(off + 10, true),
      size: dv.getUint32(off + 20, true),
      local: dv.getUint32(off + 42, true),
      name: new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen)),
    });
    off += 46 + nameLen + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
  const kmls = entries.filter((e) => e.name.toLowerCase().endsWith('.kml'));
  const entry = kmls.find((e) => e.name.toLowerCase() === 'doc.kml') || kmls[0];
  if (!entry) throw new Error('Nenhum .kml dentro do KMZ.');
  const start = entry.local + 30 + dv.getUint16(entry.local + 26, true) + dv.getUint16(entry.local + 28, true);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.method === 0) return new TextDecoder().decode(data);
  if (entry.method !== 8) throw new Error('Compressão do KMZ não suportada.');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

/** Lê um File .kml ou .kmz e devolve { name, geojson }. */
export async function readFarmFile(file) {
  const buf = await file.arrayBuffer();
  const isZip = buf.byteLength > 4 && new DataView(buf).getUint32(0, true) === 0x04034b50;
  const text = isZip ? await kmzToKml(buf) : new TextDecoder().decode(buf);
  return parseKML(text);
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inPolygon = (lng, lat, rings) => inRing(lng, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lng, lat, h));

/** Retorna a feature (polígono) que contém o ponto, ou null. */
export function featureContaining(lng, lat, geojson) {
  for (const f of geojson?.features || []) {
    const g = f.geometry;
    if (g?.type === 'Polygon' && inPolygon(lng, lat, g.coordinates)) return f;
    if (g?.type === 'MultiPolygon' && g.coordinates.some((p) => inPolygon(lng, lat, p))) return f;
  }
  return null;
}

/** Nome da fazenda (e talhão, se houver) onde o ponto está. */
export function farmLabel(lat, lng, farms) {
  for (const farm of farms) {
    const f = featureContaining(lng, lat, farm.geojson);
    if (f) {
      const part = f.properties?.name;
      return part && part !== farm.name ? `${farm.name} · ${part}` : farm.name;
    }
  }
  return '';
}
