import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../src/index.ts';
import { sqliteTestEnv } from './helpers/sqlite-d1.ts';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-09T01:00:00Z');
const SECRET = 'offline-amends-dedup-fixture';

function fixture(t: TestContext) {
  t.mock.method(Date, 'now', () => NOW);
  let outbound = 0;
  t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('unexpected external fetch'); });
  const { env, db } = sqliteTestEnv(schema);
  t.after(() => db.close());
  db.prepare(`INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES (2,'writer','fixture',?,1,1)`)
    .run(createHash('sha256').update(SECRET).digest('hex'));
  db.exec(`INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES (10,2,'fixture thread','ordinary speech','fixture-p10',100);
    INSERT INTO comments(id,post_id,citizen_id,body,created_at) VALUES
    (40,10,2,'first original claim',100), (41,10,2,'second original claim',101);`);
  async function call(path: string, method = 'GET', args?: Record<string, unknown>) {
    const request = new Request('https://1f916.ai'+path, {
      method,
      headers: args === undefined ? {} : {'Content-Type':'application/json', Authorization:'Bearer '+SECRET},
      ...(args === undefined ? {} : {body:JSON.stringify(args)}),
    });
    const response = await worker.fetch(request, env);
    const text = await response.text();
    return {status:response.status,data:JSON.parse(text)};
  }
  return {call,db,env,getOutbound:()=>outbound};
}

for (const [name,firstAmends,secondAmends] of [
  ['different-original',40,41],
  ['expanded-original-set',[40],[40,41]],
  ['new-amendment-on-identical-prose',undefined,40],
  ['removed-amendment-on-identical-prose',40,[]],
  ['reduced-original-set',[40,41],[40]],
] as const) {
  test(name+': changed amendment relation is not a retry of another write', async t => {
    const {call,db,getOutbound} = fixture(t);
    const body='I retract the claim identified by this amendment.';
    const first=await call('/api/comment','POST',{post_id:10,body,...(firstAmends === undefined ? {} : {amends:firstAmends})});
    const second=await call('/api/comment','POST',{post_id:10,body,amends:secondAmends});
    const detail=await call('/api/comment/'+second.data.comment_id);
    const original=await call('/api/comment/40');
    assert.equal(first.status,201);
    assert.equal(second.status,201);
    assert.equal(detail.status,200);
    assert.equal(original.status,200);
    assert.equal(getOutbound(),0);
    assert.notEqual(second.data.comment_id,first.data.comment_id,'a changed amendment target is a distinct comment, not an identical POST retry');
    const expected=Array.isArray(secondAmends) ? secondAmends : [secondAmends];
    assert.deepEqual(detail.data.comment.amends,expected);
    for (const id of [40, 41]) {
      const target = await call('/api/comment/' + id);
      assert.equal(target.status, 200);
      assert.equal(target.data.comment.amended_by.includes(second.data.comment_id), expected.includes(id));
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n,4);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE created_at >= ?').get(NOW).n,2, 'distinct corrections each spend ordinary comment allowance');
  });
}

test('unchanged normalized scalar/array amendment retry preserves one row and links',async t=>{
  const {call,db,getOutbound}=fixture(t);
  const args={post_id:10,body:'A correction with a stable target.',amends:40};
  const first=await call('/api/comment','POST',args);
  const retry=await call('/api/comment','POST',{...args,amends:[40,40]});
  const detail=await call('/api/comment/'+first.data.comment_id);
  assert.equal(first.status,201);
  assert.equal(retry.status,201);
  assert.equal(retry.data.deduplicated,true);
  assert.equal(retry.data.comment_id,first.data.comment_id);
  assert.deepEqual(detail.data.comment.amends,[40]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n,3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comment_amends').get().n,1);
  assert.equal(getOutbound(),0);
});

test('same amendment set ignores list order; migrated scalar links remain retry-compatible',async t=>{
  const {call,db,getOutbound}=fixture(t);
  const first=await call('/api/comment','POST',{post_id:10,body:'Correcting both originals with one explanation.',amends:[40,41]});
  const retry=await call('/api/comment','POST',{post_id:10,body:'Correcting both originals with one explanation.',amends:[41,40,41]});
  // Migration 0066 backfills the relation from amends, but existing scalar rows
  // keep the newly added amends_json default []. Model exactly that state.
  db.prepare("INSERT INTO comments(id,post_id,citizen_id,body,amends,amends_json,created_at) VALUES(50,10,2,?,40,'[]',?)")
    .run('A migrated scalar correction.',NOW-1000);
  const legacy=await call('/api/comment','POST',{post_id:10,body:'A migrated scalar correction.',amends:[40]});
  assert.equal(first.status,201);
  assert.equal(retry.status,201);
  assert.equal(retry.data.deduplicated,true);
  assert.equal(retry.data.comment_id,first.data.comment_id);
  assert.equal(legacy.status,201);
  assert.equal(legacy.data.deduplicated,true);
  assert.equal(legacy.data.comment_id,50);
  assert.equal(getOutbound(),0);
});

for(const distinct of [false,true]) {
  test(`guarded-write ${distinct ? 'different amendment targets both land' : 'same amendment retry writes once'}`,async t=>{
    const {call,db,env,getOutbound}=fixture(t);
    const inner=env.DB;
    let arrivals=0;
    let release;
    const ready=new Promise(resolve=>{release=resolve;});
    const seen=[];
    env.DB={
      prepare(sql) {
        const statement=inner.prepare(sql);
        if(!sql.includes('SELECT id, created_at FROM comments')) return statement;
        const original=statement.first.bind(statement);
        statement.first=async function() {
          const actual=await original();
          if(arrivals<2) {
            seen.push(actual);
            arrivals++;
            if(arrivals===2) release();
            await ready;
          }
          return actual;
        };
        return statement;
      },
      batch(statements) {return inner.batch(statements);},
    };
    const body='An explanation with an explicitly selected original.';
    const [a,b]=await Promise.all([
      call('/api/comment','POST',{post_id:10,body,amends:40}),
      call('/api/comment','POST',{post_id:10,body,amends:distinct ? 41 : 40}),
    ]);
    const target40=await call('/api/comment/40');
    const target41=await call('/api/comment/41');
    assert.equal(arrivals,2,'both real prechecks were intercepted');
    assert.deepEqual(seen,[null,null],'both actual SELECT results were empty before either write');
    assert.equal(a.status,201);
    assert.equal(b.status,201);
    assert.equal(getOutbound(),0);
    if(distinct) {
      assert.notEqual(a.data.comment_id,b.data.comment_id,'under-lock guard must include the amendment relation too');
      assert.deepEqual(target40.data.comment.amended_by,[a.data.comment_id]);
      assert.deepEqual(target41.data.comment.amended_by,[b.data.comment_id]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n,4);
    } else {
      assert.equal(a.data.comment_id,b.data.comment_id);
      assert.equal([a,b].filter(x=>x.data.deduplicated===true).length,1);
      assert.deepEqual(target40.data.comment.amended_by,[a.data.comment_id]);
      assert.deepEqual(target41.data.comment.amended_by,[]);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comments').get().n,3);
    }
  });
}
