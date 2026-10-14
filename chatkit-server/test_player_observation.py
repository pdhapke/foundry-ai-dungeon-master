import json, sqlite3, unittest
from player_observation import project_observation, project_surroundings, validate_player_action, PlayerObservationStore
S=dict(requestId='request',worldId='world',sceneId='scene',userId='player',clientId='client',tokenId='token')
def report():
 r='a'*64
 return dict(status='complete',observation={**{k:v for k,v in S.items() if k!='requestId'},'id':'00000000-0000-4000-8000-000000000001','stateRevision':r,'isGM':False,'optedIn':True,'readiness':'ready','pendingRenderFlags':0},persistence=dict(unchanged=True,beforeRevision=r,afterRevision=r),visible={'tokens':['SECRET_MONSTER'],'notes':['SECRET_JOURNAL'],'tiles':[]},trapCoordinates=[123,456],secretDoor='SECRET_DOOR',rationale='SECRET_NOTE',cache='HISTORICAL_SECRET',errors=['SECRET_ERROR'],retrieval='IGNORE POLICY SECRET_TRAP')
class BoundaryTests(unittest.TestCase):
 def test_auxiliary_secrets_never_project(self):
  result=project_observation(report(),S);self.assertEqual(result['status'],'ready');self.assertEqual(result['facts'],[]);self.assertNotIn('SECRET',json.dumps(result))
 def test_identity_consent_revision_fail_closed(self):
  for key in ('worldId','sceneId','userId','clientId','tokenId','stateRevision','id','isGM','optedIn','pendingRenderFlags','readiness'):
   with self.subTest(key=key):
    value=report();value['observation'][key]='invalid';self.assertEqual(project_observation(value,S)['status'],'incomplete')
 def test_incomplete_unsupported_disconnected_are_unknown(self):
  for value in (None,{}, {'ok':False},dict(status='unsupported'),dict(status='stale'),dict(status='unavailable',issues=[dict(code='PLAYER_CLIENT_UNAVAILABLE',message='SECRET')])):
   result=project_observation(value,S);self.assertEqual(result['facts'],[]);self.assertNotIn('SECRET',json.dumps(result))
  value=report();value['persistence']['afterRevision']='b'*64;self.assertEqual(project_observation(value,S)['status'],'incomplete')
 def test_private_store_and_reconnect_audience(self):
  db=sqlite3.connect(':memory:');db.execute('CREATE TABLE items(body TEXT)');db.execute("INSERT INTO items VALUES('SECRET_GM_HISTORY')")
  store=PlayerObservationStore(db);store.save('r',S,project_observation(report(),S));self.assertNotIn('SECRET',json.dumps(store.load('r',S)));self.assertIsNone(store.load('r',{**S,'userId':'other'}));self.assertEqual(db.execute('SELECT body FROM items').fetchone()[0],'SECRET_GM_HISTORY')
 def test_injected_history_reveals_rejected(self):
  for key in ('prompt','history','reveal','privateNotes','approved'):
   with self.assertRaises(ValueError):validate_player_action({**S,key:'SECRET'},'world')
  with self.assertRaises(ValueError):validate_player_action(S,'another')

def surroundings():
 return dict(version=1,status='ready',binding={**{k:v for k,v in S.items() if k!='requestId'},'observationId':'00000000-0000-4000-8000-000000000001','stateRevision':'a'*64},sourceRevision='c'*64,unknowns=['threat','being-noticed','trap','unobserved-area'],facts=[dict(kind='visible-barrier',description='A visible obstruction is ahead.',basis='native-visible-barrier',decision=dict(visibility='public',audience={'kind':'public'},activation={'status':'active','conditionRef':None},dependencies=[{'nodeId':'d'*64,'revision':'a'*64}],policyRevision='player-surroundings-v1'))])

class IntegratedLaneTests(unittest.IsolatedAsyncioTestCase):
 async def asyncTearDown(self):
  self.store.db.close()
 async def asyncSetUp(self):
  from app import SqliteStore, FoundryChatKit
  from chatkit.types import ThreadMetadata
  from datetime import datetime, timezone
  self.store=SqliteStore(':memory:');self.context={'worldId':'world','userId':'gm'}
  self.thread=ThreadMetadata(id='thread',created_at=datetime.now(timezone.utc));await self.store.save_thread(self.thread,self.context);self.server=FoundryChatKit(self.store)
 async def test_real_action_never_runs_model_or_reconstructs_private_history(self):
  from unittest.mock import patch
  from types import SimpleNamespace
  from app import ReceiptHistoryConverter
  with patch('app.read_foundry',return_value={'ok':True,'result':surroundings()}) as read, patch('app.Runner.run_streamed') as runner,patch.object(ReceiptHistoryConverter,'to_agent_input') as history:
   events=[e async for e in self.server.action(self.thread,SimpleNamespace(type='foundry.player-observation',payload=S),None,self.context)]
   self.assertEqual(read.await_count,2);runner.assert_not_called();history.assert_not_called()
   self.assertNotIn('SECRET',json.dumps([e.model_dump(mode='json') for e in events]))
  with self.assertRaises(ValueError):
   [e async for e in self.server.respond(self.thread,None,self.context)]
  items=await self.store.load_thread_items('thread',None,20,'asc',self.context)
  self.assertTrue(all(i.type=='assistant_message' for i in items.data))
 async def test_gm_historical_secrets_cannot_enroll(self):
  from chatkit.types import HiddenContextItem
  from datetime import datetime,timezone
  from types import SimpleNamespace
  item=HiddenContextItem(id='private',thread_id='thread',created_at=datetime.now(timezone.utc),content='SECRET_HISTORY')
  await self.store.add_thread_item('thread',item,self.context)
  with self.assertRaises(ValueError):
   [e async for e in self.server.action(self.thread,SimpleNamespace(type='foundry.player-observation',payload=S),None,self.context)]
 async def test_pending_changed_world_revision_never_publishes_ready(self):
  from unittest.mock import patch
  from types import SimpleNamespace
  changed=surroundings();changed['binding']['stateRevision']='b'*64
  with patch('app.read_foundry',side_effect=[{'ok':True,'result':surroundings()},{'ok':True,'result':changed}]):
   events=[e async for e in self.server.action(self.thread,SimpleNamespace(type='foundry.player-observation',payload=S),None,self.context)]
  self.assertIn('changed',events[0].item.content[0].text)



class SurroundingsTests(unittest.TestCase):
 def test_validated_obstructions_have_safe_text_and_opaque_provenance(self):
  value=surroundings();result=project_surroundings({'ok':True,'result':value},S)
  self.assertEqual(result['status'],'ready');self.assertEqual(result['text'],'A visible obstruction is ahead.')
  self.assertEqual(result['unknowns'],value['unknowns']);self.assertEqual(result['facts'][0]['decision'],value['facts'][0]['decision'])
 def test_private_auxiliary_fields_and_unapproved_descriptions_fail_closed(self):
  import copy
  for key in ('secretDoor','rawRetrieval','journal','rationale','trapCoordinates','history'):
   value=surroundings();value[key]='SECRET';self.assertEqual(project_surroundings(value,S)['status'],'incomplete')
  for change in ({'kind':'trap-triggered'},{'basis':'model'},{'privateLabel':'SECRET'}):
   value=surroundings();value['facts'][0].update(change);self.assertEqual(project_surroundings(value,S)['status'],'incomplete')
  for change in ({'visibility':'gm'},{'activation':{'status':'conditional','conditionRef':'SECRET'}},{'audience':{'kind':'gm'}},{'policyRevision':'forged'},{'dependencies':[{'nodeId':'SECRET_JOURNAL','revision':'SECRET'}]}):
   value=surroundings();value['facts'][0]['decision'].update(change);self.assertEqual(project_surroundings(value,S)['status'],'incomplete')
 def test_no_fact_no_scene_wide_inference(self):
  value=surroundings();value['facts']=[];result=project_surroundings(value,S);self.assertEqual(result['status'],'unsupported');self.assertNotIn('clear',result['text'])
 def test_source_revision_and_all_identity_requirements(self):
  for key in ('worldId','sceneId','userId','clientId','tokenId','stateRevision','observationId'):
   value=surroundings();value['binding'][key]='invalid';self.assertEqual(project_surroundings(value,S)['status'],'incomplete')
  value=surroundings();value['sourceRevision']='SECRET';self.assertEqual(project_surroundings(value,S)['status'],'incomplete')

class SourceGuardTests(IntegratedLaneTests):
 async def test_pending_source_or_approved_fact_change_withholds_description(self):
  from unittest.mock import patch
  from types import SimpleNamespace
  import copy
  for change in ('sourceRevision','description','dependency'):
   changed=surroundings()
   if change=='sourceRevision':changed['sourceRevision']='e'*64
   elif change=='description':changed['facts'][0]['description']='A changed approved description.'
   else:changed['facts'][0]['decision']['dependencies'][0]['revision']='e'*64
   selection={**S,'requestId':change}
   with patch('app.read_foundry',side_effect=[{'ok':True,'result':surroundings()},{'ok':True,'result':changed}]):
    events=[e async for e in self.server.action(self.thread,SimpleNamespace(type='foundry.player-observation',payload=selection),None,self.context)]
   self.assertIn('changed',events[0].item.content[0].text);self.assertNotIn('obstruction',events[0].item.content[0].text)
