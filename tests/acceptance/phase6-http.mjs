/* global console, process, fetch, setTimeout, URL */
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
import { createAiDmApp } from '../../server/src/app.ts';
import { createChatKitGateway } from '../../server/src/chatkit/gateway.ts';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const moduleRoot = fileURLToPath(new URL('../../', import.meta.url));
const pythonInterpreter = join(moduleRoot, 'chatkit-server', '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const fixtureSidecar = fileURLToPath(new URL('./phase6-sidecar.py', import.meta.url));
import { once } from 'node:events';
const campaignPath = join(root, identity.worldId, 'data', 'campaign');
mkdirSync(campaignPath, { recursive: true });
writeFileSync(join(campaignPath, 'room.md'), '---\nfoundry_scene_id: scene\n---\n# Hall\n## PLAYER-VISIBLE\nA blue lantern shines.');
const actions = new ChatKitNativeActions(client, db, authorize);
const catalog = new TrustedToolCatalog(new FoundryLocalApiProviderAdapter({ client, providerVersion: 'mock-MCP' }), CHATKIT_READ_TOOL_METADATA, 'mock-MCP');
const adapter = new ChatKitReadTools(client, authorize, catalog, { internalSecret: 'fixture-only', campaign: new WorldCampaignContext(root), actions });
const gateway = createChatKitGateway({ turns: new ChatKitTurns(db), sidecarUrl: 'http://127.0.0.1:3977', internalSecret: 'fixture-only', allowedOrigins: [], authenticate: () => identity, authorize, resolveAuthorization: async () => ({ apiKey: 'no-real-credential', model: 'mock-fixture' }), beginReadRun: (i, b, s) => adapter.begin(i, b, s), nativeActions: (i, b, s) => actions.browser(i, b, s) });
const server = createAiDmApp({ chatkitHandler: gateway, chatkitReadHandler: adapter.handler, readiness: () => ({ ready: true, details: {} }) }).listen(3976, '127.0.0.1');
await once(server, 'listening');
const python = spawn(pythonInterpreter, [fixtureSidecar], { env: { ...process.env, PHASE6_PORT: '3977', AI_DM_CHATKIT_INTERNAL_SECRET: 'fixture-only', AI_DM_CHATKIT_DATABASE_PATH: join(root, 'chatkit.sqlite'), AI_DM_CHATKIT_READ_URL: 'http://127.0.0.1:3976/internal/chatkit/read' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let diagnostic = '';
python.stderr.on('data', d => { diagnostic += String(d); });
async function post(body, event, path = '/chatkit') {
    const response = await fetch('http://127.0.0.1:3976' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(event ? { 'x-ai-dm-event': event } : {}) }, body: JSON.stringify(body) });
    const text = await response.text();
    assert.equal(response.status, 200, text + ' ' + diagnostic);
    assert.ok(!text.includes('"type":"error"'), text + ' ' + diagnostic);
    return text;
}
try {
    // Bounded readiness backoff for the owned isolated subprocess only.
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            ready = (await fetch('http://127.0.0.1:3977/health')).ok;
            if (ready)
                break;
        }
        catch { /* Owned subprocess is still starting. */ }
        await new Promise(r => setTimeout(r, 250));
    }
    assert.ok(ready, diagnostic);
    const created = await post({ type: 'threads.create', params: { input: { content: [{ type: 'input_text', text: 'blue lantern' }], attachments: [], inference_options: {} } } }, 'http-create');
    const events = created.split('\n').filter(s => s.startsWith('data: ')).map(s => JSON.parse(s.slice(6)));
    const thread = events.find(e => e.type === 'thread.created')?.thread?.id;
    assert.ok(thread, created);
    assert.match(created, /Authoritative campaign hall/);
    console.log('1 REAL gateway HTTP→Python ChatKit SDK SQLite→Runner fake Model→authenticated context adapter HTTP→campaign; streamed stored narration');
    const action = { type: 'threads.custom_action', params: { thread_id: thread, action: { type: 'foundry.context-response', payload: { requestId: 'area-http', prompt: 'ROLL_AND_NOTE blue lantern', context: { sceneId: 'spoof' } } } } };
    const result = await post(action);
    assert.match(result, /Actual native fixture receipt total 7/);
    assert.equal(journals.length, 0);
    assert.equal(calls.filter(c => c.name === 'foundry_roll_dice').length, 1);
    console.log('2 REAL custom action SDK→single Runner actual function tool loop→Node native roll receipt→pending private note');
    const note = await post({ threadId: thread, actionId: 'http-note', decision: 'approve' }, undefined, '/chatkit/actions');
    assert.match(note, /completed/);
    assert.equal(journals.length, 1);
    await post({ threadId: thread, actionId: 'http-note', decision: 'approve' }, undefined, '/chatkit/actions');
    assert.equal(journals.length, 1);
    const followup = await post({ type: 'threads.add_user_message', params: { thread_id: thread, input: { content: [{ type: 'input_text', text: 'REPORT_RECEIPTS blue lantern' }], attachments: [], inference_options: {} } } }, 'http-report');
    assert.match(followup, /confirmed private journal completed once/);
    assert.equal(journals.length, 1);
    const history = await post({ type: 'items.list', params: { thread_id: thread, limit: 50, order: 'asc' } });
    assert.match(history, /Actual native fixture receipt total 7/);
    assert.match(history, /confirmed private journal completed once/);
    const duplicate = await fetch('http://127.0.0.1:3976/chatkit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) });
    assert.equal(duplicate.status, 409);
    console.log('3 REAL authenticated confirmation HTTP→one mocked Foundry transaction; real SDK persisted history; replay409');
    console.log('PASS composed HTTP+installed Python SDK/Runner/function-tools/SQLite+Node boundaries; MODEL and FOUNDRY MCP remain MOCKED; browser/physical hooks/live model not verified.');
}
finally {
    python.kill();
    await once(python, 'exit');
    await new Promise(r => server.close(() => r()));
    db.close();
    rmSync(root, { recursive: true, force: true });
}

