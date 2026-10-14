import { createHash } from 'node:crypto';
import { z } from 'zod';

const inputSchema = z.object({
  worldId: z.literal('mcp-test'),
  name: z.string().min(1).max(140).regex(/^[^\u0000-\u001f\u007f]+$/),
  assetRef: z.string().regex(/^ai-dm-prepared-maps\/mcp-test\/[a-f0-9]{64}\.(png|jpg|webp)$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  imageWidth: z.number().int().min(100).max(16384),
  imageHeight: z.number().int().min(100).max(16384),
  displayWidthMm: z.literal(955),
  profile: z.enum(['tv','gm-preview']).default('tv'),
  display: z.object({ clientId: z.string().min(1), userName: z.string().min(1), role: z.union([z.literal(2),z.literal(4)]),
    cssWidth: z.number().int().min(320).max(16384), cssHeight: z.number().int().min(320).max(16384),
    devicePixelRatio: z.number().positive().max(8), sceneReady: z.literal(true) }).strict(),
}).strict();

/** Pure planning: never creates a scene, approves an asset, or spends a provider request. */
export function planBattlemap(raw: unknown) {
  const input = inputSchema.parse(raw);
  if(input.profile==='tv'&&(input.display.userName!=='TV'||input.display.role!==2))throw Error('TV_IDENTITY_REQUIRED');
  if(input.profile==='gm-preview'&&input.display.role!==4)throw Error('GM_IDENTITY_REQUIRED');
  if (!input.assetRef.includes(input.sourceHash)) throw Error('ASSET_HASH_MISMATCH');
  const gridSize = 100;
  const pixelsPerInch = input.display.cssWidth * 25.4 / input.displayWidthMm;
  const width = Math.round(input.displayWidthMm / 25.4 * gridSize);
  const height = input.profile==='gm-preview'?width:Math.round(width * input.display.cssHeight / input.display.cssWidth);
  const levelId = createHash('sha256').update(`forest-level:${input.sourceHash}`).digest('hex').slice(0, 16);
  return {
    worldId: input.worldId, profile:input.profile, status: 'planned', providerRequests: 0, physicalAcceptance: false,
    displayEvidence: input.display,
    viewport: { scale: pixelsPerInch / gridSize, x: width / 2, y: height / 2 },
    source: { width: input.imageWidth, height: input.imageHeight, hash: input.sourceHash },
    scene: { name: input.name, active: false, navigation: false, ownership: { default: 0 }, width, height,
      padding: 0, shiftX: 0, shiftY: 0, tokenVision:false, fog:{mode:0}, grid: { type: 1, size: gridSize, distance: 5, units: 'ft', style:'solidLines', color:'#ffffff', alpha:0.5, thickness:1 },
      initialLevel: levelId, levels: [{ _id: levelId, name: 'Forest', background: { src: input.assetRef },
        textures: { anchorX: 0.5, anchorY: 0.5, offsetX: 0, offsetY: 0, fit: 'contain', scaleX: 1, scaleY: 1, rotation: 0 } }],
      flags: { 'foundry-ai-dungeon-master': { preparationId: `forest-${input.sourceHash.slice(0, 24)}`, testFixture: true } } },
    nextAction: 'Review the approved asset receipt and this exact scene, then use the existing browser-only native review/apply workflow. Verify physical grid with a ruler before acceptance.',
  };
}
