import type { AiDmToolSearchRequest } from "@foundry-ai-dungeon-master/shared";

import type { RankedSearchResult } from "./catalog.js";
import type { CatalogToolRecord } from "./types.js";

const FIELD_WEIGHTS = {
  toolId: 9,
  displayName: 6,
  purpose: 5,
  useCases: 4,
  keywords: 7,
  entityTypes: 4,
  effects: 2,
  description: 1,
} as const;

export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1);
}

function addTokens(target: Map<string, number>, value: string, weight: number): void {
  for (const token of tokenize(value)) {
    target.set(token, (target.get(token) ?? 0) + weight);
  }
}

function termWeights(record: CatalogToolRecord): Map<string, number> {
  const weights = new Map<string, number>();
  const { descriptor } = record;
  addTokens(weights, descriptor.toolId, FIELD_WEIGHTS.toolId);
  addTokens(weights, descriptor.displayName, FIELD_WEIGHTS.displayName);
  addTokens(weights, descriptor.purpose, FIELD_WEIGHTS.purpose);
  for (const useCase of descriptor.useCases) addTokens(weights, useCase, FIELD_WEIGHTS.useCases);
  for (const keyword of descriptor.keywords) addTokens(weights, keyword, FIELD_WEIGHTS.keywords);
  for (const entity of [...descriptor.acceptsEntityTypes, ...descriptor.producesEntityTypes]) {
    addTokens(weights, entity, FIELD_WEIGHTS.entityTypes);
  }
  for (const effect of descriptor.effects) addTokens(weights, effect, FIELD_WEIGHTS.effects);
  addTokens(weights, record.definition.description, FIELD_WEIGHTS.description);
  return weights;
}

function normalizedExact(value: string): string {
  return tokenize(value).join("_");
}

export function searchCatalog(
  records: readonly CatalogToolRecord[],
  request: AiDmToolSearchRequest,
  catalogRevision: string,
  policyViewRevision: string,
  searchId: string,
): RankedSearchResult {
  const normalizedTerms = [...new Set(tokenize(request.query))];
  const excluded = new Set(request.alreadyLoaded);
  const candidates = records.filter((record) => !excluded.has(record.descriptor.toolId));
  const documents = candidates.map((record) => ({ record, terms: termWeights(record) }));
  const averageLength =
    documents.length === 0
      ? 1
      : documents.reduce(
          (total, document) =>
            total + [...document.terms.values()].reduce((sum, value) => sum + value, 0),
          0,
        ) / documents.length;
  const documentFrequency = new Map<string, number>();
  for (const term of normalizedTerms) {
    documentFrequency.set(term, documents.filter((document) => document.terms.has(term)).length);
  }

  const directScores = new Map<string, number>();
  const queryExact = normalizedExact(request.query);
  for (const { record, terms } of documents) {
    const length = [...terms.values()].reduce((sum, value) => sum + value, 0);
    let score = normalizedExact(record.descriptor.toolId) === queryExact ? 1_000 : 0;
    for (const term of normalizedTerms) {
      const frequency = terms.get(term) ?? 0;
      if (frequency === 0) continue;
      const containing = documentFrequency.get(term) ?? 0;
      const inverseFrequency = Math.log(
        1 + (documents.length - containing + 0.5) / (containing + 0.5),
      );
      const normalization = frequency + 1.2 * (0.25 + 0.75 * (length / averageLength));
      score += inverseFrequency * ((frequency * 2.2) / normalization);
    }
    if (score > 0) directScores.set(record.descriptor.toolId, score);
  }

  // Relationship expansion is exactly one hop from lexical matches. Newly
  // related results are never expanded again, so this cannot recursively
  // grow a classifier-selected bundle.
  const scores = new Map(directScores);
  const candidateIds = new Set(candidates.map((record) => record.descriptor.toolId));
  for (const record of candidates) {
    const own = directScores.get(record.descriptor.toolId);
    if (own === undefined) continue;
    for (const relatedId of record.descriptor.relatedToolIds) {
      if (!candidateIds.has(relatedId)) continue;
      const related = directScores.get(relatedId) ?? 0;
      scores.set(relatedId, related + Math.min(own, 10) * 0.15);
    }
  }

  const ranked = candidates
    .filter((record) => scores.has(record.descriptor.toolId))
    .sort((left, right) => {
      const scoreDifference =
        (scores.get(right.descriptor.toolId) ?? 0) - (scores.get(left.descriptor.toolId) ?? 0);
      return scoreDifference || left.descriptor.toolId.localeCompare(right.descriptor.toolId);
    })
    .slice(0, Math.max(0, request.limit));

  return {
    result: {
      searchId,
      catalogRevision,
      policyViewRevision,
      query: request.query,
      descriptors: ranked.map((record) => structuredClone(record.descriptor)),
    },
    scores,
    normalizedTerms,
  };
}
