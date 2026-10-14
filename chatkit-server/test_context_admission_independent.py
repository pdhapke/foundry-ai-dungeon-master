"""Independent zero-inference admission checks against unchanged native tool schemas."""
import hashlib
import base64
import json
import os
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient

os.environ['AI_DM_CHATKIT_DATABASE_PATH'] = ':memory:'
from app import build_agent, prepared_instructions, create_app, SqliteStore, compact_schema_annotations, model_context_window
from working_context import assemble_input, ContextCapacityError

SCHEMA_BASELINE = '5796a589ba4efbd71b17e50b1d587d4f0853e49a2e8cb3a422d0ad902073cec9'


def tools(model='gpt-5.6-sol'):
    agent = build_agent({'model': model, 'apiKey': 'offline-not-a-credential', 'readRun': {'offline': True}})
    return agent, [{'name': t.name, 'description': t.description, 'parameters': t.params_json_schema} for t in agent.tools]


class IndependentContextAdmissionTests(unittest.TestCase):
    def test_all_native_names_and_typed_parameters_are_preserved(self):
        agent, schemas = tools()
        self.assertEqual(len(agent.tools), 31)
        self.assertEqual(sum(s['name'] == 'foundry_set_token_light' for s in schemas), 1)
        core = [{'name': s['name'], 'parameters': s['parameters']} for s in schemas if s['name'] != 'foundry_set_token_light']
        self.assertEqual(len(core), 30)
        actual = hashlib.sha256(json.dumps(core, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        self.assertEqual(actual, SCHEMA_BASELINE)

    def test_realistic_paired_history_and_reference_layers_fit_fallback(self):
        recent = [
            {'role': 'user', 'content': 'Open door fixture-door in scene fixture-scene. Return its confirmed receipt.'},
            {'type': 'function_call', 'call_id': 'prior-read', 'name': 'foundry_read_scene', 'arguments': '{}'},
            {'type': 'function_call_output', 'call_id': 'prior-read', 'output': json.dumps({'sceneId': 'fixture-scene', 'revision': 'fixture-v1', 'doors': [{'id': 'fixture-door', 'state': 'closed'}]})},
            {'role': 'assistant', 'content': 'The fixture door is closed; no mutation has run.'},
        ]
        snapshot = {'worldId': 'fixture-world', 'userId': 'fixture-gm', 'rulesSystem': {'id': 'dnd5e', 'version': '6.0.3'},
                    'campaignOverview': {'status': 'available', 'visibility': 'gm', 'canonStatus': 'canon', 'text': 'Fixture campaign reference. ' * 50},
                    'scene': {'id': 'fixture-scene', 'tokens': [{'id': 'fixture-token', 'actorId': 'fixture-actor'}]},
                    'combat': None, 'permissionRevision': 'fixture-permission-v1'}
        summary = {'version': 1, 'coverageWatermark': 'prior-turn', 'text': 'Confirmed fixture history. ' * 20}
        for model, window in [('gpt-5.6-sol', 1_050_000), ('unverified-model', 32768), ('gpt-5.4', 65536), ('gpt-5.4-2026-03-05', 65536)]:
            agent, schemas = tools(model)
            layers, evidence = assemble_input(prepared_instructions(), recent, snapshot, summary, window=window, tool_schemas=schemas)
            if model == 'gpt-5.6-sol':
                print(json.dumps({'independentRealisticUnits': evidence['tokenUpperBound'], 'remainingInputUnits': window-8192-evidence['tokenUpperBound'], 'tools': len(schemas)}), flush=True)
            self.assertEqual(agent.model.model, model)
            self.assertGreaterEqual(window - 8192 - evidence['tokenUpperBound'], 2048)
            self.assertEqual(layers[1:5], recent)
            self.assertIn('untrusted_authorized_foundry_snapshot', layers[-1]['content'])
            self.assertIn('untrusted_session_summary', layers[0]['content'])

    def test_large_required_history_is_refused_without_silent_omission(self):
        _, schemas = tools()
        recent = [{'role': 'user', 'content': 'Required history ' * 4000}]
        with self.assertRaises(ContextCapacityError):
            assemble_input(prepared_instructions(), recent, window=32768, tool_schemas=schemas)
        self.assertEqual(len(recent[0]['content']), len('Required history ' * 4000))

    def test_admission_endpoint_is_authenticated_and_never_starts_runner(self):
        store = SqliteStore(':memory:')
        client = TestClient(create_app(store=store, secret='independent-offline-secret'))
        with patch('app.Runner.run_streamed', side_effect=AssertionError('Inference forbidden')) as runner:
            self.assertEqual(client.post('/context-admission', json={'model': 'gpt-5.6-sol'}).status_code, 401)
            headers = {'x-chatkit-secret': 'independent-offline-secret', 'x-chatkit-principal': base64.b64encode(json.dumps({'isGm': True, 'worldId': 'offline-fixture-world', 'userId': 'offline-fixture-gm'}).encode()).decode()}
            self.assertEqual(client.post('/context-admission', json={'model': 'gpt-5.6-sol'}, headers={'x-chatkit-secret': 'independent-offline-secret'}).status_code, 403)
            response = client.post('/context-admission', json={'model': 'gpt-5.6-sol'}, headers=headers)
            self.assertEqual(response.status_code, 200)
            print(json.dumps({'independentPermanentAdmission': response.json()}), flush=True)
            self.assertTrue(response.json()['admissible'])
            self.assertEqual(response.json()['inputCeiling'], 1_050_000 - 8192)
            self.assertEqual(response.json()['reservedToolsAndOutput'], 8192)
            self.assertGreaterEqual(response.json()['remainingInputUnits'], 4096)
            self.assertEqual(client.post('/context-admission', json={'model': 'gpt-5.6-sol', 'window': 999999}, headers=headers).status_code, 400)
            self.assertEqual(client.post('/context-admission', content='x'*513, headers=headers).status_code, 413)
            runner.assert_not_called()
        store.db.close()

    def test_schema_property_named_title_is_not_removed(self):
        schema = {'title': 'annotation', 'type': 'object', 'properties': {'title': {'title': 'annotation', 'type': 'string'}}, 'required': ['title'], 'additionalProperties': False}
        self.assertEqual(compact_schema_annotations(schema), {'type': 'object', 'properties': {'title': {'type': 'string'}}, 'required': ['title'], 'additionalProperties': False})

    def test_schema_literal_objects_keep_title_values(self):
        literals = {'default': {'title': 'literal default', 'nested': {'title': 'nested data'}}, 'const': {'title': 'literal const'}, 'enum': [{'title': 'literal enum'}], 'examples': [{'title': 'literal example'}]}
        schema = {'title': 'schema annotation', 'type': 'object', **literals, 'properties': {'title': {'title': 'field annotation', 'type': 'string', 'default': 'literal title'}}}
        expected = {'type': 'object', **literals, 'properties': {'title': {'type': 'string', 'default': 'literal title'}}}
        self.assertEqual(compact_schema_annotations(schema), expected)
        self.assertIn('title', schema)

    def test_unresolved_protocol_exchange_cannot_be_removed_to_fit(self):
        _, schemas = tools()
        with self.assertRaises(ContextCapacityError):
            assemble_input(prepared_instructions(), [{'type': 'function_call', 'call_id': 'pending', 'name': 'foundry_set_door_state', 'arguments': '{}'}], window=32768, tool_schemas=schemas)

    def test_verified_selected_model_admits_full_transport_sized_snapshot(self):
        _, schemas = tools()
        recent = [{'role': 'user', 'content': 'Setup a forest battle map for me.'}]
        snapshot = {'worldId': 'fixture-world', 'campaignOverview': {'text': 'Required fixture reference ' * 90},
                    'tokens': [{'id': f'fixture-{i}', 'name': 'Fixture token ' * 80} for i in range(15)]}
        self.assertLess(len(json.dumps(snapshot).encode('utf-8')), 24_000)
        with self.assertRaises(ContextCapacityError):
            assemble_input(prepared_instructions(), recent, snapshot, window=32768, tool_schemas=schemas)
        layers, evidence = assemble_input(prepared_instructions(), recent, snapshot,
            window=model_context_window('gpt-5.6-sol'), tool_schemas=schemas)
        self.assertEqual(layers[0], recent[0])
        self.assertEqual(json.loads(layers[-1]['content'])['untrusted_authorized_foundry_snapshot'], snapshot)
        self.assertGreater(evidence['tokenUpperBound'], 32768 - 8192)
        self.assertEqual(model_context_window('unknown-model'), 32768)
        self.assertEqual(model_context_window('gpt-5.6-sol-unverified-alias'), 32768)

    def test_tool_continuation_keeps_full_exchange_with_verified_window(self):
        _, schemas = tools()
        initial = [{'role': 'user', 'content': 'Setup a forest battle map for me.'}]
        _, first = assemble_input(prepared_instructions(), initial, window=32768, tool_schemas=schemas)
        initial[0]['content'] += 'x' * (20652 - first['tokenUpperBound'])
        _, first = assemble_input(prepared_instructions(), initial, window=32768, tool_schemas=schemas)
        self.assertEqual(first['tokenUpperBound'], 20652)
        self.assertLess(first['tokenUpperBound'], 32768 - 8192)
        output = json.dumps({'fixture_recipe': ['Fixture "contract"'] * 120})
        output += ' ' * (3506 - len(output.encode('utf-8')))
        self.assertEqual(len(output.encode('utf-8')), 3506)
        continuation = initial + [
            {'type': 'function_call', 'call_id': 'fixture-recipe', 'name': 'dm_recipe_read', 'arguments': '{"recipe_id":"forest-battlemap"}'},
            {'type': 'function_call_output', 'call_id': 'fixture-recipe', 'output': output},
        ]
        with self.assertRaises(ContextCapacityError):
            assemble_input(prepared_instructions(), continuation, window=32768, tool_schemas=schemas)
        layers, evidence = assemble_input(prepared_instructions(), continuation,
            window=model_context_window('gpt-5.6-sol'), tool_schemas=schemas)
        self.assertEqual(layers, continuation)
        self.assertEqual(evidence['historyItems'], 3)
        print(json.dumps({'independentContinuationUnits': evidence['tokenUpperBound'],
            'permanentUnits': first['tokenUpperBound'], 'oldInputCeiling': 32768 - 8192}), flush=True)


if __name__ == '__main__':
    unittest.main()

