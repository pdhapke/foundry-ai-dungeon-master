"""Isolated installed SDK/Runner fixture. Only model is fake; adapter HTTP is real."""
import sys, os, json, uuid
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'chatkit-server'))
import app as production
from agents.models.interface import Model
from openai.types.responses import Response, ResponseCompletedEvent, ResponseOutputItemAddedEvent, ResponseOutputItemDoneEvent, ResponseTextDeltaEvent, ResponseContentPartAddedEvent
import uvicorn

original=production.build_agent
class FixtureModel(Model):
    async def get_response(self,*args,**kwargs):
        raise RuntimeError('Streaming fixture only')
    async def stream_response(self,system_instructions,input,*args,**kwargs):
        # Real Runner chooses/executes function calls and appends actual adapter output.
        data=json.dumps(input)
        outputs=[x for x in input if x.get('type')=='function_call_output']
        snapshot=[x for x in input if 'untrusted_authorized_foundry_snapshot' in str(x)]
        assert snapshot and 'A blue lantern shines.' in json.dumps(snapshot[-1]) and 'room.md' in json.dumps(snapshot[-1]), 'Actual attributed campaign excerpt missing'
        reporting='REPORT_RECEIPTS' in data
        wants_roll='ROLL_AND_NOTE' in data and not reporting
        if wants_roll and not outputs:
            output=[{'id':'fc-roll','type':'function_call','call_id':'call-roll','name':'foundry_roll_dice','arguments':json.dumps({'action_id':'http-roll','formula':'1d6+3'})}]
        elif wants_roll and len(outputs)==1:
            assert 'completed' in outputs[0]['output'] and '7' in outputs[0]['output']
            output=[{'id':'fc-note','type':'function_call','call_id':'call-note','name':'foundry_propose_session_note','arguments':json.dumps({'action_id':'http-note','title':'HTTP SDK acceptance','text':'Native receipt total7.'})}]
        else:
            if reporting:
                parsed=json.loads(snapshot[-1]['content'])['untrusted_authorized_foundry_snapshot']['result']
                receipts=parsed['nativeActions']
                assert sum(x['status']=='completed' for x in receipts)==2
                assert any(x.get('receipt',{}).get('total')==7 for x in receipts)
                assert any(x.get('receipt',{}).get('committed') is True for x in receipts)
                text='Actual receipt total 7; confirmed private journal completed once.'
            elif wants_roll:
                assert 'pending' in outputs[-1]['output']
                text='Actual native fixture receipt total 7; private note awaits confirmation.'
            else:
                text='Authoritative campaign hall received. What do you do?'
            output=[{'id':'msg_'+uuid.uuid4().hex[:12],'type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':text,'annotations':[]}]}]
        response=Response(id='response-fixture',created_at=0,model='mock-fixture',object='response',output=output,parallel_tool_calls=False,tool_choice='auto',tools=[],status='completed')
        item=response.output[0]
        yield ResponseOutputItemAddedEvent(type='response.output_item.added',output_index=0,item=item,sequence_number=1)
        if item.type=='message':
            yield ResponseContentPartAddedEvent(type='response.content_part.added',output_index=0,content_index=0,item_id=item.id,part=item.content[0],sequence_number=2)
            yield ResponseTextDeltaEvent(type='response.output_text.delta',output_index=0,content_index=0,item_id=item.id,delta=item.content[0].text,sequence_number=3,logprobs=[])
        yield ResponseOutputItemDoneEvent(type='response.output_item.done',output_index=0,item=item,sequence_number=4)
        yield ResponseCompletedEvent(type='response.completed',response=response,sequence_number=1)
def build(context):
    agent=original(context);agent.model=FixtureModel();return agent
production.build_agent=build
uvicorn.run(production.create_app(),host='127.0.0.1',port=int(os.environ['PHASE6_PORT']),log_level='error')

