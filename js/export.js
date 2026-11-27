// Geração de GeoJSON e KML a partir dos pontos (funções puras).

export function formatLatLng(lat, lng) {
  return `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
}

export function toGeoJSON(points) {
  return {
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(p.lng), Number(p.lat)] },
      properties: {
        id: p.id,
        name: p.name,
        accuracy_m: p.accuracy_m ?? null,
        captured_at: p.captured_at ?? null,
        team: p.team_label ?? null,
        operator: p.operator || null,
        farm: p.farm ?? null,
      },
    })),
  };
}

const xml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export function toKML(points, docName = 'Pivot Scout') {
  const placemarks = points
    .map((p) => {
      const desc = [
        `Ponta externa do pivot`,
        `Coordenada: ${formatLatLng(p.lat, p.lng)}`,
        p.accuracy_m != null ? `Precisão: ±${p.accuracy_m} m` : null,
        p.captured_at ? `Capturado: ${p.captured_at}` : null,
        p.farm ? `Fazenda: ${p.farm}` : null,
        p.team_label ? `Equipe: ${p.team_label}` : null,
        p.operator ? `Operador: ${p.operator}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      return [
        '    <Placemark>',
        `      <name>${xml(p.name)}</name>`,
        `      <description>${xml(desc)}</description>`,
        `      <Point><coordinates>${Number(p.lng).toFixed(7)},${Number(p.lat).toFixed(7)},0</coordinates></Point>`,
        '    </Placemark>',
      ].join('\n');
    })
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${xml(docName)}</name>`,
    placemarks,
    '  </Document>',
    '</kml>',
    '',
  ].join('\n');
}
