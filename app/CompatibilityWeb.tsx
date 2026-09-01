"use client";

import {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type NodeKind = "root" | "family" | "category" | "series" | "model" | "part";
type RelationType = "accessory" | "spare_part";
type RelationFilter = "all" | RelationType;

type WebNode = {
  id: string;
  label: string;
  kind: NodeKind;
  detail: string;
  parentId: string | null;
  family?: string;
  parentFamily?: string;
  materialNumber?: string;
  productName?: string;
  imageUrl?: string;
  sourceRow?: number | null;
  modelCount?: number;
  verified: boolean;
  specifications?: {
    maximumCapacity?: string;
    readability?: string;
    stabilizationTime?: string;
    power?: string;
    batteryLife?: string;
    panConstruction?: string;
    dimensions?: string;
  };
  relationshipCounts?: Record<RelationType, number>;
};

type WebLink = {
  source: string;
  target: string;
  state: "compatible";
  relationType: RelationType;
  label: string;
  sourceField: string;
};

type WebData = {
  metadata: {
    sourceFile: string;
    sourceSha256: string;
    selectionRule: string;
    portableProducts: number;
    portableFamilies: number;
    uniqueRelatedParts: number;
    resolvedParts: number;
    unresolvedParts: number;
    accessoryLinks: number;
    sparePartLinks: number;
    relationshipLinks: number;
  };
  nodes: WebNode[];
  links: WebLink[];
};

type PositionedNode = WebNode & { x: number; y: number; relationType?: RelationType };

const initialPath = ["ohaus"];
const pageSize = 12;

function relationLabel(type: RelationType) {
  return type === "accessory" ? "Accessory" : "Spare part";
}

function CompatibilityWebLoading({ error }: { error?: string }) {
  return (
    <section className="compatibility-shell compatibility-loading">
      <p className="eyebrow">Portable balances</p>
      <h2>{error ? "The compatibility data could not be loaded" : "Loading the compatibility web…"}</h2>
      <p>{error ?? "Preparing verified products, accessories, and spare parts from the MMDF master workbook."}</p>
    </section>
  );
}

export default function CompatibilityWeb() {
  const [data, setData] = useState<WebData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [path, setPath] = useState(initialPath);
  const [selectedId, setSelectedId] = useState("ohaus");
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("accessory");
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("./data/portable-balance-web.json")
      .then((response) => {
        if (!response.ok) throw new Error(`Compatibility data returned ${response.status}.`);
        return response.json() as Promise<WebData>;
      })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Unknown data error.");
      });
    return () => { cancelled = true; };
  }, []);

  const nodeMap = useMemo(
    () => new Map((data?.nodes ?? []).map((node) => [node.id, node])),
    [data],
  );
  const selectedNode = nodeMap.get(selectedId);

  const allRelationships = useMemo(() => {
    if (!data) return [];
    return data.links.filter((link) => link.source === selectedId || link.target === selectedId);
  }, [data, selectedId]);

  const filteredRelationships = useMemo(
    () => allRelationships.filter((link) => relationFilter === "all" || link.relationType === relationFilter),
    [allRelationships, relationFilter],
  );

  const children = useMemo(
    () => (data?.nodes ?? []).filter((node) => node.parentId === selectedId),
    [data, selectedId],
  );

  const graphItems = allRelationships.length > 0 ? filteredRelationships : children;
  const pageCount = Math.max(1, Math.ceil(graphItems.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visibleItems = graphItems.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const positionedNodes = useMemo(() => {
    if (!selectedNode) return [];
    const result: PositionedNode[] = [{ ...selectedNode, x: 50, y: 49 }];
    visibleItems.forEach((item, index) => {
      const node = "source" in item
        ? nodeMap.get(item.source === selectedId ? item.target : item.source)
        : item;
      if (!node) return;
      const angle = -90 + index * (360 / Math.max(visibleItems.length, 1));
      const radians = angle * Math.PI / 180;
      result.push({
        ...node,
        x: 50 + Math.cos(radians) * 38,
        y: 49 + Math.sin(radians) * 39,
        relationType: "source" in item ? item.relationType : undefined,
      });
    });
    return result;
  }, [nodeMap, selectedId, selectedNode, visibleItems]);

  const visibleEdges = useMemo(() => positionedNodes.slice(1).map((node) => ({
    source: selectedId,
    target: node.id,
    relationType: node.relationType,
  })), [positionedNodes, selectedId]);

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized || !data) return [];
    return data.nodes
      .filter((node) => node.kind === "model" || node.kind === "part")
      .filter((node) => [node.label, node.materialNumber, node.productName, node.family]
        .some((value) => value?.toLowerCase().includes(normalized)))
      .slice(0, 8);
  }, [data, query]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    function drawNetwork() {
      if (!canvas || !stage) return;
      const rect = stage.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * ratio));
      canvas.height = Math.max(1, Math.round(rect.height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, rect.width, rect.height);
      const positions = new Map(positionedNodes.map((node) => [node.id, node]));
      visibleEdges.forEach((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return;
        const startX = source.x / 100 * rect.width;
        const startY = source.y / 100 * rect.height;
        const endX = target.x / 100 * rect.width;
        const endY = target.y / 100 * rect.height;
        const color = edge.relationType === "accessory"
          ? "rgba(53, 217, 145, .88)"
          : edge.relationType === "spare_part"
            ? "rgba(104, 170, 255, .86)"
            : "rgba(226, 59, 91, .52)";
        context.beginPath();
        context.moveTo(startX, startY);
        context.quadraticCurveTo((startX + endX) / 2, (startY + endY) / 2 - 13, endX, endY);
        context.strokeStyle = color;
        context.lineWidth = edge.relationType ? 2 : 1.25;
        context.shadowBlur = edge.relationType ? 9 : 4;
        context.shadowColor = color;
        context.stroke();
        context.shadowBlur = 0;
      });
    }
    const observer = new ResizeObserver(drawNetwork);
    observer.observe(stage);
    drawNetwork();
    return () => observer.disconnect();
  }, [positionedNodes, visibleEdges]);

  if (!data || !selectedNode) return <CompatibilityWebLoading error={loadError || undefined} />;

  function pathToNode(nodeId: string) {
    const nextPath: string[] = [];
    let current = nodeMap.get(nodeId);
    while (current) {
      nextPath.unshift(current.id);
      current = current.parentId ? nodeMap.get(current.parentId) : undefined;
    }
    return nextPath;
  }

  function focusNode(node: WebNode) {
    const nodeRelationships = data.links.filter((link) => link.source === node.id || link.target === node.id);
    if (nodeRelationships.length > 0 && !nodeRelationships.some((link) => relationFilter === "all" || link.relationType === relationFilter)) {
      setRelationFilter(nodeRelationships[0].relationType);
    }
    setSelectedId(node.id);
    setPage(0);
    setQuery("");
    if (node.kind !== "part") setPath(pathToNode(node.id));
  }

  function goBack() {
    if (selectedNode.kind === "part") {
      const category = nodeMap.get("portable-balances");
      if (category) focusNode(category);
      return;
    }
    if (path.length <= 1) return;
    const nextPath = path.slice(0, -1);
    setPath(nextPath);
    setSelectedId(nextPath[nextPath.length - 1]);
    setPage(0);
  }

  function resetWeb() {
    setPath(initialPath);
    setSelectedId("ohaus");
    setRelationFilter("accessory");
    setPage(0);
    setQuery("");
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    stage.style.setProperty("--tilt-y", `${((event.clientX - rect.left) / rect.width - .5) * 5}deg`);
    stage.style.setProperty("--tilt-x", `${((event.clientY - rect.top) / rect.height - .5) * -4}deg`);
  }

  const relationshipCounts = {
    accessory: allRelationships.filter((link) => link.relationType === "accessory").length,
    spare_part: allRelationships.filter((link) => link.relationType === "spare_part").length,
  };
  const detailSpecs = selectedNode.specifications
    ? [
      ["Capacity", selectedNode.specifications.maximumCapacity],
      ["Readability", selectedNode.specifications.readability],
      ["Power", selectedNode.specifications.power],
      ["Battery", selectedNode.specifications.batteryLife],
      ["Stabilization", selectedNode.specifications.stabilizationTime],
      ["Dimensions", selectedNode.specifications.dimensions],
    ].filter(([, value]) => value)
    : [];

  return (
    <section className="compatibility-shell">
      <header className="compatibility-heading compatibility-heading-rich">
        <div>
          <p className="eyebrow">MMDF product relationship explorer</p>
          <h2>OHAUS Compatibility Web</h2>
          <p>Portable balances are fully mapped. The other original product families are ready as placeholders for future expansion.</p>
        </div>
        <div className="web-catalog-stats" aria-label="Portable balance catalog coverage">
          <span><strong>{data.metadata.portableProducts}</strong> balances</span>
          <span><strong>{data.metadata.uniqueRelatedParts}</strong> parts</span>
          <span><strong>{data.metadata.relationshipLinks.toLocaleString()}</strong> links</span>
        </div>
      </header>

      <div className="web-toolbar">
        <div className="web-search">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find model, item number, or description"
            aria-label="Search portable balances and related parts"
          />
          {query && (
            <div className="web-search-results">
              {searchResults.length > 0 ? searchResults.map((node) => (
                <button key={node.id} onClick={() => focusNode(node)}>
                  <span><strong>{node.label}</strong><small>{node.kind} · {node.family}</small></span>
                  {node.materialNumber && <b>{node.materialNumber}</b>}
                </button>
              )) : <p>No portable balance item matches that search.</p>}
            </div>
          )}
        </div>
        <div className="web-actions">
          <button onClick={goBack} disabled={path.length === 1 && selectedNode.kind !== "part"}>← Back</button>
          <button className="reset-web" onClick={resetWeb}>Center on OHAUS</button>
        </div>
      </div>

      <nav className="web-breadcrumb" aria-label="Selected compatibility path">
        {path.map((nodeId, index) => {
          const node = nodeMap.get(nodeId);
          if (!node) return null;
          return (
            <span key={nodeId}>
              {index > 0 && <i aria-hidden="true">›</i>}
              <button onClick={() => focusNode(node)}>{node.label}</button>
            </span>
          );
        })}
        {selectedNode.kind === "part" && <span><i aria-hidden="true">›</i><button>{selectedNode.label}</button></span>}
      </nav>

      <div className="compatibility-layout">
        <div className="network-viewport" onPointerMove={handlePointerMove} onPointerLeave={() => {
          stageRef.current?.style.setProperty("--tilt-y", "0deg");
          stageRef.current?.style.setProperty("--tilt-x", "0deg");
        }}>
          <div ref={stageRef} className="network-stage" role="group" aria-label="Portable balance compatibility network">
            <canvas ref={canvasRef} aria-hidden="true" />
            {positionedNodes.map((node, index) => {
              const nodeStyle = {
                left: `${node.x}%`,
                top: `${node.y}%`,
                "--node-z": index === 0 ? "82px" : node.kind === "part" ? "68px" : "54px",
              } as CSSProperties;
              return (
                <button
                  key={node.id}
                  className={`web-node ${node.kind} ${node.relationType ?? ""} ${index === 0 ? "selected on-path" : ""}`}
                  style={nodeStyle}
                  onClick={() => focusNode(node)}
                  aria-pressed={index === 0}
                >
                  <small>{index === 0 ? `selected ${node.kind}` : node.relationType ? relationLabel(node.relationType) : node.kind}</small>
                  <strong>{node.label}</strong>
                  {node.materialNumber && <em>{node.materialNumber}</em>}
                </button>
              );
            })}
          </div>

          {graphItems.length > pageSize && (
            <div className="web-pagination">
              <button disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>←</button>
              <span>{safePage + 1} / {pageCount}</span>
              <button disabled={safePage + 1 >= pageCount} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>→</button>
            </div>
          )}
          <p className="network-hint">Move to tilt · Select any node to recenter · {graphItems.length} connected item{graphItems.length === 1 ? "" : "s"}</p>
        </div>

        <aside className="web-detail" aria-live="polite">
          <p className="panel-label">Selected {selectedNode.kind}</p>
          <h3>{selectedNode.label}</h3>
          {selectedNode.materialNumber && <p className="web-material-number">Item {selectedNode.materialNumber}</p>}
          <p>{selectedNode.detail}</p>

          {detailSpecs.length > 0 && (
            <div className="web-spec-grid">
              {detailSpecs.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
            </div>
          )}

          <div className="detail-status">
            <span className={selectedNode.verified ? "verified" : "planned"} aria-hidden="true" />
            {selectedNode.verified
              ? "Matched to an MMDF catalog row"
              : selectedNode.kind === "part"
                ? "Referenced in MMDF · catalog row missing"
                : "Placeholder family · catalog expansion pending"}
          </div>

          {allRelationships.length > 0 && (
            <>
              <div className="web-relation-tabs" aria-label="Relationship type">
                {([
                  ["accessory", `Accessories ${relationshipCounts.accessory}`],
                  ["spare_part", `Spare parts ${relationshipCounts.spare_part}`],
                  ["all", `All ${allRelationships.length}`],
                ] as Array<[RelationFilter, string]>).map(([value, label]) => (
                  <button key={value} className={relationFilter === value ? "active" : ""} onClick={() => { setRelationFilter(value); setPage(0); }}>{label}</button>
                ))}
              </div>

              <details className="web-relationship-details">
                <summary>Reference all {filteredRelationships.length} matching relationships</summary>
                <div className="relationship-list">
                  {filteredRelationships.map((link) => {
                    const otherId = link.source === selectedId ? link.target : link.source;
                    const otherNode = nodeMap.get(otherId);
                    if (!otherNode) return null;
                    return (
                      <button key={`${link.source}-${link.target}-${link.relationType}`} onClick={() => focusNode(otherNode)}>
                        <span className={`relation-dot ${link.relationType}`} aria-hidden="true" />
                        <span><strong>{otherNode.label}</strong><small>{relationLabel(link.relationType)}</small></span>
                        {otherNode.materialNumber && <b>{otherNode.materialNumber}</b>}
                      </button>
                    );
                  })}
                </div>
              </details>
            </>
          )}

          <details className="web-source-trace">
            <summary>Workbook source</summary>
            <p><strong>{data.metadata.sourceFile}</strong></p>
            <p>{data.metadata.selectionRule}</p>
            {selectedNode.sourceRow && <p>Raw_Data row {selectedNode.sourceRow}</p>}
          </details>

          <div className="relationship-legend">
            <p className="panel-label">Relationship key</p>
            <span><i className="relation-dot accessory" /> Accessory</span>
            <span><i className="relation-dot spare_part" /> Spare part</span>
            <span><i className="relation-dot unresolved" /> Unresolved workbook reference</span>
          </div>
        </aside>
      </div>
    </section>
  );
}
