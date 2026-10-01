/* global console, AbortController */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatKitReadTools } from '../../server/src/chatkit/read-tools.ts';
import { ChatKitNativeActions } from '../../server/src/chatkit/native-actions.ts';
import { ChatKitTurns } from '../../server/src/chatkit/turns.ts';
import { WorldCampaignContext } from '../../server/src/context/world-campaign.ts';
import { TrustedToolCatalog, FoundryLocalApiProviderAdapter, CHATKIT_READ_TOOL_METADATA } from '../../server/src/tool-catalog/index.ts';
const root = mkdtempSync(join(tmpdir(), 'ai-dm-phase6-'));
const db = new DatabaseSync(join(root, 'acceptance.sqlite'));
const identity = { worldId: 'fixture-world', userId: 'gm', clientId: 'fixture', lane: 'gm', isGm: true };
const scope = { worldId: identity.worldId, userId: 'gm', threadId: 'trace' };
const calls = [];
const journals = [];
const client = { listTools: async () => [...CHATKIT_READ_TOOL_METADATA.map(m => ({ name: m.toolId, inputSchema: { type: 'object' } })), ...['foundry_roll_dice', 'foundry_preflight_transaction', 'foundry_execute_transaction'].map(name => ({ name, inputSchema: { type: 'object' } }))], callTool: async (request) => {
        calls.push(request);
        const { name, arguments: input } = request;
        if (name === 'foundry_get_world')
            return { id: identity.worldId, system: 'dnd5e' };
        if (name === 'foundry_list_scenes')
            return [{ _id: 'scene', active: true }];
        if (name === 'foundry_get_scene')
            return { _id: 'scene', active: true, name: 'Hall', tokens: [{ _id: 'hero-token', name: 'Hero', actorId: 'hero', hidden: false }] };
        if (name === 'foundry_get_actor')
            return { _id: 'hero', name: 'Hero', type: 'character', system: { attributes: { hp: { value: 10, max: 10 }, ac: { value: 14 } } } };
        if (name === 'foundry_get_system')
            return { id: 'dnd5e', version: '6.0.3' };
        if (name === 'foundry_list_combats')
            return [];
        if (name === 'foundry_roll_dice')
            return { formula: input.formula, total: 7, result: '4 + 3', dice: [{ faces: 6, results: [4] }] };
        if (name === 'foundry_preflight_transaction')
            return { valid: true, transactionId: input.correlationId };
        if (name === 'foundry_execute_transaction') {
            const operation = input.operations[0];
            journals.push(operation.data);
            return { transactionId: input.correlationId, idempotencyKey: input.idempotencyKey, committed: true, operations: [{ operationId: 'session-note', kind: 'document.create', documentType: 'JournalEntry', documentId: operation.data._id, revision: 'a'.repeat(64) }] };
        }
        throw Error('Unreviewed ' + name);
    } };
const authorize = async (p) => { assert.equal(p.worldId, identity.worldId); assert.equal(p.isGm, true); };
try {
    const campaignPath = join(root, identity.worldId, 'data', 'campaign');
    mkdirSync(campaignPath, { recursive: true });
    writeFileSync(join(campaignPath, 'room.md'), '---\nfoundry_scene_id: scene\n---\n# Hall\n## PLAYER-VISIBLE\nA blue lantern shines.\n## GM-ONLY\nSecret dragon password.');
    const actions = new ChatKitNativeActions(client, db, authorize);
    const catalog = new TrustedToolCatalog(new FoundryLocalApiProviderAdapter({ client, providerVersion: 'mock-MCP' }), CHATKIT_READ_TOOL_METADATA, 'mock-MCP');
    const adapter = new ChatKitReadTools(client, authorize, catalog, { internalSecret: 'fixture-only', campaign: new WorldCampaignContext(root), actions });
    const turns = new ChatKitTurns(db);
    const signal = new AbortController().signal;
    const enter = { type: 'threads.custom_action', params: { thread_id: 'trace', action: { payload: { requestId: 'area-fixture', prompt: 'blue lantern' } } } };
    const release = await turns.enter(identity, enter, signal);
    const run = adapter.begin(identity, enter, signal);
    const context = await adapter.execute(run.token, scope, 'context', { query: 'blue lantern' }, signal);
    assert.equal(context.worldId, identity.worldId);
    assert.equal(context.scene.id, 'scene');
    assert.equal(context.rulesSystem.id, 'dnd5e');
    assert.ok(context.campaign.excerpts.some((e) => e.narrationAllowed));
    const visible = context.campaign.excerpts.filter((e) => e.narrationAllowed);
    assert.ok(!JSON.stringify(visible).includes('Secret dragon password'));
    console.log('1 entered keyed-area API fixture; 2 active-world bounded retrieval: source attribution and spoiler metadata present');
    // Narration is an explicitly deterministic provider fixture, not model verification.
    const narration = 'A blue lantern lights the hall. What do you do?';
    assert.ok(narration.includes('lantern'));
    release();
    run.release();
    console.log('3 mocked narration preserves player agency');
    const player = { type: 'threads.add_user_message', params: { thread_id: 'trace' } };
    const done = await turns.enter(identity, player, signal, 'player-fixture');
    const r = adapter.begin(identity, player, signal);
    const roll = await adapter.execute(r.token, scope, 'native_roll', { actionId: 'trace-roll', formula: '1d6+3' }, signal);
    assert.equal(roll.status, 'completed');
    assert.equal(roll.receipt.total, 7);
    const note = await adapter.execute(r.token, scope, 'native_propose_note', { actionId: 'trace-note', title: 'Acceptance fixture', text: 'Observed blue lantern; native fixture roll total 7.' }, signal);
    assert.equal(note.status, 'pending');
    assert.equal(journals.length, 0);
    const receipt = await actions.browser(identity, { threadId: 'trace', actionId: 'trace-note', decision: 'approve' }, signal);
    assert.equal(receipt.status, 'completed');
    assert.equal(journals.length, 1);
    assert.deepEqual(journals[0].ownership, { default: 0 });
    await actions.browser(identity, { threadId: 'trace', actionId: 'trace-note', decision: 'approve' }, signal);
    assert.equal(journals.length, 1);
    const after = await adapter.execute(r.token, scope, 'context', { query: 'blue lantern' }, signal);
    assert.equal(after.nativeActions.filter((a) => a.status === 'completed').length, 2);
    const response = `You rolled ${roll.receipt.total}; the approved private session note was recorded.`;
    assert.match(response, /rolled 7/);
    done();
    r.release();
    await assert.rejects(turns.enter(identity, enter, signal));
    console.log('4 player action; 5 mocked native receipt total7; 6 exact confirmed private JournalEntry once; 7 receipts in next context; mocked coherent response; duplicate event denied');
    console.log('PASS controlled service trace. REAL: TypeScript services, SQLite file, Markdown filesystem/parser/policy. MOCK: authorization principal, MCP Foundry documents/roll/journal, provider narration. SDK/HTTP/browser regression coverage is separate, not this direct-service trace.');
}
finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
}

