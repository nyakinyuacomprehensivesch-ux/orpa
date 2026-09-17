// ============================================================
//  ORPA GRADING SYSTEM — Full Auth + M-Pesa
// ============================================================

// ========== GRADE CONFIG (from XCEL workbook) ==========
const GRADE_CFG=[
  {g:1,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'ENVIRONMENTAL',def:40}]},
  {g:2,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'ENVIRONMENTAL',def:40}]},
  {g:3,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'ENVIRONMENTAL',def:40}]},
  {g:4,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'SCIENCE',def:40},{n:'C.A.S',def:40},{n:'S/S',def:40}]},
  {g:5,subjects:[{n:'ENGLISH',def:40},{n:'KISWAHILI',def:40},{n:'MATHEMATICS',def:40},{n:'SCIENCE',def:40},{n:'C.A.S',def:40},{n:'S/S',def:40}]},
  {g:6,subjects:[{n:'ENGLISH',def:70},{n:'KISWAHILI',def:70},{n:'MATHEMATICS',def:70},{n:'INTEGRATED',def:70},{n:'AGRICULTURE',def:100},{n:'C.A.S',def:70},{n:'CRE',def:70},{n:'S/S',def:70},{n:'PRE-TECHNICAL',def:100}]},
  {g:7,subjects:[{n:'ENGLISH',def:70},{n:'KISWAHILI',def:70},{n:'MATHEMATICS',def:70},{n:'INTEGRATED',def:70},{n:'AGRICULTURE',def:100},{n:'C.A.S',def:70},{n:'CRE',def:70},{n:'S/S',def:70},{n:'PRE-TECHNICAL',def:100}]},
  {g:8,subjects:[{n:'ENGLISH',def:70},{n:'KISWAHILI',def:70},{n:'MATHEMATICS',def:70},{n:'INTEGRATED',def:70},{n:'AGRICULTURE',def:100},{n:'C.A.S',def:70},{n:'CRE',def:70},{n:'S/S',def:70},{n:'PRE-TECHNICAL',def:100}]},
  {g:9,subjects:[{n:'ENGLISH',def:70},{n:'KISWAHILI',def:70},{n:'MATHEMATICS',def:70},{n:'INTEGRATED',def:70},{n:'AGRICULTURE',def:100},{n:'C.A.S',def:70},{n:'CRE',def:70},{n:'S/S',def:70},{n:'PRE-TECHNICAL',def:100}]}
];
const MAX_LEARNERS=45;
const MPESA_AMOUNT=100; // KSh 100

// KNEC KCSE Grading
const KNEC_GRADES=[
  {pct:84,g:'A',pts:12},{pct:80,g:'A-',pts:11},{pct:75,g:'B+',pts:10},
  {pct:70,g:'B',pts:9},{pct:65,g:'B-',pts:8},{pct:60,g:'C+',pts:7},
  {pct:55,g:'C',pts:6},{pct:50,g:'C-',pts:5},{pct:45,g:'D+',pts:4},
  {pct:40,g:'D',pts:3},{pct:35,g:'D-',pts:2},{pct:0,g:'E',pts:1}
];
// CBE 8-Level Performance Scale (Kenya CBC/CBE)
// Zone CBE 8-Level Performance / Ranking Scale
const PL_LEVELS=[
  {pct:90,level:8,band:'EE1',desc:'Exceeding Expectations'},
  {pct:75,level:7,band:'EE2',desc:'Exceeding Expectations'},
  {pct:58,level:6,band:'ME1',desc:'Meeting Expectations'},
  {pct:41,level:5,band:'ME2',desc:'Meeting Expectations'},
  {pct:31,level:4,band:'AE1',desc:'Approaching Expectations'},
  {pct:21,level:3,band:'AE2',desc:'Approaching Expectations'},
  {pct:11,level:2,band:'BE1',desc:'Below Expectations'},
  {pct:1,level:1,band:'BE2',desc:'Below Expectations'}
];

function knecGrade(pct){for(const k of KNEC_GRADES)if(pct>=k.pct)return k;return{g:'E',pts:1}}
function plLevel(pct){for(const p of PL_LEVELS)if(pct>=p.pct)return p;return{level:1,band:'BE2',desc:'Below Expectations'}}

// ========== PASSWORD HASHING (client-side, SHA-256) ==========
async function hashPassword(pw){const enc=new TextEncoder().encode(pw);const buf=await crypto.subtle.digest('SHA-256',enc);return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('')}

// ========== SESSION & STATE ==========
let currentUser=null; // logged-in teacher
let currentGrade=1;
let sessionToken=null;

// Local cache + server persistence. localStorage keeps the app responsive/offline;
// the authenticated server copy is the durable source of truth across devices.
function userKey(){return 'orpa_'+currentUser.id}
function globalKey(k){return 'orpa_global_'+k}

let state={examName:'',examTerm:'',examYear:'',grades:{}};
let _remoteSaveTimer=null;
let _remoteReady=false;

function cloneState(obj){return JSON.parse(JSON.stringify(obj))}
function getLocalUserState(){
  try{const s=localStorage.getItem(userKey()+'_data');if(s)return JSON.parse(s)}catch(e){}
  return null;
}
async function loadUserStateFromServer(){
  if(!currentUser || !window.__afApi)return;
  try{
    const remote=await window.__afApi('/api/me/data');
    const local=getLocalUserState();
    if(remote.data){
      // Server copy is the durable source of truth once it exists.
      state=remote.data;
      localStorage.setItem(userKey()+'_data',JSON.stringify(state));
    }else if(local){
      // Migrate existing browser-only work into PostgreSQL once.
      state=local;
      await saveUserStateToServer(true);
    }
    if(!state.grades)state.grades={};
    for(let g=1;g<=9;g++) if(!state.grades[g])state.grades[g]=defaultGrade(g);
    document.getElementById('examName').value=state.examName||'';
    document.getElementById('examTerm').value=state.examTerm||'';
    document.getElementById('examYear').value=state.examYear||'';
    _remoteReady=true;
    buildSidebar(); renderEntry();
  }catch(e){console.warn('[sync] Could not load server data:',e.message)}
}
async function saveUserStateToServer(immediate=false){
  if(!currentUser || !window.__afApi || (!_remoteReady && !immediate))return;
  try{await window.__afApi('/api/me/data',{method:'PUT',body:JSON.stringify({data:cloneState(state)})})}
  catch(e){console.warn('[sync] Could not save server data:',e.message)}
}
function queueRemoteSave(){
  if(!currentUser || !window.__afApi || !_remoteReady)return;
  clearTimeout(_remoteSaveTimer);
  _remoteSaveTimer=setTimeout(()=>saveUserStateToServer(false),900);
}

function defaultGrade(g){
  const cfg=GRADE_CFG.find(c=>c.g===g);
  const learners=[];
  for(let i=0;i<MAX_LEARNERS;i++) learners.push({adm:'',name:'',raws:cfg.subjects.map(()=>null)});
  return{outOf:cfg.subjects.map(s=>s.def),learners};
}

function loadUserState(){
  try{const s=localStorage.getItem(userKey()+'_data');if(s)state=JSON.parse(s)}catch(e){}
  if(!state.grades)state.grades={};
  for(let g=1;g<=9;g++) if(!state.grades[g]) state.grades[g]=defaultGrade(g);
  document.getElementById('examName').value=state.examName||'';
  document.getElementById('examTerm').value=state.examTerm||'';
  document.getElementById('examYear').value=state.examYear||'';
}
function saveUserState(){
  if(!currentUser)return;
  state.examName=document.getElementById('examName').value;
  state.examTerm=document.getElementById('examTerm').value;
  state.examYear=document.getElementById('examYear').value;
  localStorage.setItem(userKey()+'_data',JSON.stringify(state));
  queueRemoteSave();
}
let _saveTimer=null;
function debounceSave(){clearTimeout(_saveTimer);_saveTimer=setTimeout(()=>{saveUserState();toast('💾 Saved')},800)}

// ========== USER DB (localStorage) ==========
function getUsers(){try{return JSON.parse(localStorage.getItem('orpa_users'))||[]}catch(e){return[]}}
function saveUsers(users){localStorage.setItem('orpa_users',JSON.stringify(users))}
function findUserByEmail(email){return getUsers().find(u=>u.email===email.toLowerCase().trim())}
function findUserById(id){return getUsers().find(u=>u.id===id)}

// ========== PAYMENT DB ==========
function getPayments(){try{return JSON.parse(localStorage.getItem(userKey()+'_payments'))||[]}catch(e){return[]}}
function savePayments(p){localStorage.setItem(userKey()+'_payments',JSON.stringify(p))}
function isGradePaid(grade){
  // TESTING MODE: All grades unlocked for testing
  return true;
  /* Original: const payments=getPayments();return payments.some(p=>p.grade===grade&&p.status==='success') */
}
function getGradePayment(grade){return getPayments().find(p=>p.grade===grade&&p.status==='success')}

// ========== AUTH: REGISTER ==========
function showAuth(which){
  document.getElementById('authRegister').style.display=which==='register'?'flex':'none';
  document.getElementById('authLogin').style.display=which==='login'?'flex':'none';
}

async function doRegister(){
  const name=document.getElementById('regName').value.trim();
  const email=document.getElementById('regEmail').value.trim().toLowerCase();
  const phone=document.getElementById('regPhone').value.trim();
  const school=document.getElementById('regSchool').value.trim();
  const pw=document.getElementById('regPassword').value;
  const confirm=document.getElementById('regConfirm').value;
  const errBox=document.getElementById('regErrorBox');

  // Validation
  if(!name){errBox.textContent='Please enter your full name.';errBox.style.display='block';return}
  if(!email||!email.includes('@')){errBox.textContent='Please enter a valid email address.';errBox.style.display='block';return}
  if(!phone||phone.length<9){errBox.textContent='Please enter a valid phone number (9 digits).';errBox.style.display='block';return}
  if(pw.length<6){errBox.textContent='Password must be at least 6 characters.';errBox.style.display='block';return}
  if(pw!==confirm){errBox.textContent='Passwords do not match.';errBox.style.display='block';return}

  // Check duplicate
  if(findUserByEmail(email)){errBox.textContent='An account with this email already exists.';errBox.style.display='block';return}

  const hash=await hashPassword(pw);
  const users=getUsers();
  const id='T'+Date.now().toString(36)+Math.random().toString(36).substr(2,4);
  users.push({id,name,email,phone:'+254'+phone,school,hash,createdAt:new Date().toISOString()});
  saveUsers(users);

  errBox.style.display='none';
  const successBox=document.createElement('div');
  // Switch to login
  showAuth('login');
  document.getElementById('loginSuccessBox').textContent='Account created! Please sign in.';
  document.getElementById('loginSuccessBox').style.display='block';
  document.getElementById('loginEmail').value=email;
}

// ========== AUTH: LOGIN ==========
async function doLogin(){
  const email=document.getElementById('loginEmail').value.trim().toLowerCase();
  const pw=document.getElementById('loginPassword').value;
  const errBox=document.getElementById('loginErrorBox');
  const sucBox=document.getElementById('loginSuccessBox');

  if(!email||!pw){errBox.textContent='Please enter email and password.';errBox.style.display='block';sucBox.style.display='none';return}

  const user=findUserByEmail(email);
  if(!user){errBox.textContent='No account found with this email.';errBox.style.display='block';sucBox.style.display='none';return}

  const hash=await hashPassword(pw);
  if(hash!==user.hash){errBox.textContent='Incorrect password.';errBox.style.display='block';sucBox.style.display='none';return}

  // Login success
  currentUser=user;
  sessionToken='sess_'+Date.now().toString(36);
  localStorage.setItem('orpa_session',JSON.stringify({userId:user.id,token:sessionToken,ts:Date.now()}));

  errBox.style.display='none';sucBox.style.display='none';
  enterApp();
}

function tryRestoreSession(){
  try{
    const sess=JSON.parse(localStorage.getItem('orpa_session'));
    if(!sess)return false;
    // Session valid for 24 hours
    if(Date.now()-sess.ts>86400000)return false;
    const user=findUserById(sess.userId);
    if(!user)return false;
    currentUser=user;
    sessionToken=sess.token;
    return true;
  }catch(e){return false}
}

function doLogout(){
  // Save current state before logout
  if(currentUser)saveUserState();
  currentUser=null;sessionToken=null;
  localStorage.removeItem('orpa_session');
  document.getElementById('appContainer').classList.remove('active');
  showAuth('login');
  document.getElementById('loginSuccessBox').textContent='You have been signed out.';
  document.getElementById('loginSuccessBox').style.display='block';
}

function togglePw(id,btn){
  const inp=document.getElementById(id);
  if(inp.type==='password'){inp.type='text';btn.textContent='🙈'}
  else{inp.type='password';btn.textContent='👁'}
}

// ========== ENTER APP ==========
async function enterApp(){
  document.getElementById('authRegister').style.display='none';
  document.getElementById('authLogin').style.display='none';
  document.getElementById('appContainer').classList.add('active');

  // Set user info in UI
  document.getElementById('ddName').textContent=currentUser.name;
  document.getElementById('ddEmail').textContent=currentUser.email;
  document.getElementById('userBtnLabel').textContent='👤 '+currentUser.name.split(' ')[0];
  const _sn=document.getElementById('schoolNameTop');if(_sn)_sn.value=currentUser.school||'';

  // Render local cache immediately, then reconcile with PostgreSQL.
  loadUserState();
  buildSidebar();
  renderEntry();
  await loadUserStateFromServer();
}

// ========== SIDEBAR ==========
function buildSidebar(){
  const sb=document.getElementById('sidebar');
  let h='<div class="side-label">Lower Primary</div>';
  [1,2,3].forEach(g=>{h+=`<button class="grade-btn${g===currentGrade?' active':''}" onclick="switchGrade(${g})">Grade ${g}</button>`});
  h+='<div class="sep"></div><div class="side-label">Upper Primary</div>';
  [4,5,6].forEach(g=>{h+=`<button class="grade-btn${g===currentGrade?' active':''}" onclick="switchGrade(${g})">Grade ${g}</button>`});
  h+='<div class="sep"></div><div class="side-label">Junior School</div>';
  [7,8,9].forEach(g=>{h+=`<button class="grade-btn${g===currentGrade?' active':''}" onclick="switchGrade(${g})">Grade ${g}</button>`});

  // Payment status per grade
  h+='<div class="pay-status"><div class="ps-label">Report Access</div>';
  if(isGradePaid(currentGrade)){h+=`<span class="ps-badge paid">✅ Paid — Unlocked</span>`}
  else{h+=`<span class="ps-badge locked">🔒 KSh 100 to unlock</span>`}
  h+='</div>';

  sb.innerHTML=h;
}

function switchGrade(g){
  saveUserState();
  currentGrade=g;
  buildSidebar();
  renderEntry();
  // Switch to entry tab
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelector('.tab-btn[data-view="entry"]').classList.add('active');
  showViewByName('entry');
}

// ========== ENTRY TABLE ==========
function renderEntry(){
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const gd=state.grades[currentGrade];
  const nSubj=cfg.subjects.length;
  const computedAll=computeAll();

  let h='<table class="entry-table" id="entryTbl"><thead>';
  // Row: Subject names + Out Of
  h+='<tr class="r3"><th class="frozen fro-no">NO</th><th class="frozen fro-adm">ADM NO</th><th class="frozen fro-name">LEARNER NAME</th>';
  cfg.subjects.forEach((s,si)=>{
    h+=`<th colspan="4" class="col-group" style="border-left:3px solid var(--g1)">${s.n} <input type="number" min="1" max="100" value="${gd.outOf[si]}" onchange="updateOutOf(${si},this.value)" title="Max marks (1-100)"> /</th>`;
  });
  h+=`<th colspan="4" class="col-group" style="border-left:3px solid var(--blue)">SUMMARY</th>`;
  h+='</tr>';
  // Row: Sub-headers
  h+='<tr class="r4"><th class="frozen fro-no"></th><th class="frozen fro-adm"></th><th class="frozen fro-name"></th>';
  cfg.subjects.forEach((s,si)=>{
    const b=si===0?'border-left:3px solid var(--g1)':'';
    h+=`<th style="${b}">RAW</th><th>%</th><th>P/L</th><th>KNEC</th>`;
  });
  h+=`<th style="border-left:3px solid var(--blue)">AVG %</th><th>Grade</th><th>Pts</th><th>Mean Gr</th>`;
  h+='</tr></thead><tbody>';

  // Data rows
  gd.learners.forEach((lr,i)=>{
    const comp=computedAll[i];
    h+=`<tr data-lr="${i}">`;
    h+=`<td class="frozen fro-no">${lr.name?(i+1):''}</td>`;
    h+=`<td class="frozen fro-adm"><input value="${esc(lr.adm)}" onchange="updAdm(${i},this.value)" placeholder="ADM" style="width:55px;border:none;background:transparent;font-size:10px"></td>`;
    h+=`<td class="frozen fro-name"><input value="${esc(lr.name)}" onchange="updName(${i},this.value)" placeholder="Learner Name" style="width:100%;border:none;background:transparent;font-size:10px;font-weight:600"></td>`;

    cfg.subjects.forEach((s,si)=>{
      const raw=lr.raws[si];
      const pct=comp.pcts[si];
      const pl=comp.pls[si];
      const knec=comp.knecs[si];
      const b=si===0?'subj-first':'';
      const isAbs=raw==='ABS';
      const isOver=raw!==null&&raw!=='ABS'&&parseFloat(raw)>gd.outOf[si];
      h+=`<td class="raw-input ${b}"><input data-lr="${i}" data-sb="${si}" value="${isAbs?'ABS':raw!==null?raw:''}" oninput="updRaw(${i},${si},this)" onblur="finishRaw(${i},${si},this)" ondblclick="this.select()" onkeydown="navKey(event,${i},${si},this)" type="text" inputmode="numeric" placeholder="–" class="${isOver?'over-warning':''}"></td>`;
      h+=`<td class="calc pct ${b}">${pct!==null?pct+'%':''}</td>`;
      const plCls=pl?`pl-${pl}`:'';
      h+=`<td class="calc ${plCls} ${b}" style="font-size:13px;font-weight:800">${pl||''}</td>`;
      const knCls=knec?`knec-${knec}`:'';
      h+=`<td class="calc ${knCls} ${b}">${knec||''}</td>`;
    });

    h+=`<td class="calc summ summ-avg summ-group">${comp.avgPct!==null?comp.avgPct+'%':''}</td>`;
    h+=`<td class="calc summ">${comp.avgGrade||''}</td>`;
    h+=`<td class="calc summ">${comp.totalPts!==null?comp.totalPts:''}</td>`;
    h+=`<td class="calc summ summ-pos">${comp.meanGrade||''}</td>`;
    h+='</tr>';
  });

  // MSS Row
  const mss=computeMSS(computedAll);
  h+='<tr class="mss-row"><td class="frozen fro-no"></td><td class="frozen fro-adm"></td><td class="frozen fro-name">Mean Subject Score</td>';
  cfg.subjects.forEach((s,si)=>{
    const b=si===0?'subj-first':'';
    h+=`<td class="${b}">${mss.rawAvgs[si]!==null?mss.rawAvgs[si]:''}</td>`;
    h+=`<td class="${b}">${mss.pctAvgs[si]!==null?mss.pctAvgs[si]+'%':''}</td>`;
    h+=`<td class="${b}">${mss.plModes[si]||''}</td>`;
    h+=`<td class="${b}">${mss.knecAvgs[si]||''}</td>`;
  });
  h+=`<td class="summ-group">${mss.overallAvg!==null?mss.overallAvg+'%':''}</td><td>${mss.overallGrade||''}</td><td>${mss.overallPts||''}</td><td>${mss.overallMean||''}</td>`;
  h+='</tr></tbody></table>';
  document.getElementById('sheetWrap').innerHTML=h;
}

function esc(s){return s?String(s).replace(/"/g,'&quot;'):''}

// ========== COMPUTATION ==========
function computeAll(){
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const gd=state.grades[currentGrade];
  return gd.learners.map(lr=>{
    const pcts=[],pls=[],knecs=[];
    let validPcts=0,sumPcts=0,sumPts=0,validPts=0;
    cfg.subjects.forEach((s,si)=>{
      const raw=lr.raws[si];
      if(raw===null||raw===''||raw==='ABS'){pcts.push(null);pls.push(null);knecs.push(null);return}
      const r=parseFloat(raw);
      if(isNaN(r)||r<0){pcts.push(null);pls.push(null);knecs.push(null);return}
      const o=gd.outOf[si];
      const pct=o>0?Math.round(r/o*1000)/10:0;
      pcts.push(pct);
      const pl=pct>=0?plLevel(pct):null;
      pls.push(pl?pl.level:null);
      const kg=pct>=0?knecGrade(pct):null;
      knecs.push(kg?kg.g:null);
      if(kg){sumPts+=kg.pts;validPts++}
      validPcts++;sumPcts+=pct;
    });
    const avgPct=validPcts>0?Math.round(sumPcts/validPcts*10)/10:null;
    const avgGrade=avgPct!==null?knecGrade(avgPct).g:null;
    const totalPts=validPts>0?sumPts:null;
    const meanGrade=avgPct!==null?knecGrade(avgPct).g:null;
    const avgPL=avgPct!==null?plLevel(avgPct).level:null;return{pcts,pls,knecs,avgPct,avgGrade,avgPL,totalPts,meanGrade};
  });
}

function computeMSS(computedAll){
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const gd=state.grades[currentGrade];
  const rawAvgs=[],pctAvgs=[],plModes=[],knecAvgs=[];
  cfg.subjects.forEach((s,si)=>{
    let rawSum=0,rawN=0,pctSum=0,pctN=0;
    const plCounts={1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0};
    let knecPtsSum=0,knecPtsN=0;
    gd.learners.forEach((lr,li)=>{
      const raw=lr.raws[si];
      if(raw!==null&&raw!==''&&raw!=='ABS'){const r=parseFloat(raw);if(!isNaN(r)&&r>=0){rawSum+=r;rawN++}}
      const pct=computedAll[li].pcts[si];
      if(pct!==null){pctSum+=pct;pctN++}
      const pl=computedAll[li].pls[si];if(pl)plCounts[pl]=(plCounts[pl]||0)+1;
      const kg=computedAll[li].knecs[si];if(kg){const k=KNEC_GRADES.find(kk=>kk.g===kg);if(k){knecPtsSum+=k.pts;knecPtsN++}}
    });
    rawAvgs.push(rawN>0?Math.round(rawSum/rawN*10)/10:null);
    pctAvgs.push(pctN>0?Math.round(pctSum/pctN*10)/10:null);
    let modePL=null,maxC=0;for(const[lvl,cnt]of Object.entries(plCounts)){if(cnt>maxC){maxC=cnt;modePL=lvl}}
    plModes.push(modePL||null);
    knecAvgs.push(knecPtsN>0?knecGrade(Math.round(knecPtsSum/knecPtsN*10)/10).g:null);
  });
  let allPcts=[];computedAll.forEach(c=>{if(c.avgPct!==null)allPcts.push(c.avgPct)});
  const overallAvg=allPcts.length>0?Math.round(allPcts.reduce((a,b)=>a+b,0)/allPcts.length*10)/10:null;
  const overallGrade=overallAvg?knecGrade(overallAvg).g:null;
  let allPts=[];computedAll.forEach(c=>{if(c.totalPts!==null)allPts.push(c.totalPts)});
  const overallPts=allPts.length>0?allPts.reduce((a,b)=>a+b,0):null;
  const overallMean=overallAvg?knecGrade(overallAvg).g:null;
  return{rawAvgs,pctAvgs,plModes,knecAvgs,overallAvg,overallGrade,overallPts,overallMean};
}

function computePositions(computedAll){
  const gd=state.grades[currentGrade];
  return gd.learners.map((lr,i)=>({i,avg:computedAll[i].avgPct,name:lr.name,adm:lr.adm}))
    .filter(x=>x.name&&x.avg!==null)
    .sort((a,b)=>b.avg-a.avg)
    .map((x,idx,arr)=>({...x,pos:idx>0&&arr[idx-1].avg===x.avg?arr[idx-1].pos:idx+1}));
}

// ========== INPUT HANDLERS ==========
function updName(i,v){state.grades[currentGrade].learners[i].name=v.trim();debounceSave();renderEntry()}
function updAdm(i,v){state.grades[currentGrade].learners[i].adm=v.trim();debounceSave()}
function updRaw(i,si,el){
  // Saves data only — NO re-render so user can keep typing multi-digit numbers
  const gd=state.grades[currentGrade];
  let v=el.value.trim();
  if(v===''){gd.learners[i].raws[si]=null;debounceSave();return}
  if(v.toUpperCase()==='ABS'||v.toUpperCase()==='A'){gd.learners[i].raws[si]='ABS';debounceSave();return}
  let num=parseFloat(v);
  if(isNaN(num)){gd.learners[i].raws[si]=null}
  else{
    if(num<0)num=0;
    if(num>100){num=100;el.value='100'} // cap at 100
    gd.learners[i].raws[si]=num;
  }
  debounceSave();
}

function finishRaw(i,si,el){
  // Called on blur — saves, re-renders, then focuses pending cell (e.g. after Tab)
  updRaw(i,si,el);
  renderEntry();
  if(window._pendingFocus){
    const pf=window._pendingFocus;
    window._pendingFocus=null;
    setTimeout(()=>focusCell(pf.i,pf.si),0);
  }
}
function updateOutOf(si,v){
  const gd=state.grades[currentGrade];
  let n=parseInt(v);if(isNaN(n)||n<1)n=1;if(n>100)n=100;
  gd.outOf[si]=n;debounceSave();renderEntry();
}

// ========== KEYBOARD NAVIGATION ==========
function navKey(e,i,si,el){
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const nSubj=cfg.subjects.length;
  if(e.key==='Tab'||e.key==='Enter'){
    e.preventDefault();
    const back=e.shiftKey;
    let ni=i,nsi=si;
    if(back){if(si>0)nsi=si-1;else if(i>0){ni=i-1;nsi=nSubj-1}}
    else{if(si<nSubj-1)nsi=si+1;else if(i<MAX_LEARNERS-1){ni=i+1;nsi=0}}
    window._pendingFocus={i:ni,si:nsi};
    el.blur(); // triggers onblur → finishRaw → renderEntry → auto-focus pending cell
    return;
  }
  if(e.key==='ArrowDown'){e.preventDefault();window._pendingFocus={i:i+1,si};el.blur();return}
  if(e.key==='ArrowUp'){e.preventDefault();window._pendingFocus={i:i-1,si};el.blur();return}
  if(e.key==='ArrowRight'&&e.ctrlKey){e.preventDefault();window._pendingFocus={i,si:si+1};el.blur();return}
  if(e.key==='ArrowLeft'&&e.ctrlKey){e.preventDefault();window._pendingFocus={i,si:si-1};el.blur();return}
}
function focusCell(i,si){
  const el=document.querySelector(`input[data-lr="${i}"][data-sb="${si}"]`);
  if(el)el.focus();
}

// ========== VIEW SWITCHING ==========
function showView(v,btn){
  saveUserState();
  const panels=['viewEntry','viewScoresheet','viewReports','viewKPI','viewProfile','viewPayments'];
  panels.forEach(p=>document.getElementById(p).style.display='none');
  if(btn)document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');

  const map={entry:'viewEntry',scoresheet:'viewScoresheet',reports:'viewReports',kpi:'viewKPI',profile:'viewProfile',payments:'viewPayments'};
  document.getElementById(map[v]).style.display='block';

  if(v==='scoresheet')renderScoresheet();
  if(v==='reports')renderReports();
  if(v==='kpi')renderKPI();
  if(v==='profile')renderProfile();
  if(v==='payments')renderPaymentHistory();
  closeUserDD();
}
function showViewByName(v){
  const map={entry:'viewEntry',scoresheet:'viewScoresheet',reports:'viewReports',kpi:'viewKPI',profile:'viewProfile',payments:'viewPayments'};
  ['viewEntry','viewScoresheet','viewReports','viewKPI','viewProfile','viewPayments'].forEach(p=>document.getElementById(p).style.display='none');
  document.getElementById(map[v]).style.display='block';
}


// ========== ORPA ARCHIVE / FETCH ==========
function archiveSnapshot(){
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const gd=state.grades[currentGrade];
  const computed=computeAll();
  const positions=computePositions(computed);
  const active=gd.learners.filter(l=>l.name||l.adm||l.raws.some(v=>v!==null&&v!==''));
  return {
    grade: currentGrade,
    school: currentUser.school || '',
    examName: state.examName || '',
    examTerm: state.examTerm || '',
    examYear: state.examYear || '',
    subjects: cfg.subjects.map((s,si)=>({name:s.n,outOf:gd.outOf[si]})),
    gradeData: cloneState(gd),
    computed: cloneState(computed),
    positions: cloneState(positions),
    archivedAt: new Date().toISOString(),
    learnerCount: active.length
  };
}

async function archiveCurrentGrade(){
  if(!currentUser || !window.__afApi) return toast('❌ Server connection is not available.');
  const snap=archiveSnapshot();
  const gd=snap.gradeData;
  const active=gd.learners.filter(l=>l.name||l.adm||l.raws.some(v=>v!==null&&v!==''));
  if(!active.length) return toast('❌ Nothing to archive. Enter learner data first.');
  const hasMarks=active.some(l=>l.raws.some(v=>v!==null&&v!==''&&v!=='ABS'));
  if(!hasMarks) return toast('❌ No processed marks found. Enter marks before archiving.');
  const invalid=[];
  gd.learners.forEach((l,ri)=>l.raws.forEach((v,si)=>{
    if(v!==null&&v!==''&&v!=='ABS'&&Number(v)>Number(gd.outOf[si])) invalid.push(`Row ${ri+1}: ${snap.subjects[si].name} ${v}/${gd.outOf[si]}`);
  }));
  if(invalid.length) return alert('Archive blocked. Correct marks above the maximum first:\n\n'+invalid.slice(0,15).join('\n'));
  if(!confirm(`Archive Grade ${currentGrade} (${active.length} learner row(s)) to the secure server?\\n\\nAfter a successful archive, the current entry sheet will be cleared for a fresh assessment.`)) return;
  try{
    toast('⏳ Archiving to server…');
    const d=await window.__afApi('/api/archives',{method:'POST',body:JSON.stringify({archive:{
      grade:snap.grade,school:snap.school,assessment:snap.examName,term:snap.examTerm,year:snap.examYear,data:snap
    }})});
    // Clear only after the server confirms the archive was saved.
    state.grades[currentGrade]=defaultGrade(currentGrade);
    state.examName=''; state.examTerm=''; state.examYear='';
    const en=document.getElementById('examName'), et=document.getElementById('examTerm'), ey=document.getElementById('examYear');
    if(en)en.value=''; if(et)et.value=''; if(ey)ey.value='';
    localStorage.setItem(userKey()+'_data',JSON.stringify(state));
    await saveUserStateToServer(true);
    renderEntry();
    toast('✅ Archived successfully. Entry sheet is fresh and ready.');
  }catch(e){
    toast('❌ Archive failed: '+e.message);
    alert('The archive was NOT cleared because the server did not confirm the save.\\n\\n'+e.message);
  }
}

function closeFetchArchive(){
  const o=document.getElementById('archiveOverlay'); if(o)o.style.display='none';
  const v=document.getElementById('archiveViewer'); if(v){v.style.display='none';v.innerHTML='';}
}
function openFetchArchive(){
  const o=document.getElementById('archiveOverlay'); if(!o)return;
  o.style.display='block';
  const q=document.getElementById('archiveSearch'); if(q){q.value='';setTimeout(()=>q.focus(),50);}
  const v=document.getElementById('archiveViewer'); if(v){v.style.display='none';v.innerHTML='';}
  searchArchives(true);
}
async function searchArchives(latest=false){
  const q=latest?'':((document.getElementById('archiveSearch')||{}).value||'').trim();
  const wrap=document.getElementById('archiveResults'); if(!wrap)return;
  wrap.innerHTML='<div style="padding:15px;text-align:center;color:#667085">Searching secure archive…</div>';
  try{
    const d=await window.__afApi('/api/archives/search?q='+encodeURIComponent(q));
    if(!d.archives.length){wrap.innerHTML='<div style="padding:18px;text-align:center;color:#667085">No archived records found.</div>';return;}
    wrap.innerHTML=d.archives.map(a=>`
      <div class="archive-row">
        <div style="font-weight:800">${esc(a.assessment||'Untitled assessment')} — Grade ${a.grade}</div>
        <div style="font-size:12px;color:#667085">${esc(a.school||'')} · Term ${esc(a.term||'')} · ${esc(a.year||'')} · ${a.learnerCount} learner(s) · ${new Date(a.createdAt).toLocaleString()}</div>
        <button onclick="viewArchive('${encodeURIComponent(a.id)}')">Open archived record</button>
      </div>`).join('');
  }catch(e){wrap.innerHTML='<div style="padding:18px;color:#C62828">❌ '+esc(e.message)+'</div>';}
}
async function viewArchive(id){
  const wrap=document.getElementById('archiveViewer'); if(!wrap)return;
  wrap.style.display='block';wrap.innerHTML='<div style="padding:15px;text-align:center">Loading archived record…</div>';
  try{
    const d=await window.__afApi('/api/archives/'+id); const a=d.archive; const x=a.data||{};
    const gd=x.gradeData||{}; const subjects=x.subjects||[]; const comp=x.computed||[]; const pos=x.positions||[];
    const posMap={};pos.forEach(p=>posMap[p.i]=p.pos);
    let h=`<div style="border-top:2px solid #078BEB;padding-top:14px"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div><h3 style="margin:0">${esc(a.school||'ORPA')}</h3><div style="font-size:12px;color:#667085">Grade ${a.grade} · ${esc(a.assessment||'Assessment')} · Term ${esc(a.term||'')} · ${esc(a.year||'')}</div></div><button class="secondary" onclick="document.getElementById('archiveViewer').style.display='none'">Close record</button></div>`;
    h+=`<div style="overflow:auto;margin-top:12px"><table class="entry-table" style="min-width:760px"><thead><tr><th>POS</th><th>ADM</th><th>LEARNER</th>`;
    subjects.forEach(s=>h+=`<th>${esc(s.name)}<br><small>/ ${s.outOf}</small></th>`);
    h+=`<th>AVG %</th><th>PL</th><th>KNEC</th></tr></thead><tbody>`;
    (gd.learners||[]).forEach((lr,i)=>{
      if(!lr.name&&!lr.adm)return;
      const c=comp[i]||{}; h+=`<tr><td>${posMap[i]||''}</td><td>${esc(lr.adm)}</td><td style="text-align:left;font-weight:700">${esc(lr.name)}</td>`;
      subjects.forEach((s,si)=>{const raw=lr.raws?lr.raws[si]:null; const p=c.pcts?c.pcts[si]:null; const pl=c.pls?c.pls[si]:null; const kg=c.knecs?c.knecs[si]:null; h+=`<td>${raw==='ABS'?'ABS':raw??''}<br><small>${p===null||p===undefined?'':p+'%'} ${pl?'· PL '+pl:''} ${kg?'· '+kg:''}</small></td>`});
      h+=`<td>${c.avgPct??''}</td><td>${c.avgPL??''}</td><td>${c.meanGrade??c.avgGrade??''}</td></tr>`;
    });
    h+=`</tbody></table></div></div>`;
    wrap.innerHTML=h;
    wrap.scrollIntoView({behavior:'smooth',block:'nearest'});
  }catch(e){wrap.innerHTML='<div style="padding:18px;color:#C62828">❌ '+esc(e.message)+'</div>';}
}
// ========== SCORE-SHEET VIEW (MERIT LIST) ==========
function renderScoresheet(){
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const gd=state.grades[currentGrade];
  const computed=computeAll();
  const positions=computePositions(computed);
  const paid=isGradePaid(currentGrade);

  let h=`<div class="scorecard ${paid?'':'lock-overlay'}">`;
  h+=`<h2 style="text-align:center;font-size:16px">${esc(currentUser.school||'My School')}</h2>`;
  h+=`<div style="text-align:center;font-size:11px;color:var(--gray);margin-bottom:8px">Grade ${currentGrade} — Merit / Class List &nbsp;|&nbsp; ${state.examName||'[Exam]'} &nbsp;|&nbsp; Term ${state.examTerm||'__'} &nbsp;|&nbsp; ${state.examYear||'____'}</div>`;
  if(paid)h+=`<button onclick="exportScoresheetExcel()" style="float:right;background:var(--g1);color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;margin-bottom:6px">📥 Export Excel</button><div style="clear:both"></div>`;
  h+=`<table><tr><th>Pos</th><th>ADM</th><th style="text-align:left">Learner</th>`;
  cfg.subjects.forEach(s=>h+=`<th>${s.n}<br><small>P/L (1-8)</small></th>`);
  h+=`<th>AVG P/L</th><th>AVG %</th><th>Grade</th><th>Pts</th></tr>`;

  positions.forEach(x=>{
    const lr=gd.learners[x.i];
    h+=`<tr><td class="bold">${x.pos}</td><td>${esc(lr.adm)}</td><td style="text-align:left;font-weight:600">${esc(lr.name)}</td>`;
    cfg.subjects.forEach((s,si)=>{
      const raw=lr.raws[si];const pl=computed[x.i].pls[si];
      if(raw==='ABS'){h+=`<td style="color:#999;font-size:10px">ABS</td>`;}
      else if(pl){h+=`<td class="pl-${pl}" style="font-weight:800;font-size:16px">${pl}<br><small style="color:#aaa;font-weight:400;font-size:9px">${raw}</small></td>`;}
      else{h+=`<td></td>`;}
    });
    h+=`<td class="pl-${computed[x.i].avgPL}" style="font-weight:800;font-size:16px">${computed[x.i].avgPL||'-'}</td><td class="bold">${x.avg||''}</td><td class="bold">${computed[x.i].avgGrade||''}</td><td>${computed[x.i].totalPts||''}</td></tr>`;
  });
  h+='</table>';

  // Lock overlay if unpaid
  if(!paid){
    h+=`<div class="lock-bg"><div class="lock-icon">🔒</div><div class="lock-msg">Merit list is locked.<br>Pay KSh 100 via M-Pesa to unlock.</div><button class="lock-btn" onclick="openMpesa()">Pay with M-Pesa</button></div>`;
  }
  h+='</div>';
  document.getElementById('viewScoresheet').innerHTML=h;
}

// ========== REPORT CARDS VIEW ==========
function renderReports(){
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const gd=state.grades[currentGrade];
  const computed=computeAll();
  const positions=computePositions(computed);
  const posMap={};positions.forEach(x=>posMap[x.i]=x.pos);
  const paid=isGradePaid(currentGrade);

  let h='';
  let count=0;
  gd.learners.forEach((lr,i)=>{
    if(!lr.name)return;
    count++;
    const comp=computed[i];
    const pos=posMap[i]||'-';
    const locked=!paid;
    h+=`<div class="report-card ${locked?'lock-overlay':''}">
      <div class="school-name">${esc(currentUser.school||'My School')}</div>
      <div class="subtitle">Grade ${currentGrade} Individual Report Card &nbsp;|&nbsp; ${state.examName||'[Exam]'} &nbsp;|&nbsp; Term ${state.examTerm||'__'} &nbsp;|&nbsp; ${state.examYear||'____'}</div>
      <div class="learner-info">
        <div><span class="lbl">Name:</span> ${esc(lr.name)}</div>
        <div><span class="lbl">ADM No:</span> ${esc(lr.adm)}</div>
        <div><span class="lbl">Position:</span> ${pos} out of ${positions.filter(x=>x.name).length}</div>
        <div><span class="lbl">Mean Grade:</span> ${comp.meanGrade||'-'}</div>
      </div>
      <table class="rpt">
        <tr><th>Subject</th><th>Raw</th><th>Out Of</th><th>%</th><th>P/L</th><th>KNEC</th><th>Pts</th><th>Remarks</th></tr>`;
    cfg.subjects.forEach((s,si)=>{
      const raw=lr.raws[si];const pct=comp.pcts[si];const pl=comp.pls[si];const knec=comp.knecs[si];
      const kObj=knec?KNEC_GRADES.find(k=>k.g===knec):null;const pts=kObj?kObj.pts:'';
      const remark=generateRemark(pct,pl);
      h+=`<tr><td class="subj-name">${s.n}</td><td>${raw==='ABS'?'ABS':raw!==null?raw:''}</td><td>${gd.outOf[si]}</td><td>${pct!==null?pct:''}</td><td>${pl||''}</td><td>${knec||''}</td><td>${pts}</td><td style="text-align:left;font-size:9px">${remark}</td></tr>`;
    });
    h+=`<tr class="totals-row"><td style="text-align:left">TOTALS / AVERAGES</td><td></td><td></td><td>${comp.avgPct||''}</td><td style="font-weight:800">${comp.avgPL||''}</td><td>${comp.meanGrade||''}</td><td>${comp.totalPts||''}</td><td></td></tr></table>`;
    h+=`<div class="legend">KNEC: A(84-100=12pts) A-(80-83=11) B+(75-79=10) B(70-74=9) B-(65-69=8) C+(60-64=7) C(55-59=6) C-(50-54=5) D+(45-49=4) D(40-44=3) D-(35-39=2) E(0-34=1)</div>`;
    h+=`<div class="legend">P/L (CBE Levels 1–8): 8=EE1 (90-100%) | 7=EE2 (75-89%) | 6=ME1 (58-74%) | 5=ME2 (41-57%) | 4=AE1 (31-40%) | 3=AE2 (21-30%) | 2=BE1 (11-20%) | 1=BE2 (1-10%)</div>`;
    h+=`<div class="sig-lines"><div>Class Teacher<br>________________</div><div>Head Teacher<br>________________</div><div>Parent/Guardian<br>________________</div></div>`;
    if(!locked)h+=`<button onclick="downloadReportPDF(${i})" style="margin-top:10px;width:100%;padding:8px;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;background:var(--g1);color:#fff">📄 Download PDF</button>`;
    if(locked){
      h+=`<div class="lock-bg"><div class="lock-icon">🔒</div><div class="lock-msg">Report cards are locked.<br>Pay KSh 100 via M-Pesa to download.</div><button class="lock-btn" onclick="openMpesa()">Pay with M-Pesa</button></div>`;
    }
    h+='</div>';
  });
  if(!count)h='<p style="text-align:center;color:#999;margin-top:40px">No learners entered yet. Go to Entry tab to add names and marks.</p>';
  document.getElementById('viewReports').innerHTML=h;
}

function generateRemark(pct,pl){
  if(pct===null||pl===null)return'';
  if(pl>=8)return'Outstanding! Far exceeding expectations.';
  if(pl===7)return'Excellent performance! Keep it up.';
  if(pl===6)return'Good work. Aim higher.';
  if(pl===5)return'Steady progress. Push towards meeting expectations.';
  if(pl===4)return'Approaching target. More effort needed.';
  if(pl===3)return'Below target. Significant effort required.';
  if(pl===2)return'Significant improvement needed. Seek help.';
  if(pl===1)return'Urgent intervention required. Needs close support.';
  return'';
}

// ========== KPI DASHBOARD ==========
function renderKPI(){
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const gd=state.grades[currentGrade];
  const computed=computeAll();
  const positions=computePositions(computed);
  const paid=isGradePaid(currentGrade);
  const active=positions.filter(x=>x.name);
  const nLearners=active.length;

  let avgPcts=active.map(x=>x.avg).filter(v=>v!==null);
  const classAvg=avgPcts.length>0?Math.round(avgPcts.reduce((a,b)=>a+b,0)/avgPcts.length*10)/10:null;
  const classGrade=classAvg?knecGrade(classAvg).g:'-';
  const passRate=avgPcts.length>0?Math.round(avgPcts.filter(p=>p>=50).length/avgPcts.length*1000)/10:null;
  const qualityRate=avgPcts.length>0?Math.round(avgPcts.filter(p=>p>=60).length/avgPcts.length*1000)/10:null;
  const distinctionRate=avgPcts.length>0?Math.round(avgPcts.filter(p=>p>=80).length/avgPcts.length*1000)/10:null;
  const maxScore=avgPcts.length>0?Math.max(...avgPcts):null;
  const minScore=avgPcts.length>0?Math.min(...avgPcts):null;

  const subjStats=cfg.subjects.map((s,si)=>{
    let pcts=[];const plCounts={1:0,2:0,3:0,4:0,5:0,6:0,7:0,8:0};
    gd.learners.forEach((lr,li)=>{
      const raw=lr.raws[si];
      if(raw!==null&&raw!==''&&raw!=='ABS'){const r=parseFloat(raw);if(!isNaN(r)&&r>=0){const pct=gd.outOf[si]>0?Math.round(r/gd.outOf[si]*1000)/10:0;pcts.push(pct);plCounts[plLevel(pct).band]++}}
    });
    const avg=pcts.length>0?Math.round(pcts.reduce((a,b)=>a+b,0)/pcts.length*10)/10:null;
    const hi=pcts.length>0?Math.max(...pcts):null;const lo=pcts.length>0?Math.min(...pcts):null;
    return{n:s.n,avg,hi,lo,plCounts,nLearners:pcts.length,passRate:pcts.length>0?Math.round(pcts.filter(p=>p>=50).length/pcts.length*1000)/10:null};
  });

  let h=`<div style="max-width:880px;margin:0 auto">
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
    <div class="kpi-card"><div class="kpi-big">${nLearners}<small>Enrolled</small></div></div>
    <div class="kpi-card"><div class="kpi-big">${classAvg||'-'}<small>Class Mean %</small></div></div>
    <div class="kpi-card"><div class="kpi-big">${classGrade}<small>Mean Grade</small></div></div>
    <div class="kpi-card"><div class="kpi-big">${passRate!==null?passRate+'%':'-'}<small>Pass Rate (≥C-)</small></div></div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px">
    <div class="kpi-card"><div class="kpi-big">${qualityRate!==null?qualityRate+'%':'-'}<small>Quality (≥C+)</small></div></div>
    <div class="kpi-card"><div class="kpi-big">${distinctionRate!==null?distinctionRate+'%':'-'}<small>Distinction (≥A-)</small></div></div>
    <div class="kpi-card"><div class="kpi-big">${maxScore||'-'} / ${minScore||'-'}<small>Highest / Lowest %</small></div></div>
  </div>`;

  h+=`<div class="scorecard"><h2>Subject-Level Performance</h2><table><tr><th>Subject</th><th>Out Of</th><th>Entries</th><th>Mean %</th><th>Highest</th><th>Lowest</th><th>Pass Rate</th><th>8</th><th>7</th><th>6</th><th>5</th><th>4</th><th>3</th><th>2</th><th>1</th></tr>`;
  subjStats.forEach(s=>{h+=`<tr><td style="text-align:left;font-weight:600;color:var(--g2)">${s.n}</td><td>${gd.outOf[cfg.subjects.findIndex(x=>x.n===s.n)]}</td><td>${s.nLearners}</td><td class="bold">${s.avg||''}</td><td>${s.hi||''}</td><td>${s.lo||''}</td><td>${s.passRate!==null?s.passRate+'%':''}</td><td style="color:#1B5E20;font-weight:800">${s.plCounts[8]||0}</td><td style="color:#2E7D32;font-weight:800">${s.plCounts[7]||0}</td><td style="color:var(--g2);font-weight:700">${s.plCounts[6]||0}</td><td style="color:var(--g2);font-weight:700">${s.plCounts[5]||0}</td><td style="color:var(--orange);font-weight:700">${s.plCounts[4]||0}</td><td style="color:var(--orange);font-weight:700">${s.plCounts[3]||0}</td><td style="color:var(--red);font-weight:800">${s.plCounts[2]||0}</td><td style="color:var(--red);font-weight:800">${s.plCounts[1]||0}</td></tr>`});
  h+='</table></div>';

  const distBands=[
    {label:'Level 8 — EE1 (90-100%)',min:90,max:100,color:'#1B5E20'},
    {label:'Level 7 — EE2 (75-89%)',min:75,max:89,color:'#2E7D32'},
    {label:'Level 6 — ME1 (58-74%)',min:58,max:74,color:'var(--g2)'},
    {label:'Level 5 — ME2 (41-57%)',min:41,max:57,color:'var(--g2)'},
    {label:'Level 4 — AE1 (31-40%)',min:31,max:40,color:'var(--orange)'},
    {label:'Level 3 — AE2 (21-30%)',min:21,max:30,color:'var(--orange)'},
    {label:'Level 2 — BE1 (11-20%)',min:11,max:20,color:'var(--red)'},
    {label:'Level 1 — BE2 (1-10%)',min:0,max:10,color:'var(--red)'}
  ];
  h+=`<div class="scorecard"><h2>CBE Performance Level Distribution</h2><table class="dist-table"><tr><th>CBE Level</th><th>Count</th><th>%</th><th>Distribution</th></tr>`;
  distBands.forEach(b=>{const cnt=avgPcts.filter(p=>p>=b.min&&p<=b.max).length;const pct=nLearners>0?Math.round(cnt/nLearners*1000)/10:0;h+=`<tr><td style="font-weight:800;color:${b.color}">${b.label}</td><td>${cnt}</td><td>${pct}%</td><td><span class="dist-bar" style="width:${Math.max(pct,2)}%;background:${b.color}"></span></td></tr>`});
  h+='</table></div>';
  if(paid)h+=`<div style="text-align:center;margin-top:12px"><button onclick="downloadKPIasPDF()" style="padding:8px 24px;border:none;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;background:var(--g1);color:#fff">📄 Download KPI as PDF</button></div>`;
  h+='</div>';
  document.getElementById('viewKPI').innerHTML=h;
}

// ========== PROFILE VIEW ==========
function renderProfile(){
  const isEditing=window._profileEditing||false;
  let h=`<div class="profile-view">
  <div class="pv-card">
    <h3>👤 Teacher Profile</h3>`;

  if(isEditing){
    // ===== EDIT MODE =====
    h+=`<div class="edit-field"><label>Full Name</label><input id="edName" value="${esc(currentUser.name)}" placeholder="Your full name"></div>`;
    h+=`<div class="edit-field"><label>Email Address</label><input id="edEmail" type="email" value="${esc(currentUser.email)}" readonly title="Email cannot be changed (used as login ID)"></div>`;
    h+=`<div class="edit-field"><label>Phone Number (M-Pesa)</label><div style="display:flex;gap:0;align-items:stretch;border:2px solid #e0e0e0;border-radius:6px;overflow:hidden"><div style="background:var(--g5);padding:0 10px;display:flex;align-items:center;font-size:13px;font-weight:800;color:var(--g1);border-right:2px solid #e0e0e0">🇰🇪 +254</div><input id="edPhone" type="tel" value="${esc(currentUser.phone||'').replace('+254','')}" placeholder="7XX XXX XXX" maxlength="9" style="flex:1;border:none;padding:8px 10px;font-size:13px;outline:none;background:transparent"></div></div>`;
    h+=`<div class="edit-field"><label>School / Institution</label><input id="edSchool" value="${esc(currentUser.school)}" placeholder="Your school name"></div>`;
    // Password change section
    h+=`<div class="pw-change-section"><label style="font-size:10px;font-weight:700;color:var(--orange);text-transform:uppercase;letter-spacing:.5px">🔒 Change Password (leave blank to keep current)</label>`;
    h+=`<div class="edit-field" style="margin-top:6px"><label>Current Password</label><input id="edCurPw" type="password" placeholder="Enter current password"></div>`;
    h+=`<div class="edit-field"><label>New Password</label><input id="edNewPw" type="password" placeholder="Min 6 characters"></div>`;
    h+=`<div class="edit-field"><label>Confirm New Password</label><input id="edConfPw" type="password" placeholder="Re-enter new password"></div></div>`;
    h+=`<div class="profile-actions"><button class="save-btn" onclick="saveProfileEdits()">💾 Save Changes</button><button class="cancel-btn" onclick="cancelProfileEdit()">✖ Cancel</button></div>`;
  } else {
    // ===== VIEW MODE =====
    h+=`<button class="edit-btn" onclick="startProfileEdit()">✏️ Edit Profile</button>`;
    h+=`<div class="pv-row"><span class="pv-label">Full Name</span><span class="pv-val">${esc(currentUser.name)}</span></div>`;
    h+=`<div class="pv-row"><span class="pv-label">Email</span><span class="pv-val">${esc(currentUser.email)} <small style="color:#999">(login ID)</small></span></div>`;
    h+=`<div class="pv-row"><span class="pv-label">Phone</span><span class="pv-val">${esc(currentUser.phone)}</span></div>`;
    h+=`<div class="pv-row"><span class="pv-label">School</span><span class="pv-val">${esc(currentUser.school)}</span></div>`;
    h+=`<div class="pv-row"><span class="pv-label">Account Created</span><span class="pv-val">${new Date(currentUser.createdAt).toLocaleDateString('en-KE')}</span></div>`;
  }
  h+=`</div>`;

  // Report access status card
  h+=`<div class="pv-card"><h3>🔓 Report Access Status</h3>`;
  for(let g=1;g<=9;g++){
    const paid=isGradePaid(g);
    const payment=getGradePayment(g);
    h+=`<div class="pv-row"><span class="pv-label">Grade ${g}</span><span class="pv-val" style="color:${paid?'var(--g1)':'var(--orange)'};font-weight:700">${paid?'✅ Unlocked ('+(payment?payment.txId:'')+')':'🔒 Locked'}</span></div>`;
  }
  h+='</div></div>';
  document.getElementById('viewProfile').innerHTML=h;
}

function startProfileEdit(){
  window._profileEditing=true;
  renderProfile();
}

function cancelProfileEdit(){
  window._profileEditing=false;
  renderProfile();
}

async function saveProfileEdits(){
  const name=document.getElementById('edName').value.trim();
  const phone=document.getElementById('edPhone').value.trim();
  const school=document.getElementById('edSchool').value.trim();
  const curPw=document.getElementById('edCurPw').value;
  const newPw=document.getElementById('edNewPw').value;
  const confPw=document.getElementById('edConfPw').value;

  // Validate basic fields
  if(!name){toast('❌ Name cannot be empty');return}
  if(!phone||phone.length<9){toast('❌ Enter a valid 9-digit phone number');return}
  if(!school){toast('❌ School name cannot be empty');return}

  // Handle password change
  if(curPw||newPw||confPw){
    // User wants to change password — all 3 fields required
    if(!curPw){toast('❌ Enter your current password');return}
    if(!newPw||newPw.length<6){toast('❌ New password must be at least 6 characters');return}
    if(newPw!==confPw){toast('❌ New passwords do not match');return}
    // Verify current password
    const curHash=await hashPassword(curPw);
    if(curHash!==currentUser.hash){toast('❌ Current password is incorrect');return}
    // All good — update password
    const newHash=await hashPassword(newPw);
    currentUser.hash=newHash;
  }

  // Update user object
  currentUser.name=name;
  currentUser.phone='+254'+phone;
  currentUser.school=school;

  // Persist to localStorage user DB
  const users=getUsers();
  const idx=users.findIndex(u=>u.id===currentUser.id);
  if(idx>=0){
    users[idx]={...users[idx],name:currentUser.name,phone:currentUser.phone,school:currentUser.school,hash:currentUser.hash};
    saveUsers(users);
  }

  // Update UI
  document.getElementById('ddName').textContent=currentUser.name;
  document.getElementById('userBtnLabel').textContent='👤 '+currentUser.name.split(' ')[0];
  const _snt=document.getElementById('schoolNameTop');if(_snt)_snt.value=currentUser.school||'';

  window._profileEditing=false;
  renderProfile();
  toast('✅ Profile updated!');
}

// ========== PAYMENT HISTORY VIEW ==========
function renderPaymentHistory(){
  const payments=getPayments();
  let h='<div class="pay-history"><div class="ph-card"><h3>💳 M-Pesa Payment History</h3>';
  if(payments.length===0){h+='<div class="ph-empty">No payments yet. Pay KSh 100 per grade to unlock report downloads.</div>'}
  else{
    h+=`<table><tr><th>TX ID</th><th>Grade</th><th>Phone</th><th>Amount</th><th>Status</th><th>Date</th></tr>`;
    payments.forEach(p=>{h+=`<tr><td>${p.txId}</td><td>Grade ${p.grade}</td><td>${p.phone}</td><td>KSh ${p.amount}</td><td style="color:${p.status==='success'?'var(--g1)':'var(--red)'};font-weight:700">${p.status==='success'?'✅ Success':'❌ '+p.status}</td><td>${new Date(p.date).toLocaleString('en-KE')}</td></tr>`});
    h+='</table>';
  }
  h+='</div></div>';
  document.getElementById('viewPayments').innerHTML=h;
}

// ========== M-PESA PAYMENT FLOW ==========
let mpTimerInterval=null;
let mpTargetGrade=null;

function openMpesa(){
  mpTargetGrade=currentGrade;
  document.getElementById('mpGrade').textContent=mpTargetGrade;
  document.getElementById('mpPhone').value=currentUser.phone?currentUser.phone.replace('+254',''):'';
  mpResetToStep1();
  document.getElementById('mpesaOverlay').classList.add('show');
}

function closeMpesa(){
  document.getElementById('mpesaOverlay').classList.remove('show');
  if(mpTimerInterval){clearInterval(mpTimerInterval);mpTimerInterval=null}
}

function mpResetToStep1(){
  document.getElementById('mpStep1').style.display='block';
  document.getElementById('mpStep2').style.display='none';
  document.getElementById('mpStep3').style.display='none';
  document.getElementById('mpStep4').style.display='none';
  document.getElementById('mpPayBtn').disabled=false;
}

async function initiateMpesa(){
  const phone=document.getElementById('mpPhone').value.trim();
  if(!phone||phone.length<9){alert('Please enter a valid phone number.');return}

  const fullPhone='+254'+phone;
  document.getElementById('mpDisplayPhone').textContent=fullPhone;
  document.getElementById('mpPayBtn').disabled=true;

  /*
   * === PRODUCTION INTEGRATION NOTES ===
   *
   * To connect to real Safaricom Daraja API:
   *
   * 1. Backend endpoint needed (Node.js/Python/PHP) that calls:
   *    POST https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest
   *
   * 2. Headers: Authorization = Bearer <access_token from OAuth>
   * 3. Body: {
   *      BusinessShortCode: "174379",
   *      Password: <Base64(ShortCode+Passkey+Timestamp)>,
   *      Timestamp: "YYYYMMDDHHmmss",
   *      TransactionType: "CustomerPayBillOnline",
   *      Amount: 100,
   *      PartyA: "2547XXXXXXX",
   *      PartyB: "174379",
   *      PhoneNumber: "2547XXXXXXX",
   *      CallBackURL: "https://your-server.com/callback",
   *      AccountReference: "ORPA-GR"+grade,
   *      TransactionDesc: "Grade Report Unlock"
   *    }
   *
   * 4. The callback URL receives payment result from Safaricom
   * 5. Your backend updates payment status
   * 6. Frontend polls your backend (or uses WebSocket) to detect success
   *
   * For this prototype, we simulate the flow below.
   */

  // Switch to STK push waiting step
  document.getElementById('mpStep1').style.display='none';
  document.getElementById('mpStep2').style.display='block';

  // Simulate STK push → user enters PIN → confirmation
  let timeLeft=30;
  document.getElementById('mpTimer').textContent=`0:${timeLeft.toString().padStart(2,'0')}`;
  mpTimerInterval=setInterval(()=>{
    timeLeft--;
    document.getElementById('mpTimer').textContent=`0:${timeLeft.toString().padStart(2,'0')}`;
    if(timeLeft<=0){
      clearInterval(mpTimerInterval);mpTimerInterval=null;
      // Simulate success (80% chance) or timeout (20%)
      if(Math.random()>0.2){
        mpesaPaymentSuccess(fullPhone);
      }else{
        mpesaPaymentFailed('Payment timed out. Please try again.');
      }
    }
  },1000);
}

function mpesaPaymentSuccess(phone){
  if(mpTimerInterval){clearInterval(mpTimerInterval);mpTimerInterval=null}

  const txId='QJK'+Date.now().toString(36).toUpperCase()+Math.random().toString(36).substr(2,4).toUpperCase();
  const now=new Date();

  // Record payment
  const payments=getPayments();
  payments.push({
    txId,grade:mpTargetGrade,phone,amount:MPESA_AMOUNT,status:'success',
    date:now.toISOString(),examName:state.examName,examTerm:state.examTerm,examYear:state.examYear
  });
  savePayments(payments);

  // Update UI to success step
  document.getElementById('mpStep2').style.display='none';
  document.getElementById('mpStep3').style.display='block';
  document.getElementById('mpSuccessGrade').textContent=mpTargetGrade;
  document.getElementById('mpTxId').textContent=txId;
  document.getElementById('mpRxPhone').textContent=phone;
  document.getElementById('mpRxGrade').textContent='Grade '+mpTargetGrade;
  document.getElementById('mpRxAmount').textContent='KSh '+MPESA_AMOUNT;
  document.getElementById('mpRxDate').textContent=now.toLocaleString('en-KE');

  // Refresh sidebar to show paid status
  buildSidebar();
  toast('✅ Payment successful! Reports unlocked.');
}

function mpesaPaymentFailed(msg){
  if(mpTimerInterval){clearInterval(mpTimerInterval);mpTimerInterval=null}

  // Record failed payment
  const payments=getPayments();
  payments.push({
    txId:'FAILED-'+Date.now().toString(36),grade:mpTargetGrade,phone:'',amount:MPESA_AMOUNT,status:'failed',
    date:new Date().toISOString()
  });
  savePayments(payments);

  document.getElementById('mpStep2').style.display='none';
  document.getElementById('mpStep4').style.display='block';
  document.getElementById('mpFailMsg').textContent=msg;
}

function mpesaDownloadNow(){
  closeMpesa();
  // Refresh and print
  renderReports();
  showViewByName('reports');
  setTimeout(()=>window.print(),500);
}

// ========== EXCEL / PDF EXPORT ==========
function exportScoresheetExcel(){
  if(!isGradePaid(currentGrade)){openMpesa();return}
  const cfg=GRADE_CFG.find(c=>c.g===currentGrade);
  const gd=state.grades[currentGrade];
  const computed=computeAll();
  const positions=computePositions(computed);
  // Build AOA (array of arrays)
  const hdr=['Pos','ADM','Learner'];
  cfg.subjects.forEach(s=>hdr.push(s.n+' (P/L)'));
  hdr.push('AVG P/L','AVG %','Grade','Pts');
  const aoa=[hdr];
  positions.forEach(x=>{
    const lr=gd.learners[x.i];
    const row=[x.pos,lr.adm,lr.name];
    cfg.subjects.forEach((s,si)=>{const raw=lr.raws[si];const pl=computed[x.i].pls[si];row.push(raw==='ABS'?'ABS':(pl!==null?pl:''))});
    row.push(computed[x.i].avgPL||'',x.avg||'',computed[x.i].avgGrade||'',computed[x.i].totalPts||'');
    aoa.push(row);
  });
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  // Column widths
  const wch=[{wch:5},{wch:10},{wch:22}];
  cfg.subjects.forEach(()=>wch.push({wch:10}));
  wch.push({wch:8},{wch:8},{wch:8},{wch:6});
  ws['!cols']=wch;
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Grade '+currentGrade);
  XLSX.writeFile(wb,`${schoolSlug()}_Grade${currentGrade}_Scoresheet_${state.examName||'Exam'}_T${state.examTerm||''}_${state.examYear||''}.xlsx`);
  toast('✅ Excel exported!');
}

function downloadReportPDF(learnerIndex){
  if(!isGradePaid(currentGrade)){openMpesa();return}
  const cards=document.querySelectorAll('.report-card');
  if(!cards[learnerIndex])return;
  const el=cards[learnerIndex];
  const lr=state.grades[currentGrade].learners[learnerIndex];
  const filename=`${schoolSlug()}_Grade${currentGrade}_${lr.name||'Learner'}_Report.pdf`;
  html2pdf().set({
    margin:[10,10,10,10],
    filename:filename,
    image:{type:'jpeg',quality:0.95},
    html2canvas:{scale:2,useCORS:true},
    jsPDF:{unit:'mm',format:'a4',orientation:'portrait'}
  }).from(el).save().then(()=>toast('✅ PDF downloaded!')).catch(()=>toast('❌ PDF export failed'));
}

function downloadKPIasPDF(){
  if(!isGradePaid(currentGrade)){openMpesa();return}
  const el=document.getElementById('viewKPI');
  const filename=`${schoolSlug()}_Grade${currentGrade}_KPI_Dashboard.pdf`;
  html2pdf().set({
    margin:[10,10,10,10],
    filename:filename,
    image:{type:'jpeg',quality:0.95},
    html2canvas:{scale:2,useCORS:true},
    jsPDF:{unit:'mm',format:'a4',orientation:'landscape'}
  }).from(el).save().then(()=>toast('✅ KPI PDF downloaded!')).catch(()=>toast('❌ PDF export failed'));
}

// ========== PRINT (checks payment) ==========
function tryPrint(){
  if(!isGradePaid(currentGrade)){
    openMpesa();
    return;
  }
  renderReports();
  showViewByName('reports');
  setTimeout(()=>window.print(),400);
}

// ========== USER DROPDOWN ==========
function toggleUserDD(){
  document.getElementById('userDD').classList.toggle('show');
}
function closeUserDD(){
  document.getElementById('userDD').classList.remove('show');
}
document.addEventListener('click',e=>{
  if(!e.target.closest('.user-menu'))closeUserDD();
});

// ========== SCHOOL NAME (customizable, applies to all grades 1-9) ==========
let _schoolSaveTimer=null;
function updateSchoolName(v){
  if(!currentUser)return;
  currentUser.school=v.trim();
  clearTimeout(_schoolSaveTimer);
  _schoolSaveTimer=setTimeout(()=>{
    const users=getUsers();const idx=users.findIndex(u=>u.id===currentUser.id);
    if(idx>=0){users[idx].school=currentUser.school;saveUsers(users);}
  },500);
}
function schoolSlug(){
  const s=(currentUser&&currentUser.school)?currentUser.school:'School';
  return s.replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'').toUpperCase()||'SCHOOL';
}

// ========== TOAST ==========
function toast(msg){
  const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),1500);
}

// ========== INIT ==========
// When the backend layer (auth-backend.js) is present it controls boot via
// window.__bootApp (async session restore against the server). Only fall back
// to the local-only session restore when running without a backend.
if(!window.__ORPA_BACKEND){
  if(tryRestoreSession()){
    enterApp();
  }else{
    showAuth('login');
  }
}
