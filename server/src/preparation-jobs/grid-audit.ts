/** Measurements are supplied by an approved human/fixture; no inferred architecture is canon. */
export interface GridLandmark {
  artworkX: number;
  artworkY: number;
  gridColumn: number;
  gridRow: number;
}
export function auditUniformGrid(
  points: GridLandmark[],
  width: number,
  height: number,
  tolerancePixels: number,
) {
  if (
    points.length < 3 ||
    points.length > 16 ||
    ![width, height].every((n) => Number.isFinite(n) && n > 0) ||
    !Number.isFinite(tolerancePixels) ||
    tolerancePixels < 0 ||
    !points.every((p) => Object.values(p).every(Number.isFinite))
  )
    throw new Error("Invalid grid measurements.");
  const columns = points.map((p) => p.gridColumn),
    rows = points.map((p) => p.gridRow);
  const fit = (inputs: number[], outputs: number[]) => {
    const meanX = inputs.reduce((a, b) => a + b, 0) / inputs.length,
      meanY = outputs.reduce((a, b) => a + b, 0) / outputs.length;
    const variance = inputs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
    if (!variance) throw new Error("Widely separated measurements required on both axes.");
    const spacing =
      inputs.reduce((sum, x, i) => sum + (x - meanX) * (outputs[i]! - meanY), 0) / variance;
    return { spacing, origin: meanY - spacing * meanX };
  };
  const x = fit(
      columns,
      points.map((p) => p.artworkX),
    ),
    y = fit(
      rows,
      points.map((p) => p.artworkY),
    );
  if (
    x.spacing <= 0 ||
    y.spacing <= 0 ||
    Math.max(...points.map((p) => p.artworkX)) - Math.min(...points.map((p) => p.artworkX)) <
      width / 2 ||
    Math.max(...points.map((p) => p.artworkY)) - Math.min(...points.map((p) => p.artworkY)) <
      height / 2
  )
    throw new Error("Measurements must span opposite map regions.");
  const uniformSpacing = (x.spacing + y.spacing) / 2;
  const residuals = points.map((p) =>
    Math.hypot(
      p.artworkX - (x.origin + p.gridColumn * uniformSpacing),
      p.artworkY - (y.origin + p.gridRow * uniformSpacing),
    ),
  );
  const maximumResidualPixels = Math.max(...residuals);
  return {
    spacingX: x.spacing,
    spacingY: y.spacing,
    uniformSpacing,
    originX: x.origin,
    originY: y.origin,
    residuals,
    maximumResidualPixels,
    tolerancePixels,
    uniformAlignmentAccepted: maximumResidualPixels <= tolerancePixels,
    architectureScale: "requires-confirmed-game-unit-reference" as const,
    tvAcceptance: "pending" as const,
  };
}
export function geometryMigrationImpact(
  points: { kind: "token" | "wall" | "door" | "note" | "light" | "trap"; x: number; y: number }[],
  transform: { scale: number; offsetX: number; offsetY: number },
) {
  if (
    points.length > 5000 ||
    !Number.isFinite(transform.scale) ||
    transform.scale <= 0 ||
    ![transform.offsetX, transform.offsetY].every(Number.isFinite) ||
    !points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  )
    throw new Error("Invalid bounded geometry migration.");
  return {
    requiresReview: true,
    applied: false,
    points: points.map((p) => ({
      ...p,
      proposedX: p.x * transform.scale + transform.offsetX,
      proposedY: p.y * transform.scale + transform.offsetY,
    })),
    warning:
      "Coordinate impact only; adapter must migrate widths, radii, elevation, polygons and native document geometry coherently.",
  };
}
