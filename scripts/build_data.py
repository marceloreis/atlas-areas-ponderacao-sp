from __future__ import annotations

import argparse
import json
import math
import sqlite3
import struct
import sys
import urllib.parse
from pathlib import Path
from typing import Any

from openpyxl import load_workbook


LAYER = "AreasDePonderacao2022_SP"
COORDINATE_DECIMALS = 5
ABSOLUTE_GROUPS = {"Tab2_1", "Tab2_3", "Tab8_1", "Tab8_2", "Tab8_3"}
JSON_CHUNK_BYTES = 512 * 1024
BASE_COLUMNS = [
    "id_0",
    "geom",
    "cd_apond",
    "nm_apond",
    "TipoAPOND",
    "AREA_KM2",
    "Qt_SetCensit",
    "CD_UF",
    "NM_UF",
    "CD_MUN",
    "NM_MUN",
]


class WkbReader:
    def __init__(self, data: memoryview):
        self.data = data
        self.offset = 0

    def read(self, size: int) -> memoryview:
        value = self.data[self.offset : self.offset + size]
        if len(value) != size:
            raise ValueError("Geometria WKB truncada")
        self.offset += size
        return value

    def uint32(self, endian: str) -> int:
        return struct.unpack(endian + "I", self.read(4))[0]

    def coordinate(self, endian: str, dimensions: int) -> list[float]:
        values = struct.unpack(endian + "d" * dimensions, self.read(8 * dimensions))
        return [values[0], values[1]]


def parse_wkb(reader: WkbReader) -> dict[str, Any]:
    byte_order = reader.read(1)[0]
    if byte_order not in (0, 1):
        raise ValueError(f"Ordem de bytes WKB inválida: {byte_order}")
    endian = "<" if byte_order == 1 else ">"
    raw_type = reader.uint32(endian)

    has_z = bool(raw_type & 0x80000000)
    has_m = bool(raw_type & 0x40000000)
    has_srid = bool(raw_type & 0x20000000)
    base_type = raw_type & 0x000000FF
    if not (raw_type & 0xE0000000):
        iso_type = raw_type
        if 1000 <= iso_type < 2000:
            has_z = True
            base_type = iso_type - 1000
        elif 2000 <= iso_type < 3000:
            has_m = True
            base_type = iso_type - 2000
        elif 3000 <= iso_type < 4000:
            has_z = True
            has_m = True
            base_type = iso_type - 3000
        else:
            base_type = iso_type
    if has_srid:
        reader.uint32(endian)
    dimensions = 2 + int(has_z) + int(has_m)

    if base_type == 3:  # Polygon
        rings = []
        for _ in range(reader.uint32(endian)):
            rings.append(
                [
                    reader.coordinate(endian, dimensions)
                    for _ in range(reader.uint32(endian))
                ]
            )
        return {"type": "Polygon", "coordinates": rings}

    if base_type == 6:  # MultiPolygon
        polygons = []
        for _ in range(reader.uint32(endian)):
            polygon = parse_wkb(reader)
            if polygon["type"] != "Polygon":
                raise ValueError("MultiPolygon contém geometria que não é Polygon")
            polygons.append(polygon["coordinates"])
        return {"type": "MultiPolygon", "coordinates": polygons}

    raise ValueError(f"Tipo WKB não suportado: {raw_type}")


def parse_gpkg_geometry(blob: bytes) -> dict[str, Any]:
    if blob[:2] != b"GP" or len(blob) < 8:
        raise ValueError("Cabeçalho de geometria GeoPackage inválido")
    flags = blob[3]
    envelope_code = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 4, 2: 6, 3: 6, 4: 8}
    if envelope_code not in envelope_sizes:
        raise ValueError(f"Envelope GeoPackage inválido: {envelope_code}")
    wkb_offset = 8 + envelope_sizes[envelope_code] * 8
    reader = WkbReader(memoryview(blob)[wkb_offset:])
    geometry = parse_wkb(reader)
    if reader.offset != len(reader.data):
        raise ValueError("Bytes inesperados após a geometria WKB")
    return geometry


def distance_to_segment_sq(point: list[float], start: list[float], end: list[float]) -> float:
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    if dx == 0 and dy == 0:
        return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2
    ratio = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / (
        dx * dx + dy * dy
    )
    ratio = max(0.0, min(1.0, ratio))
    projected_x = start[0] + ratio * dx
    projected_y = start[1] + ratio * dy
    return (point[0] - projected_x) ** 2 + (point[1] - projected_y) ** 2


def simplify_open(points: list[list[float]], tolerance_sq: float) -> list[list[float]]:
    if len(points) <= 2:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start_index, end_index = stack.pop()
        best_index = -1
        best_distance = tolerance_sq
        for index in range(start_index + 1, end_index):
            distance = distance_to_segment_sq(
                points[index], points[start_index], points[end_index]
            )
            if distance > best_distance:
                best_index = index
                best_distance = distance
        if best_index != -1:
            keep[best_index] = True
            stack.append((start_index, best_index))
            stack.append((best_index, end_index))
    return [point for point, retained in zip(points, keep, strict=True) if retained]


def simplify_ring(ring: list[list[float]], tolerance: float) -> list[list[float]]:
    if len(ring) <= 5:
        return [
            [round(x, COORDINATE_DECIMALS), round(y, COORDINATE_DECIMALS)]
            for x, y in ring
        ]
    points = ring[:-1] if ring[0] == ring[-1] else ring[:]
    anchor = points[0]
    split = max(
        range(1, len(points)),
        key=lambda index: (points[index][0] - anchor[0]) ** 2
        + (points[index][1] - anchor[1]) ** 2,
    )
    first = simplify_open(points[: split + 1], tolerance * tolerance)
    second = simplify_open(points[split:] + [points[0]], tolerance * tolerance)
    simplified = first[:-1] + second[:-1]

    rounded: list[list[float]] = []
    for x, y in simplified:
        point = [round(x, COORDINATE_DECIMALS), round(y, COORDINATE_DECIMALS)]
        if not rounded or point != rounded[-1]:
            rounded.append(point)
    if len(rounded) < 3:
        rounded = [
            [round(x, COORDINATE_DECIMALS), round(y, COORDINATE_DECIMALS)]
            for x, y in points
        ]
    rounded.append(rounded[0])
    return rounded


def simplify_geometry(geometry: dict[str, Any], tolerance: float) -> dict[str, Any]:
    if geometry["type"] == "Polygon":
        coordinates = [simplify_ring(ring, tolerance) for ring in geometry["coordinates"]]
    elif geometry["type"] == "MultiPolygon":
        coordinates = [
            [simplify_ring(ring, tolerance) for ring in polygon]
            for polygon in geometry["coordinates"]
        ]
    else:
        raise ValueError(f"Geometria inesperada: {geometry['type']}")
    return {"type": geometry["type"], "coordinates": coordinates}


def count_points(geometry: dict[str, Any]) -> int:
    if geometry["type"] == "Polygon":
        return sum(len(ring) for ring in geometry["coordinates"])
    return sum(
        len(ring)
        for polygon in geometry["coordinates"]
        for ring in polygon
    )


def read_table_titles(source_xlsx_dir: Path) -> dict[str, str]:
    titles: dict[str, str] = {}
    for path in source_xlsx_dir.glob("*.xlsx"):
        workbook = load_workbook(path, data_only=True, read_only=True)
        try:
            worksheet = workbook.worksheets[0]
            title = next(
                (
                    str(cell.value).strip()
                    for cell in worksheet[2]
                    if cell.value is not None and str(cell.value).strip()
                ),
                path.stem,
            )
            titles[path.stem] = title
        finally:
            workbook.close()
    return titles


def field_format(sqlite_type: str, label: str) -> str:
    lowered = label.casefold()
    if "taxa" in lowered or "percent" in lowered:
        return "decimal"
    if "médio" in lowered or "mediano" in lowered or "rendimento" in lowered:
        return "decimal"
    if sqlite_type == "INTEGER":
        return "integer"
    if sqlite_type == "REAL":
        return "decimal"
    return "text"


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
        encoding="utf-8",
    )


def write_chunked_json(path: Path, value: Any) -> int:
    encoded = json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    for stale_part in path.parent.glob(f"{path.name}.part-*"):
        stale_part.unlink()

    parts: list[str] = []
    for index, offset in enumerate(range(0, len(encoded), JSON_CHUNK_BYTES)):
        part_path = path.with_name(f"{path.name}.part-{index:03d}")
        part_path.write_bytes(encoded[offset : offset + JSON_CHUNK_BYTES])
        parts.append(part_path.name)

    write_json(
        path.with_name(f"{path.name}.manifest.json"),
        {"format": "utf8-json-parts-v1", "bytes": len(encoded), "parts": parts},
    )
    path.unlink(missing_ok=True)
    return len(encoded)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("gpkg", type=Path)
    parser.add_argument("xlsx_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--tolerance", type=float, default=0.00075)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    uri = "file:" + urllib.parse.quote(str(args.gpkg.resolve())) + "?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"GeoPackage inválido: {integrity}")
        table_info = connection.execute(
            f'PRAGMA table_info("{LAYER}")'
        ).fetchall()
        column_types = {row[1]: row[2].upper() for row in table_info}
        joined_fields = [row[1] for row in table_info if " | " in row[1]]
        if len(joined_fields) != 305:
            raise ValueError(f"Esperados 305 campos censitários; encontrados {len(joined_fields)}")

        titles = read_table_titles(args.xlsx_dir)
        groups: list[dict[str, Any]] = []
        group_lookup: dict[str, dict[str, Any]] = {}
        fields: list[dict[str, Any]] = []
        for index, full_name in enumerate(joined_fields):
            group_id, label = full_name.split(" | ", 1)
            if group_id not in group_lookup:
                group = {
                    "id": group_id,
                    "title": titles.get(group_id, group_id),
                    "field_indexes": [],
                }
                group_lookup[group_id] = group
                groups.append(group)
            group_lookup[group_id]["field_indexes"].append(index)
            sqlite_type = column_types[full_name]
            fields.append(
                {
                    "index": index,
                    "name": full_name,
                    "group": group_id,
                    "label": label,
                    "type": sqlite_type,
                    "format": field_format(sqlite_type, label),
                }
            )

        # A primeira variável de cada tabela é o seu universo/Total. Ela e todas
        # as variáveis das tabelas configuradas em ABSOLUTE_GROUPS permanecem em
        # valor absoluto; as demais são exibidas como percentuais do Total.
        for group in groups:
            total_field_index = group["field_indexes"][0]
            group["total_field_index"] = total_field_index
            for field_index in group["field_indexes"]:
                is_total = field_index == total_field_index
                fields[field_index]["is_total"] = is_total
                fields[field_index]["display_mode"] = (
                    "absolute"
                    if is_total or group["id"] in ABSOLUTE_GROUPS
                    else "percent_of_table_total"
                )

        selected_columns = BASE_COLUMNS + joined_fields
        select_sql = ", ".join('"' + name.replace('"', '""') + '"' for name in selected_columns)
        rows = connection.execute(
            f'SELECT {select_sql} FROM "{LAYER}" ORDER BY cd_apond'
        ).fetchall()
    finally:
        connection.close()

    features = []
    data_rows = []
    before_points = 0
    after_points = 0
    null_only_rows = 0
    for index, row in enumerate(rows):
        geometry = parse_gpkg_geometry(row["geom"])
        before_points += count_points(geometry)
        geometry = simplify_geometry(geometry, args.tolerance)
        after_points += count_points(geometry)
        values = [row[field] for field in joined_fields]
        if all(value is None for value in values):
            null_only_rows += 1
        data_rows.append(values)
        features.append(
            {
                "type": "Feature",
                "id": row["cd_apond"],
                "properties": {
                    "cd_apond": row["cd_apond"],
                    "nm_apond": row["nm_apond"],
                    "TipoAPOND": row["TipoAPOND"],
                    "AREA_KM2": row["AREA_KM2"],
                    "Qt_SetCensit": row["Qt_SetCensit"],
                    "CD_MUN": row["CD_MUN"],
                    "NM_MUN": row["NM_MUN"],
                    "data_index": index,
                },
                "geometry": geometry,
            }
        )

    geojson = {
        "type": "FeatureCollection",
        "name": "AreasDePonderacao2022_SP_Censo2022",
        "crs": {
            "type": "name",
            "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"},
        },
        "features": features,
    }
    census = {
        "year": 2022,
        "source": "IBGE — Censo Demográfico 2022, Resultados Gerais da Amostra por Áreas de Ponderação",
        "join_key": "cd_apond",
        "display_rule": {
            "total": "absolute",
            "absolute_groups": sorted(ABSOLUTE_GROUPS),
            "other_fields": "percent_of_table_total",
            "formula": "(value / table_total) * 100",
        },
        "fields": fields,
        "groups": groups,
        "rows": data_rows,
    }
    geojson_bytes = write_chunked_json(args.output_dir / "aponds-sp.geojson", geojson)
    variables_bytes = write_chunked_json(args.output_dir / "censo-variables.json", census)

    stats = {
        "features": len(features),
        "fields": len(fields),
        "groups": len(groups),
        "null_only_rows": null_only_rows,
        "points_before": before_points,
        "points_after": after_points,
        "reduction_percent": round((1 - after_points / before_points) * 100, 2),
        "tolerance_degrees": args.tolerance,
        "geojson_bytes": geojson_bytes,
        "variables_bytes": variables_bytes,
    }
    (Path(__file__).with_name("build-stats.json")).write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERRO: {exc}", file=sys.stderr)
        raise
