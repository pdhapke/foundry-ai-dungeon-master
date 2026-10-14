import sqlite3,json,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
db=root/'.runtime/ai-dungeon-master/chatkit.sqlite'
con=sqlite3.connect(db.as_uri()+'?mode=ro',uri=True)
con.execute('PRAGMA query_only=ON')
cutoff='2026-10-02T15:42:31'
rows=[]
for rowid,body in con.execute('SELECT rowid,body FROM items ORDER BY rowid'):
 item=json.loads(body)
 if item.get('created_at','')[:19] >= cutoff:
  rows.append({'rowid':rowid,'item':item})
con.close()
label=sys.argv[1] if len(sys.argv)>1 else 'initial'
path=root/'docs'/('performance-checkpoint-live-history-'+label+'.json')
path.write_text(json.dumps({'readOnly':True,'cutoff':cutoff,'items':rows},indent=2),encoding='utf-8')
print(json.dumps({'label':label,'newItems':len(rows),'threads':list({r['item'].get('thread_id') for r in rows})}))
