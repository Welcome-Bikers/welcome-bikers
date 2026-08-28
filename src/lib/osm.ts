import L from "leaflet";

export function lightTiles() {
  const layer = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap, Carto",
    maxZoom: 20,
    subdomains: "abcd",
  });
  let fallback = 0;
  const backups = [
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    "https://tile.openstreetmap.de/{z}/{x}/{y}.png",
  ];
  layer.on("tileerror", () => {
    if (fallback >= backups.length) return;
    layer.setUrl(backups[fallback]);
    fallback += 1;
  });
  return layer;
}
