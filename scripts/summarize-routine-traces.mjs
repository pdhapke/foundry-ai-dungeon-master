import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Offline only: no network, model requests, state mutation or raw context output.
const source = resolve(process.argv[2] ?? 'docs/core-rollout-evidence/live-traces.json');
const { events } = JSON.parse(readFileSync(source, 'utf8'));
if (!Array.isArray(events)) throw new Error('Expected trace events');
const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
const samples = events.filter(event => event.stage === 'confirmed-action-result').map(confirmed => {
  const trace = events.filter(event => event.traceId && event.traceId === confirmed.traceId);
  const find = stage => trace.find(event => event.stage === stage);
  const arrival = find('request-arrival');
  const delta = (end, start = arrival) => round(end && start ? end.atMs - start.atMs : null);
  const requests = trace.filter(event => event.stage === 'model-request').map(request => {
    const response = trace.find(event => event.stage === 'model-response' && event.request === request.request);
    const tool = trace.find(event => event.stage === 'tool-start' && event.request === request.request);
    return { request: request.request, model: request.model, reasoning: request.reasoning?.effort ?? null,
      durationMs: round(response?.durationMs), firstExecutableToolMs: round(tool?.sinceModelRequestMs) };
  });
  const mcp = events.find(event => event.stage === 'mcp-execution-and-ack' && event.correlationId === confirmed.correlationId);
  return { traceId: confirmed.traceId, correlationId: confirmed.correlationId,
    command: find('tool-start')?.tool ?? null, runTemperature: 'unknown', source: 'archived-live-observation',
    initialAuthorizationMs: delta(find('initial-authorization-finished')),
    queueWaitMs: round(find('queue-entered')?.queueWaitMs),
    contextPreparationMs: round(find('context-prepared')?.durationMs), contextOperationBreakdown: null,
    modelRequests: requests, mcpExecutionAndAuthoritativeAckMs: round(mcp?.durationMs),
    backendValidationMs: null, authoritativeReadbackMs: null,
    arrivalToConfirmedResultMs: delta(confirmed),
    arrivalToFirstProxyChunkMs: delta(find('first-visible-stream-chunk')),
    confirmedResultDeliveredToBrowserMs: null, visibleBrowserUpdateMs: null,
    arrivalToAssistantStreamFinishedMs: delta(find('assistant-stream-finished')),
    arrivalToProxyFinishedMs: delta(find('final-response-finished')),
    preparationOperations: trace.filter(event => event.type === 'context-timing').map(event => ({ step: event.step, durationMs: round(event.durationMs), outcome: event.outcome })) };
});
console.log(JSON.stringify({ source, sampleCount: samples.length,
  limitations: ['Different commands: no median/tail or cold/warm claim.', 'Proxy first chunk does not establish browser rendering or confirmed receipt delivery.', 'Null means unmeasured; MCP acknowledgement includes bundled validation and confirmation.'], samples }, null, 2));
