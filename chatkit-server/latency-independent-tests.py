"""Independent telemetry tests. Synthetic local diagnostics only, no provider calls."""
import unittest,tempfile,os,json,time,io
from pathlib import Path
from contextlib import redirect_stdout
from unittest.mock import patch
from app import trace,LATENCY_DIAGNOSTICS,start_latency_scope
TRACE='12345678-1234-1234-1234-123456789abc'
class IndependentLatencyTests(unittest.TestCase):
 def test_projection_failure_and_monotonic_clock(self):
  with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'AI_DM_CHATKIT_DATABASE_PATH':str(Path(directory)/'db.sqlite')}),redirect_stdout(io.StringIO()):
   context={'traceId':TRACE};trace(context,'unit-start',arguments='SECRET',providerResponseHash='SECRET',request=True,durationMs=float('nan'),eventType='bad')
   with patch('app.time.time',return_value=-999999):trace(context,'unit-end',durationMs=2.5,outcome='confirmed')
   rows=[json.loads(x) for x in (Path(directory)/'latency-traces.jsonl').read_text().splitlines()]
   self.assertEqual(rows[0]['traceId'],rows[1]['traceId']);self.assertGreaterEqual(rows[1]['elapsedMs'],rows[0]['elapsedMs'])
   self.assertNotIn('SECRET',json.dumps(rows));self.assertNotIn('request',rows[0]);self.assertNotIn('durationMs',rows[0]);self.assertEqual(rows[1]['durationMs'],2.5)
 def test_scope_identity_changes_only_with_origin(self):
  with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'AI_DM_CHATKIT_DATABASE_PATH':str(Path(directory)/'db.sqlite')}),redirect_stdout(io.StringIO()):
   outer={'traceId':TRACE};trace(outer,'outer-before');child=dict(outer);start_latency_scope(child);trace(child,'child');trace(outer,'outer-after')
   rows=[json.loads(x) for x in (Path(directory)/'latency-traces.jsonl').read_text().splitlines()]
   self.assertEqual(rows[0]['scopeId'],rows[2]['scopeId']);self.assertNotEqual(rows[0]['scopeId'],rows[1]['scopeId']);self.assertTrue(all(x['elapsedMs']>=0 for x in rows));self.assertGreaterEqual(rows[2]['elapsedMs'],rows[0]['elapsedMs'])
 def test_write_failure_observable_and_does_not_throw(self):
  dropped=LATENCY_DIAGNOSTICS['dropped']
  with patch.dict(os.environ,{'AI_DM_CHATKIT_DATABASE_PATH':'NUL/db.sqlite'}),redirect_stdout(io.StringIO()):trace({'traceId':TRACE},'unit-failure')
  self.assertGreater(LATENCY_DIAGNOSTICS['dropped'],dropped)
 def test_synthetic_logging_overhead(self):
  with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'AI_DM_CHATKIT_DATABASE_PATH':str(Path(directory)/'db.sqlite')}),redirect_stdout(io.StringIO()):
   before=LATENCY_DIAGNOSTICS.copy();context={'traceId':TRACE};started=time.perf_counter()
   for _ in range(200):trace(context,'unit-overhead',durationMs=1)
   duration=(time.perf_counter()-started)*1000
   result={'synthetic':True,'sampleCount':200,'totalCallerMs':duration,'meanCallerMs':duration/200,'sinkWriteMs':LATENCY_DIAGNOSTICS['writeDurationMs']-before['writeDurationMs'],'limits':'Local temp file + captured stdout; real console/disk overhead unmeasured; no live command latency.'}
   Path('../docs/latency-independent-python-overhead.json').write_text(json.dumps(result,indent=2))
if __name__=='__main__':unittest.main()

