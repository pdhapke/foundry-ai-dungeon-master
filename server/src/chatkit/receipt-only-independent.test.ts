import assert from 'node:assert/strict';
import test from 'node:test';
import { routineCompletion } from './routine-completion.js';
const exact = 'Open door RsB12oN5v3LYI1XR in scene 2RJeJKqdpEE4VZPh. Change only that door. Return its confirmed receipt; do not add narration.';
const body = (text: string, attachments: unknown[] = []) => ({type:'threads.add_user_message',params:{input:{content:[{type:'input_text',text}],attachments}}});
void test('independent exact receipt-only request preserves complete door arguments', () => {
  for (const type of ['threads.create','threads.add_user_message'])
    assert.deepEqual(routineCompletion({...body(exact),type}),{version:1,toolName:'foundry_set_door_state',arguments:{scene_id:'2RJeJKqdpEE4VZPh',door_id:'RsB12oN5v3LYI1XR',state:'open'}});
});
void test('independent receipt-only grammar rejects extra intentions and altered restrictive clauses', () => {
  for(const text of [exact+' Retrieve the quest.',exact+' Describe the room.',exact+' Open another door.', '"'+exact+'"',exact.replace('Change only that door.','Change that door and roll dice.'),exact.replace('do not add narration','add narration'),exact.replace('its confirmed receipt','its attempted receipt'),exact.replace('in scene 2RJeJKqdpEE4VZPh','in the current scene'),exact.replace('door RsB12oN5v3LYI1XR','the red door')])
    assert.equal(routineCompletion(body(text)),undefined,text);
  assert.equal(routineCompletion(body(exact,[{id:'attachment'}])),undefined);
  assert.equal(routineCompletion({type:'threads.add_user_message',params:{input:{content:[{type:'input_text',text:exact}],quoted_text:'other instruction'}}}),undefined);
  const multiple=body(exact); multiple.params.input.content.push({type:'input_text',text:'roll 1d20'});
  assert.equal(routineCompletion(multiple),undefined);
});
