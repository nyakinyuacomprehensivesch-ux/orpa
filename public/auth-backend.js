/*
 * ORPA backend integration layer.
 * Loaded AFTER app.js — it overrides the local-only auth functions so the
 * app uses the central server for accounts, and connects a live session
 * (Socket.IO) so the owner can monitor and force-logout users.
 *
 * Grading data is synchronized to the authenticated teacher account on the server
 * so classes, learners and marks survive logout, refresh and a different device.
 */
(function () {
  const API = ''; // same origin
  const TOKEN_KEY = 'orpa_token';

  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); }

  async function api(pathname, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const t = getToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(API + pathname, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    return data;
  }

  // Expose the authenticated API to the grading application.
  window.__orpaApi = api;

  // ---------- Socket / live session ----------
  let socket = null;
  let activityTimer = null;

  function connectSocket() {
    if (typeof io === 'undefined') return; // socket.io client not loaded
    if (socket) { try { socket.disconnect(); } catch (e) {} }
    socket = io({ auth: { token: getToken() } });
    socket.on('force-logout', (info) => {
      const msg = (info && info.reason) || 'Your session was ended by the administrator.';
      hardLogout(msg);
    });
    // Heartbeat so the owner sees "last active" and current grade.
    clearInterval(activityTimer);
    activityTimer = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('activity', { grade: (typeof currentGrade !== 'undefined' ? currentGrade : null) });
      }
    }, 15000);
  }

  function disconnectSocket() {
    clearInterval(activityTimer);
    if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
  }

  function hardLogout(message) {
    disconnectSocket();
    setToken(null);
    currentUser = null;
    try { document.getElementById('appContainer').classList.remove('active'); } catch (e) {}
    showAuth('login');
    const box = document.getElementById('loginSuccessBox');
    if (box) { box.textContent = message || 'You have been signed out.'; box.style.display = 'block'; }
  }

  // ---------- Owner admin link ----------
  function injectAdminLink() {
    if (!currentUser || currentUser.role !== 'owner') return;
    const dd = document.getElementById('userDD');
    if (!dd || dd.querySelector('.dd-admin')) return;
    const item = document.createElement('div');
    item.className = 'dd-item dd-admin';
    item.textContent = '\uD83D\uDEE1\uFE0F Admin Dashboard';
    item.onclick = function () { window.open('admin.html', '_blank'); };
    const header = dd.querySelector('.dd-header');
    if (header && header.nextSibling) dd.insertBefore(item, header.nextSibling);
    else dd.appendChild(item);
  }

  // ---------- Overrides ----------
  doRegister = async function () {
    const name = document.getElementById('regName').value.trim();
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const phone = document.getElementById('regPhone').value.trim();
    const school = document.getElementById('regSchool').value.trim();
    const pw = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirm').value;
    const errBox = document.getElementById('regErrorBox');
    const showErr = (m) => { errBox.textContent = m; errBox.style.display = 'block'; };

    if (!name) return showErr('Please enter your full name.');
    if (!email || !email.includes('@')) return showErr('Please enter a valid email address.');
    if (!phone || phone.length < 9) return showErr('Please enter a valid phone number (9 digits).');
    if (pw.length < 6) return showErr('Password must be at least 6 characters.');
    if (pw !== confirm) return showErr('Passwords do not match.');

    try {
      await api('/api/register', { method: 'POST', body: JSON.stringify({ name, email, phone: '+254' + phone, school, password: pw }) });
      errBox.style.display = 'none';
      showAuth('login');
      const s = document.getElementById('loginSuccessBox');
      s.textContent = 'Account created. Your request has been sent to the administrator for approval. You can sign in after the account is activated.';
      s.style.display = 'block';
      document.getElementById('loginEmail').value = email;
    } catch (e) { showErr(e.message); }
  };

  let pendingLoginTimer = null;
  let pendingLoginId = null;

  function clearPendingLogin() {
    if (pendingLoginTimer) { clearInterval(pendingLoginTimer); pendingLoginTimer = null; }
    pendingLoginId = null;
  }

  function showLoginApproval(requestId, message) {
    clearPendingLogin();
    pendingLoginId = requestId;
    const errBox = document.getElementById('loginErrorBox');
    const sucBox = document.getElementById('loginSuccessBox');
    errBox.style.display = 'none';
    sucBox.style.display = 'block';
    sucBox.innerHTML = `<div style="font-weight:800;margin-bottom:5px">🔐 Administrator approval required</div>
      <div>${message || 'Your credentials were accepted. The administrator must approve this login.'}</div>
      <div id="orpaLoginStage" style="margin-top:8px;font-size:12px">Waiting for approval…</div>
      <div id="orpaOtpBox" style="display:none;margin-top:10px">
        <input id="orpaOtp" inputmode="text" autocomplete="one-time-code" maxlength="6" placeholder="6-character code" style="text-transform:uppercase;letter-spacing:4px;text-align:center;font-weight:800;font-size:18px">
        <button class="auth-btn auth-btn-primary" style="margin-top:8px" onclick="verifyOrpaOtp()">Verify & Sign In</button>
      </div>
      <div style="margin-top:8px"><button type="button" onclick="cancelOrpaLoginWait()" style="background:none;border:0;color:#078BEB;cursor:pointer">Cancel</button></div>`;
    const started = Date.now();
    pendingLoginTimer = setInterval(async () => {
      try {
        const d = await api('/api/login/status/' + encodeURIComponent(requestId));
        const stage = document.getElementById('orpaLoginStage');
        if (!stage) return;
        if (d.request.status === 'approved') {
          clearInterval(pendingLoginTimer); pendingLoginTimer = null;
          stage.textContent = '✅ Approved. Ask the administrator for the 6-character authorization code.';
          const box = document.getElementById('orpaOtpBox'); if (box) box.style.display = 'block';
          const inp = document.getElementById('orpaOtp'); if (inp) { inp.focus(); inp.onkeydown = e => { if(e.key==='Enter') verifyOrpaOtp(); }; }
        } else if (d.request.status === 'denied') {
          clearPendingLogin(); stage.textContent = '❌ The administrator denied this login request.';
        } else if (d.request.status === 'expired') {
          clearPendingLogin(); stage.textContent = '⌛ This request expired. Please sign in again.';
        } else {
          const sec = Math.max(0, 300 - Math.floor((Date.now()-started)/1000));
          stage.textContent = 'Waiting for approval… ' + Math.floor(sec/60) + ':' + String(sec%60).padStart(2,'0');
          if (sec <= 0) clearPendingLogin();
        }
      } catch (e) {
        const stage = document.getElementById('orpaLoginStage'); if(stage) stage.textContent = 'Connection interrupted. Retrying…';
      }
    }, 1800);
  }

  cancelOrpaLoginWait = function () { clearPendingLogin(); const s=document.getElementById('loginSuccessBox'); if(s){s.style.display='none';s.innerHTML='';} };

  verifyOrpaOtp = async function () {
    const otp = (document.getElementById('orpaOtp') || {}).value || '';
    if (!pendingLoginId) return;
    try {
      const data = await api('/api/login/verify-otp', { method:'POST', body: JSON.stringify({ requestId: pendingLoginId, otp }) });
      clearPendingLogin(); setToken(data.token); currentUser = data.user;
      document.getElementById('loginErrorBox').style.display='none'; document.getElementById('loginSuccessBox').style.display='none';
      enterApp(); injectAdminLink(); connectSocket();
    } catch(e) {
      const stage=document.getElementById('orpaLoginStage'); if(stage){stage.textContent='❌ '+e.message;stage.style.color='#C62828';}
    }
  };

  doLogin = async function () {
    clearPendingLogin();
    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const pw = document.getElementById('loginPassword').value;
    const errBox = document.getElementById('loginErrorBox');
    const sucBox = document.getElementById('loginSuccessBox');
    if (!email || !pw) { errBox.textContent = 'Please enter email and password.'; errBox.style.display = 'block'; sucBox.style.display = 'none'; return; }
    try {
      const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password: pw }) });
      if (data.requiresApproval) {
        showLoginApproval(data.requestId, data.message);
        return;
      }
      setToken(data.token); currentUser = data.user;
      errBox.style.display = 'none'; sucBox.style.display = 'none';
      enterApp(); injectAdminLink(); connectSocket();
    } catch (e) {
      errBox.textContent = e.message; errBox.style.display = 'block'; sucBox.style.display = 'none';
    }
  };

  doLogout = async function () {
    if (currentUser) { try { saveUserState(); await saveUserStateToServer(true); } catch (e) {} }
    try { await api('/api/logout', { method: 'POST' }); } catch (e) {}
    hardLogout('You have been signed out.');
  };

  updateSchoolName = function (v) {
    if (!currentUser) return;
    currentUser.school = v.trim();
    clearTimeout(window._afSchoolTimer);
    window._afSchoolTimer = setTimeout(() => {
      api('/api/me/school', { method: 'PATCH', body: JSON.stringify({ school: currentUser.school }) }).catch(() => {});
    }, 600);
  };

  saveProfileEdits = async function () {
    const name = document.getElementById('edName').value.trim();
    const phone = document.getElementById('edPhone').value.trim();
    const school = document.getElementById('edSchool').value.trim();
    const curPw = document.getElementById('edCurPw').value;
    const newPw = document.getElementById('edNewPw').value;
    const confPw = document.getElementById('edConfPw').value;

    if (!name) return toast('\u274C Name cannot be empty');
    if (!phone || phone.length < 9) return toast('\u274C Enter a valid 9-digit phone number');
    if (!school) return toast('\u274C School name cannot be empty');

    const body = { name, phone: '+254' + phone, school };
    if (curPw || newPw || confPw) {
      if (!curPw) return toast('\u274C Enter your current password');
      if (!newPw || newPw.length < 6) return toast('\u274C New password must be at least 6 characters');
      if (newPw !== confPw) return toast('\u274C New passwords do not match');
      body.currentPassword = curPw; body.newPassword = newPw;
    }
    try {
      const data = await api('/api/me', { method: 'PUT', body: JSON.stringify(body) });
      currentUser = Object.assign(currentUser, data.user);
      document.getElementById('ddName').textContent = currentUser.name;
      document.getElementById('userBtnLabel').textContent = '\uD83D\uDC64 ' + currentUser.name.split(' ')[0];
      const snt = document.getElementById('schoolNameTop'); if (snt) snt.value = currentUser.school || '';
      window._profileEditing = false;
      renderProfile();
      toast('\u2705 Profile updated!');
    } catch (e) { toast('\u274C ' + e.message); }
  };

  // ---------- Boot (async session restore) ----------
  window.__bootApp = async function () {
    const t = getToken();
    if (!t) { showAuth('login'); return; }
    try {
      const data = await api('/api/me');
      currentUser = data.user;
      enterApp();
      injectAdminLink();
      connectSocket();
    } catch (e) {
      setToken(null);
      showAuth('login');
    }
  };

  window.__bootApp();
})();
