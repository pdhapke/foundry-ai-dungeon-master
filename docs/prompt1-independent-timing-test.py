"""Independent offline timing-origin gate, isolates function source without SDK/model."""
import ast
import contextlib
import io
import json
import math
import os
import re
import tempfile
import time
import unittest
import uuid
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "chatkit-server" / "app.py"
class TimingOriginGate(unittest.TestCase):
    def test_caller_elapsed_cannot_override_scope_origin(self):
        tree = ast.parse(APP.read_text(encoding="utf-8"))
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {"trace", "start_latency_scope"}]
        namespace = dict(time=time,uuid=uuid,json=json,re=re,math=math,os=os,Path=Path,LATENCY_DIAGNOSTICS={"writes":0,"dropped":0,"writeDurationMs":0,"maxWriteDurationMs":0})
        exec(compile(ast.Module(body=functions,type_ignores=[]),str(APP),"exec"),namespace)
        with tempfile.TemporaryDirectory() as directory:
            old = os.environ.get("AI_DM_CHATKIT_DATABASE_PATH")
            os.environ["AI_DM_CHATKIT_DATABASE_PATH"] = str(Path(directory)/"store.sqlite")
            try:
                context={"traceId":"12345678-1234-1234-1234-123456789abc"}
                output=io.StringIO()
                with contextlib.redirect_stdout(output):
                    namespace["trace"](context,"first",elapsedMs=999999)
                    namespace["trace"](context,"second",elapsedMs=1)
                rows=[json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(rows[0]["scopeId"],rows[1]["scopeId"])
                self.assertLess(rows[0]["elapsedMs"],1000)
                self.assertGreaterEqual(rows[1]["elapsedMs"],rows[0]["elapsedMs"])
                self.assertEqual(rows[0]["hookDurationMs"],999999)
            finally:
                if old is None: os.environ.pop("AI_DM_CHATKIT_DATABASE_PATH",None)
                else: os.environ["AI_DM_CHATKIT_DATABASE_PATH"]=old
if __name__ == "__main__": unittest.main()
