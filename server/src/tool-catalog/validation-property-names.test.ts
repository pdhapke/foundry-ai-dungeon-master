import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { validateArguments } from './validation.js';
import type { AiDmJsonValue } from '@foundry-ai-dungeon-master/shared';

test('advertised Zod record JSON schema validates native document data',()=>{
  const schema=z.toJSONSchema(z.object({data:z.record(z.string(),z.unknown())}).strict(),{target:'draft-7'}) as AiDmJsonValue;
  assert.deepEqual(validateArguments(schema,{data:{name:'Forest',levels:[{_id:'forest-level',background:{src:'approved.png'}}],grid:{size:100}}}),[]);
  assert.ok(validateArguments(schema,{data:[],unexpected:true}).length);
});
test('property name rules are enforced, including unsupported nested keywords',()=>{
  const schema={type:'object',propertyNames:{type:'string',pattern:'^[a-z]+$',maxLength:8},additionalProperties:{}};
  assert.deepEqual(validateArguments(schema,{forest:true}),[]);
  assert.ok(validateArguments(schema,{'Bad-Name':true}).length);
  assert.ok(validateArguments(schema,{toolongname:true}).length);
  assert.ok(validateArguments({type:'object',propertyNames:{unknownConstraint:true}},{forest:true}).length);
});
