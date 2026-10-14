type Interview = { session: { revision: number; paused: boolean }; questions: Array<{ id: string; question: string }> };
/** Six bounded OOC questions, user initiated; source HTML is never rendered. */
export class CampaignPreparationPanel {
  private readonly lifecycle = new AbortController();
  constructor(private readonly host: HTMLElement, private readonly request: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) {}
  cancel() { this.lifecycle.abort(); }
  async open() { await this.action({ operation: 'start', audience: 'player' }); }
  private async action(input: Record<string, unknown>) {
    this.host.hidden = false;
    const current = await this.request({ sessionId: 'campaign-setup-v1', ...input }, this.lifecycle.signal) as Interview;
    this.lifecycle.signal.throwIfAborted();
    if (!current?.session || !Number.isSafeInteger(current.session.revision) || !Array.isArray(current.questions) || current.questions.length > 3) throw Error('Campaign setup response unavailable');
    this.host.replaceChildren();
    const title = document.createElement('h3'); title.textContent = 'Campaign setup';
    const status = document.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = current.session.paused ? 'Setup paused. Your answers are saved privately.' : current.questions.length ? 'Your setup preferences remain drafts for campaign review.' : 'Setup answers saved. Campaign records still need source preparation and review.';
    this.host.append(title, status);
    const button = (label: string, next: () => Record<string, unknown>) => {
      const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
      element.addEventListener('click', () => { element.disabled = true; void this.action({ expectedRevision: current.session.revision, ...next() }).catch(() => { status.textContent = 'Setup could not be saved. Reconnect and reopen to check the saved revision.'; element.disabled = false; }); }, { signal: this.lifecycle.signal });
      return element;
    };
    if (!current.session.paused) for (const question of current.questions) {
      if (!question || typeof question.id !== 'string' || typeof question.question !== 'string' || question.question.length > 500) throw Error('Invalid setup question');
      const label = document.createElement('label'), field = document.createElement('textarea');
      label.textContent = question.question; field.maxLength = 2000; field.rows = 3; label.append(field);
      this.host.append(label, button('Save preference', () => ({ operation: 'answer', questionId: question.id, text: field.value, mode: 'out-of-character', approved: true })));
    }
    this.host.append(button(current.session.paused ? 'Resume setup' : 'Pause setup', () => ({ operation: current.session.paused ? 'resume' : 'pause' })));
  }
}
