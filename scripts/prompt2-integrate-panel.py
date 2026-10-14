"""Preserve legacy non-UTF8 bytes while making exact scoped ASCII insertions."""
from pathlib import Path
p = Path(__file__).resolve().parents[1] / 'module/src/ai-dungeon-master/application.ts'
raw = p.read_bytes()
edits = [
('import { PlayerObservationPanel } from "./player-observation-panel.js";', 'import { PlayerObservationPanel } from "./player-observation-panel.js";\nimport { CampaignPreparationPanel } from "./preparation-panel.js";'),
('    #playerObservationPanel: PlayerObservationPanel | null = null;', '    #playerObservationPanel: PlayerObservationPanel | null = null;\n    #campaignPreparationPanel: CampaignPreparationPanel | null = null;'),
('        const playerButton =', '''        const setupButton = this.element.querySelector<HTMLButtonElement>('[data-campaign-setup]');
        setupButton?.addEventListener('click', () => { void this.openCampaignSetup().catch(() => this.status('Campaign setup unavailable. Reconnect the intended GM client.')); }, { signal: this.#providerListeners.signal });
        const playerButton ='''),
('    async reviewActions()', '''    async openCampaignSetup() {
        if (!game.user.isGM || game.user.id !== this.#userId || game.world?.id !== this.#worldId || this.#closed) throw new Error('Current GM required');
        const host = this.element.querySelector<HTMLElement>('.ai-dm-campaign-setup'); if (!host) return;
        this.#campaignPreparationPanel?.cancel();
        this.#campaignPreparationPanel = new CampaignPreparationPanel(host, async (input, signal) => {
            if (!game.user.isGM || game.user.id !== this.#userId || game.world?.id !== this.#worldId || this.#closed) throw new Error('Campaign setup scope changed');
            const auth = aiDmController.transport.chatKitHeaders?.(); if (!auth) throw new Error('Reconnect required');
            const response = await fetch(`${gatewayUrl()}/preparation`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ operation: 'interview', input }), signal });
            if (!response.ok) throw new Error('Campaign setup unavailable');
            const body = await response.json();
            if (this.#closed || game.world?.id !== this.#worldId || game.user.id !== this.#userId || body.worldId !== this.#worldId) throw new Error('Campaign setup scope changed');
            return body.result;
        });
        await this.#campaignPreparationPanel.open();
    }
    async reviewActions()'''),
('override async close(options: any = {}) { this.#closed = true;', 'override async close(options: any = {}) { this.#campaignPreparationPanel?.cancel(); this.#closed = true;'),
]
for old, new in edits:
    encoded = old.encode('ascii')
    if raw.count(encoded) != 1:
        raise ValueError('Expected unique scoped panel anchor')
    raw = raw.replace(encoded, new.encode('ascii'), 1)
p.write_bytes(raw)
