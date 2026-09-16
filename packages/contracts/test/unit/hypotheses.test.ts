import { test } from "bun:test";
import assert from "node:assert/strict";
import { HypothesesQuerySchema, HypothesesResponseSchema, HypothesisPublicationSchema } from "../../src/hypotheses";
import { generateHypothesesSchema } from "../../src/hypotheses-schema";

for (const query of [{through:"1\n"},{after:"01"},{after:"-0"},{through:"9007199254740992"},{after:"2",through:"1"},{liveOnly:true},{limit:"3"}]) {
  test(`reject noncanonical public query ${JSON.stringify(query)}`,()=>assert.equal(HypothesesQuerySchema.safeParse(query).success,false));
}
test("read body uses the published write vocabulary with nullable expected evidence",()=>{
  const body={route:"A route",mechanism:"A mechanism",falsifier:"A test",expected_evidence:null,discriminating_predictions:[],origin:"proposed",body_md:"Work"};
  assert.ok(HypothesisPublicationSchema.safeParse(body).success);
  assert.equal(HypothesisPublicationSchema.safeParse({...body,disposition:"proved"}).success,false);
  assert.equal(HypothesisPublicationSchema.safeParse({...body,falsifier:""}).success,false);
});
test("empty ranges require consistent cursor and continuation accounting",()=>{
  const face={schema:"https://a.asimposium.org/schemas/hypotheses.v1.json",problem_id:"P-DEMO",cursor:0,after:0,hypotheses:[],next_after:null,omitted:[]};
  assert.ok(HypothesesResponseSchema.safeParse(face).success);
  assert.equal(HypothesesResponseSchema.safeParse({...face,next_after:1}).success,false);
  assert.equal(HypothesesResponseSchema.safeParse({...face,omitted:["page_limit"]}).success,false);
});
test("public schema is generated deterministically from Zod, with no clock or caller data",()=>{
  const first=generateHypothesesSchema(); assert.equal(first,generateHypothesesSchema());
  const document=JSON.parse(first); assert.equal(document.$id,"https://a.asimposium.org/schemas/hypotheses.v1.json");
  assert.ok(document.properties.query); assert.ok(document.properties.response);
});
