#!/usr/bin/env python3
"""Convert the editable sales workbook into the canonical application catalog."""

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


SELECTION_RULE = "Parent Family Name = Portable Balances"
REQUIRED_COLUMNS = {
    "Material Number",
    "Material Description (Global English)",
    "Parent Family Name",
    "Family Name",
    "Trade Name",
    "Maximum Capacity {metric}",
    "Readability {metric}",
}
RELATIONSHIP_COLUMNS = [
    "Relationship / Accessories",
    "Relationship / Cross Selling",
    "Relationship / Services",
    "Relationship / Spare Parts",
    "Relationship / Upsellings",
    "Relationship / Replacements",
]
DOCUMENT_COLUMNS = [
    "EN Data Sheets 1",
    "EN Data Sheets 2",
    "EN Data Sheets 3",
    "EN User Guide 1",
    "EN User Guide 2",
    "EN Manuals 1",
    "EN Manuals 2",
]
CORE_SOURCE_COLUMNS = {
    "AI_Search_Index", "AI_Summary", "Material Number",
    "Material Description (Global English)", "Parent Family Name", "Family Name",
    "Sales Org.", "Main Delivering Plant", "MinimumOrderQuantity",
    "Base unit of measure", "Procurement type", "Commodity code",
    "Country of origin", "Image URL", "Trade Name", "Product Hierarchy",
    "Service Hierarchy", "Sellable Languages", "Family Description", "Tag Line",
    "Benefit Headline 1", "Benefit Text 1", "Benefit Headline 2", "Benefit Text 2",
    "Benefit Headline 3", "Benefit Text 3", "Application", "Display", "Operation",
    "Communication", "Construction", "Design Features", "Auxiliary Display Model",
    "Battery Life", "Communication.1", "Dimensions {Height} {metric}",
    "Dimensions {Length} {metric}", "Dimensions {Width} {metric}", "Display.1",
    "Inuse cover", "Key Features", "Legal for Trade", "Market Worlds",
    "Maximum Capacity {metric}", "Net Weight {metric}", "Pan Construction", "Power",
    "Product will be used", "Readability {metric}", "Stabilization Time", "Test Weight",
    "Transportation Case", "Typical Areas", "Units of Measurement",
    "Working Environment {metric}",
}
SPECIAL_API_NAMES = {
    "Material Description (Global English)": "product_name",
    "Sales Org.": "sales_organization",
    "MinimumOrderQuantity": "minimum_order_quantity",
    "Base unit of measure": "base_unit",
    "Sales Unit/Delivery unit": "sales_delivery_unit",
    "Country of origin": "country_of_origin",
    "Communication": "communication_description",
    "Communication.1": "communication_options",
    "Display": "display_description",
    "Display.1": "display_type",
    "Inuse cover": "in_use_cover",
    "Product will be used": "usage_context",
    '"d" {metric}': "verification_scale_interval_metric",
    '"e" {metric}': "verification_scale_interval_e_metric",
}


def clean(value):
    return re.sub(r"\s+", " ", str(value or "").replace("\u00a0", " ")).strip()


def snake(value):
    text = clean(value).lower()
    text = text.replace("±", " plus_minus ").replace("ø", " diameter ")
    text = text.replace('"', "").replace("#", " number ")
    text = re.sub(r"\{([^}]+)\}", r" \1 ", text)
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_")


def parse_measurement(value):
    text = clean(value).replace(",", "")
    match = re.fullmatch(r"([+-]?\d+(?:\.\d+)?)\s*([^\d]+)", text)
    if not match:
        return None, None
    return float(match.group(1)), clean(match.group(2))


def smart_value(value):
    text = clean(value)
    if not text:
        return None
    if ";" in text and not text.lower().startswith("http"):
        return [part.strip() for part in text.split(";") if part.strip()]
    return text


def compact(mapping):
    return {key: value for key, value in mapping.items() if value not in (None, "", [], {})}


def build_test_questions(products, relationships):
    questions = []
    test_id = 1
    by_family = defaultdict(list)
    for product in products:
        by_family[product["family"]].append(product)

    for family in sorted(by_family):
        product = by_family[family][0]
        for question, answer_type, fields, evidence in [
            (
                f"What are the maximum capacity and readability of {product['model']}?",
                "Exact specification lookup",
                "maximum_capacity; readability",
                f"{product['specifications']['maximum_capacity']['display']}; {product['specifications']['readability']['display']}",
            ),
            (
                f"How is {product['model']} powered and what is its battery life?",
                "Product feature lookup",
                "power; battery_life",
                f"{product['specifications'].get('power', '')}; {product['specifications'].get('battery_life', '')}",
            ),
        ]:
            questions.append({
                "test_id": f"T-{test_id:03d}",
                "question": question,
                "answer_type": answer_type,
                "target_material_number": product["material_number"],
                "target_model": product["model"],
                "required_fields": fields,
                "expected_evidence": evidence,
                "pass_criterion": "Answer matches the structured record and cites the target material number.",
                "priority": "High",
            })
            test_id += 1

    for family in sorted(by_family):
        family_products = by_family[family]
        if len(family_products) < 2:
            continue
        first, second = family_products[0], family_products[-1]
        questions.append({
            "test_id": f"T-{test_id:03d}",
            "question": f"Compare {first['model']} and {second['model']} for capacity, readability, and power.",
            "answer_type": "Product comparison",
            "target_material_number": f"{first['material_number']}; {second['material_number']}",
            "target_model": f"{first['model']}; {second['model']}",
            "required_fields": "maximum_capacity; readability; power",
            "expected_evidence": (
                f"{first['model']}: {first['specifications']['maximum_capacity']['display']}, "
                f"{first['specifications']['readability']['display']}; "
                f"{second['model']}: {second['specifications']['maximum_capacity']['display']}, "
                f"{second['specifications']['readability']['display']}"
            ),
            "pass_criterion": "Answer keeps the two records separate, compares the requested fields, and cites both material numbers.",
            "priority": "High",
        })
        test_id += 1

    accessory_sources = sorted({
        edge["source_material_number"] for edge in relationships
        if edge["relationship_type"] == "Accessories"
    })[:5]
    by_material = {product["material_number"]: product for product in products}
    for material in accessory_sources:
        product = by_material[material]
        expected = sorted({
            edge["related_material_number"] for edge in relationships
            if edge["source_material_number"] == material and edge["relationship_type"] == "Accessories"
        })
        questions.append({
            "test_id": f"T-{test_id:03d}",
            "question": f"Which accessories are listed for {product['model']}?",
            "answer_type": "Relationship lookup",
            "target_material_number": material,
            "target_model": product["model"],
            "required_fields": "relationships.accessories",
            "expected_evidence": "; ".join(expected),
            "pass_criterion": "Answer lists only source-linked accessories and identifies unresolved related materials for review.",
            "priority": "High",
        })
        test_id += 1
    return questions


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    source_path = args.source.resolve()
    output_path = args.output.resolve()
    if not source_path.is_file():
        raise SystemExit(f"Workbook not found: {source_path}")

    frame = pd.read_excel(source_path, sheet_name=0, dtype=object, keep_default_na=False)
    frame.columns = [str(column) for column in frame.columns]
    missing_columns = sorted(REQUIRED_COLUMNS - set(frame.columns))
    if missing_columns:
        raise SystemExit(f"Workbook is missing required columns: {', '.join(missing_columns)}")
    for column in frame.columns:
        if frame[column].dtype == object:
            frame[column] = frame[column].map(clean)

    portable = frame[frame["Parent Family Name"] == "Portable Balances"].copy()
    if portable.empty:
        raise SystemExit("No rows matched Parent Family Name = Portable Balances.")

    name_counts = Counter()
    api_field_names = {}
    for column in frame.columns:
        base = SPECIAL_API_NAMES.get(column, snake(column))
        name_counts[base] += 1
        api_field_names[column] = base if name_counts[base] == 1 else f"{base}_{name_counts[base]}"

    material_lookup = {
        clean(row["Material Number"]): row
        for _, row in frame.iterrows()
        if clean(row["Material Number"])
    }
    excluded_attributes = CORE_SOURCE_COLUMNS | set(RELATIONSHIP_COLUMNS) | set(DOCUMENT_COLUMNS) | {
        "Material Description", "Image",
    }

    products = []
    relationship_edges = []
    unresolved_relationships = []
    related_materials = set()
    seen_edges = set()
    document_link_count = 0

    for _, row in portable.iterrows():
        material = clean(row["Material Number"])
        model = clean(row["Trade Name"])
        family = clean(row["Family Name"])
        capacity_value, capacity_unit = parse_measurement(row["Maximum Capacity {metric}"])
        readability_value, readability_unit = parse_measurement(row["Readability {metric}"])
        stabilization_value, stabilization_unit = parse_measurement(row.get("Stabilization Time", ""))
        stabilization_seconds = stabilization_value if clean(stabilization_unit).lower() in {"s", "sec", "second", "seconds"} else None

        content_fields = {
            "sellable_languages": row.get("Sellable Languages", ""),
            "family_description": row.get("Family Description", ""),
            "tag_line": row.get("Tag Line", ""),
            "benefit_headline_1": row.get("Benefit Headline 1", ""),
            "benefit_text_1": row.get("Benefit Text 1", ""),
            "benefit_headline_2": row.get("Benefit Headline 2", ""),
            "benefit_text_2": row.get("Benefit Text 2", ""),
            "benefit_headline_3": row.get("Benefit Headline 3", ""),
            "benefit_text_3": row.get("Benefit Text 3", ""),
            "application": row.get("Application", ""),
            "display_description": row.get("Display", ""),
            "operation": row.get("Operation", ""),
            "communication_description": row.get("Communication", ""),
            "construction": row.get("Construction", ""),
            "design_features": row.get("Design Features", ""),
            "auxiliary_display": row.get("Auxiliary Display Model", ""),
            "communication_options": row.get("Communication.1", ""),
            "dimensions_height_metric": row.get("Dimensions {Height} {metric}", ""),
            "dimensions_length_metric": row.get("Dimensions {Length} {metric}", ""),
            "dimensions_width_metric": row.get("Dimensions {Width} {metric}", ""),
            "display_type": row.get("Display.1", ""),
            "in_use_cover": row.get("Inuse cover", ""),
            "key_features": row.get("Key Features", ""),
            "market_worlds": row.get("Market Worlds", ""),
            "net_weight_metric": row.get("Net Weight {metric}", ""),
            "usage_context": row.get("Product will be used", ""),
            "test_weight": row.get("Test Weight", ""),
            "transportation_case": row.get("Transportation Case", ""),
            "typical_areas": row.get("Typical Areas", ""),
            "units_of_measurement": row.get("Units of Measurement", ""),
            "working_environment_metric": row.get("Working Environment {metric}", ""),
            "ai_summary": row.get("AI_Summary", ""),
            "search_index": row.get("AI_Search_Index", ""),
        }
        sales_content = compact({key: smart_value(value) for key, value in content_fields.items()})

        additional_attributes = {}
        for column in frame.columns:
            if column in excluded_attributes:
                continue
            value = clean(row[column])
            if value:
                additional_attributes[api_field_names[column]] = smart_value(value)

        grouped_relationships = defaultdict(list)
        for column in RELATIONSHIP_COLUMNS:
            raw = clean(row.get(column, ""))
            if not raw:
                continue
            relationship_type = column.replace("Relationship / ", "")
            for related_material in [token.strip() for token in re.split(r"[;,|]", raw) if token.strip()]:
                edge_key = (material, relationship_type, related_material)
                if edge_key in seen_edges:
                    continue
                seen_edges.add(edge_key)
                related_materials.add(related_material)
                resolved = related_material in material_lookup
                edge = {
                    "source_material_number": material,
                    "source_model": model,
                    "relationship_type": relationship_type,
                    "related_material_number": related_material,
                    "source_field": column,
                    "resolution_status": "Resolved" if resolved else "Needs source",
                }
                relationship_edges.append(edge)
                if not resolved:
                    unresolved_relationships.append({key: edge[key] for key in [
                        "source_material_number", "source_model", "relationship_type",
                        "related_material_number", "source_field",
                    ]})
                grouped_relationships[snake(relationship_type)].append(related_material)

        product_documents = defaultdict(list)
        for column in DOCUMENT_COLUMNS:
            url = clean(row.get(column, ""))
            if not url:
                continue
            match = re.match(r"EN (Data Sheets|User Guide|Manuals) (\d+)", column)
            document_type = {"Data Sheets": "data_sheet", "User Guide": "user_guide", "Manuals": "manual"}[match.group(1)]
            product_documents[document_type].append(url)
            document_link_count += 1

        minimum_order = clean(row.get("MinimumOrderQuantity", ""))
        commercial = compact({
            "sales_organization": clean(row.get("Sales Org.", "")),
            "delivering_plant": clean(row.get("Main Delivering Plant", "")),
            "procurement_type": clean(row.get("Procurement type", "")),
            "commodity_code": clean(row.get("Commodity code", "")),
            "country_of_origin": clean(row.get("Country of origin", "")),
            "minimum_order_quantity": int(float(minimum_order)) if minimum_order else None,
            "base_unit": clean(row.get("Base unit of measure", "")),
        })
        specifications = compact({
            "maximum_capacity": compact({"display": clean(row["Maximum Capacity {metric}"]), "value": capacity_value, "unit": capacity_unit}),
            "readability": compact({"display": clean(row["Readability {metric}"]), "value": readability_value, "unit": readability_unit}),
            "stabilization_time": compact({"display": clean(row.get("Stabilization Time", "")), "seconds": stabilization_seconds}),
            "legal_for_trade": clean(row.get("Legal for Trade", "")),
            "power": clean(row.get("Power", "")),
            "battery_life": clean(row.get("Battery Life", "")),
            "pan_construction": clean(row.get("Pan Construction", "")),
        })
        products.append({
            "record_id": f"portable_balance:{material}",
            "record_type": "portable_balance",
            "material_number": material,
            "model": model,
            "product_name": clean(row["Material Description (Global English)"]),
            "family": family,
            "commercial": commercial,
            "specifications": specifications,
            "sales_content": sales_content,
            "additional_attributes": additional_attributes,
            "relationships": dict(grouped_relationships),
            "documents": dict(product_documents),
            "image_url": clean(row.get("Image URL", "")),
            "source": {"file": source_path.name, "selection_rule": SELECTION_RULE},
        })

    products.sort(key=lambda item: (
        item["family"],
        item["specifications"].get("maximum_capacity", {}).get("value") or 0,
        item["specifications"].get("readability", {}).get("value") or 0,
        item["model"],
        item["material_number"],
    ))

    related_items = []
    for material in sorted(related_materials):
        row = material_lookup.get(material)
        if row is None:
            continue
        related_items.append(compact({
            "record_id": f"related_item:{material}",
            "record_type": "related_item",
            "material_number": material,
            "product_name": clean(row.get("Material Description (Global English)", "")),
            "model": clean(row.get("Trade Name", "")),
            "parent_family": clean(row.get("Parent Family Name", "")),
            "family": clean(row.get("Family Name", "")),
            "country_of_origin": clean(row.get("Country of origin", "")),
            "product_hierarchy": clean(row.get("Product Hierarchy", "")),
            "service_hierarchy": clean(row.get("Service Hierarchy", "")),
            "image_url": clean(row.get("Image URL", "")),
            "summary": clean(row.get("AI_Summary", "")),
            "source": {"file": source_path.name},
        }))
    related_items.sort(key=lambda item: (
        item.get("parent_family", ""), item.get("family", ""),
        item.get("model", "") or item.get("product_name", ""), item["material_number"],
    ))

    model_counts = Counter(product["model"] for product in products)
    ambiguous_models = sum(1 for count in model_counts.values() if count > 1)
    unresolved_groups = len({
        (item["relationship_type"], item["related_material_number"], item["source_field"])
        for item in unresolved_relationships
    })
    missing_data_sheets = sum(1 for product in products if not product.get("documents", {}).get("data_sheet"))
    missing_manuals = sum(1 for product in products if not product.get("documents", {}).get("manual"))
    qa_items = ambiguous_models + unresolved_groups + missing_data_sheets + missing_manuals + 3
    family_counts = Counter(product["family"] for product in products)
    source_bytes = source_path.read_bytes()

    payload = {
        "metadata": {
            "catalog_schema_version": "2.0.0",
            "source_file": source_path.name,
            "source_sha256": hashlib.sha256(source_bytes).hexdigest(),
            "source_bytes": len(source_bytes),
            "source_rows": int(frame.shape[0]),
            "source_columns": int(frame.shape[1]),
            "selection_rule": SELECTION_RULE,
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "portable_products": len(products),
            "portable_families": len(family_counts),
            "family_counts": dict(sorted(family_counts.items())),
            "api_records": len(products) + len(related_items),
            "resolved_related_items": len(related_items),
            "document_links": document_link_count,
            "relationship_edges": len(relationship_edges),
            "unresolved_relationship_edges": len(unresolved_relationships),
            "qa_items": qa_items,
        },
        "records": products + related_items,
        "unresolved_relationships": sorted(unresolved_relationships, key=lambda item: (
            item["source_model"], item["relationship_type"], item["related_material_number"]
        )),
        "test_questions": build_test_questions(products, relationship_edges),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({
        "source": str(source_path),
        "output": str(output_path),
        "portable_products": len(products),
        "related_items": len(related_items),
        "unresolved_relationships": len(unresolved_relationships),
    }, indent=2))


if __name__ == "__main__":
    main()
