import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PublicationReviewer } from './publication-review.js';
/** Server-held exact package grants. There is no DM/tool path to issue a grant. */
export class TrustedPreparationReviews {
  constructor(private readonly db: DatabaseSync, private readonly authorize: (caller: PublicationReviewer)=>void) {
    db.exec('CREATE TABLE IF NOT EXISTS preparation_human_grants (id TEXT PRIMARY KEY, scope TEXT NOT NULL, digest TEXT NOT NULL, kind TEXT NOT NULL)');
  }
  private scope(c:PublicationReviewer) { this.authorize(c);if(!c.isGm)throw Error('Review unavailable');return JSON.stringify([c.worldId,c.userId,c.clientId]); }
  approve(caller:PublicationReviewer,digest:string,kind:'native',origin:'browser'|'dm') {
    if(origin!=='browser'||!/^[a-f0-9]{64}$/.test(digest))throw Error('Explicit authenticated GM browser review required');
    const scope=this.scope(caller),id=randomUUID();
    this.db.prepare('INSERT INTO preparation_human_grants(id,scope,digest,kind) VALUES(?,?,?,?)').run(id,scope,digest,kind);
    return id;
  }
  assert(caller:PublicationReviewer,id:string,digest:string,kind:'native') {
    const row=this.db.prepare('SELECT id FROM preparation_human_grants WHERE id=? AND scope=? AND digest=? AND kind=?').get(id,this.scope(caller),digest,kind);
    if(!row)throw Error('Exact trusted human preparation approval required');
  }
}
