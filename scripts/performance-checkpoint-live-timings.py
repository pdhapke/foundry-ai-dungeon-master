import json
from pathlib import Path
from datetime import datetime
root=Path(__file__).resolve().parents[1]
history=json.loads((root/'docs/performance-checkpoint-live-history-06-combat.json').read_text())['items']
commands=[('pause','2026-10-02T15:45:31.577Z','2026-10-02T15:45:40.740Z'),('door','2026-10-02T15:46:20.569Z','2026-10-02T15:46:34.092Z'),('movement','2026-10-02T15:47:32.195Z','2026-10-02T15:47:50.457Z'),('HP','2026-10-02T15:48:34.032Z','2026-10-02T15:48:50.633Z'),('roll','2026-10-02T15:49:08.931Z','2026-10-02T15:49:21.679Z'),('combat advancement','2026-10-02T15:49:42.252Z','2026-10-02T15:49:54.736Z')]
def dt(s):return datetime.fromisoformat(s.replace('Z','+00:00'))
rows=[]
for i,(command,submit,observed) in enumerate(commands):
 pair,receipt=history[i*2]['item'],history[i*2+1]['item']
 outcome=json.loads(pair['content']['items'][1]['output'])
 rows.append({'command':command,'sampleCount':1,'submitAt':submit,'toolExchangeCreatedAt':pair['created_at'],'receiptCreatedAt':receipt['created_at'],'browserReadyReceiptObservedAt':observed,'submitToToolExchangeCreatedMs':(dt(pair['created_at'])-dt(submit)).total_seconds()*1000,'submitToReceiptCreatedMs':(dt(receipt['created_at'])-dt(submit)).total_seconds()*1000,'submitToBrowserReadyReceiptObservedUpperBoundMs':(dt(observed)-dt(submit)).total_seconds()*1000,'confirmedActionAtMs':outcome.get('stateObservedAtMs'),'outcome':outcome['outcome']})
(root/'docs/performance-checkpoint-live-timings.json').write_text(json.dumps({'samples':rows,'modelRequestLimit':1,'submittedPrompts':6,'automaticEventsEnabled':False,'limits':'Mixed commands one sample each; no distributions. Pair/receipt creation timestamps precede DB commit/delivery. Browser observations are upper bounds, not exact paint. No queue/context/model-to-tool/execution duration traces captured; no separate narration requested.'},indent=2))
print(json.dumps(rows,indent=2))
