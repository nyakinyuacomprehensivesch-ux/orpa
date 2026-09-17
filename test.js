/* Finite foreground integration test: spawns the server, runs checks, exits. */
const { spawn } = require('child_process');
const http = require('http');

const PORT = 8123;
const env = Object.assign({}, process.env, {
  PORT: String(PORT), JWT_SECRET: 'testsecret',
  OWNER_EMAIL: 'owner@orpa.local', OWNER_PASSWORD: 'ownerpass123',
});
// fresh data
try { require('fs').unlinkSync(__dirname + '/data/data.json'); } catch (e) {}
try { require('fs').rmSync(__dirname + '/data/emails', { recursive: true, force: true }); } catch (e) {}

const srv = spawn('node', ['server.js'], { cwd: __dirname, env });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stderr.on('data', (d) => { out += d; });

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: 'localhost', port: PORT, path, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => b += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    r.on('error', () => resolve({ status: 0 }));
    if (data) r.write(data); r.end();
  });
}

const results = [];
function check(name, cond, extra) { results.push({ name, ok: !!cond, extra }); console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (cond ? '' : '  >> ' + JSON.stringify(extra))); }

async function run() {
  // wait until server logs it is running (max ~8s)
  for (let i = 0; i < 80; i++) {
    if (out.includes('server running')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
  let x;
  x = await req('GET', '/index.html'); check('static index served', x.status === 200, x.status);
  x = await req('GET', '/admin.html'); check('admin.html served', x.status === 200, x.status);
  x = await req('GET', '/socket.io/socket.io.js'); check('socket.io client served', x.status === 200, x.status);
  x = await req('POST', '/api/register', { name: 'Jane Doe', email: 'jane@test.com', phone: '+254712', school: 'Test', password: 'secret1' });
  check('register teacher (pending approval)', x.status === 201 && x.body.requiresActivation === true, x);
  x = await req('POST', '/api/register', { name: 'Jane', email: 'jane@test.com', password: 'secret1' });
  check('duplicate register blocked (409)', x.status === 409, x.status);
  x = await req('POST', '/api/login', { email: 'jane@test.com', password: 'wrong' });
  check('wrong password rejected (401)', x.status === 401, x.status);
  x = await req('POST', '/api/login', { email: 'jane@test.com', password: 'secret1' });
  check('pending teacher blocked until owner activates (403)', x.status === 403, x.status);
  x = await req('POST', '/api/login', { email: 'owner@orpa.local', password: 'ownerpass123' });
  check('owner login', x.status === 200 && x.body.user.role === 'owner', x.status);
  const oTok = x.body && x.body.token;
  x = await req('POST', '/api/admin/users/' + x.body.user.id + '/activate', null, oTok);
  check('owner approves teacher account', x.status === 200, x.status);
  x = await req('POST', '/api/login', { email: 'jane@test.com', password: 'secret1' });
  check('teacher login request created', x.status === 200 && x.body.requiresApproval === true, x);
  const loginReq = x.body && x.body.requestId;
  x = await req('GET', '/api/admin/login-requests', null, oTok);
  const loginItem = x.body.requests.find(r => r.id === loginReq);
  check('owner sees login authorization request', !!loginItem, x.body);
  x = await req('POST', '/api/admin/login-requests/' + loginReq + '/approve', null, oTok);
  check('owner approves login request', x.status === 200 && x.body.otp, x);
  const otp = x.body.otp;
  x = await req('POST', '/api/login/verify-otp', { requestId: loginReq, otp }, null);
  check('teacher receives session after OTP', x.status === 200 && x.body.token, x);
  const tTok = x.body && x.body.token;
  x = await req('PUT', '/api/me/data', { data: { examName:'End Term', examTerm:'1', examYear:'2026', grades:{'4':{outOf:[40],learners:[{adm:'A001',name:'Jane Doe',raws:[35]}]}} } }, tTok);
  check('teacher persistent data save', x.status === 200, x);
  x = await req('POST', '/api/archives', { archive:{grade:4,school:'Test',assessment:'End Term',term:'1',year:'2026',data:{gradeData:{learners:[{adm:'A001',name:'Jane Doe',raws:[35]}]},subjects:[{name:'English',outOf:40}],computed:[{pcts:[87.5],pls:[8],knecs:['A'],avgPct:87.5,avgPL:8,meanGrade:'A'}],positions:[{i:0,pos:1}]}}}, tTok);
  check('teacher archives processed assessment', x.status === 201 && x.body.archive.id, x);
  x = await req('GET', '/api/archives/search?q=Jane%20Doe', null, tTok);
  check('teacher fetch search by learner name', x.status === 200 && x.body.archives.length === 1, x);
  x = await req('GET', '/api/archives/search?q=A001', null, tTok);
  check('teacher fetch search by ADM', x.status === 200 && x.body.archives.length === 1, x);
  x = await req('GET', '/api/admin/users', null, oTok);
  check('owner lists users', x.status === 200 && x.body.users.length === 2, x.body && x.body.users && x.body.users.length);
  const jid = x.body.users.find((u) => u.email === 'jane@test.com').id;
  x = await req('GET', '/api/admin/users', null, tTok);
  check('teacher blocked from admin (403)', x.status === 403, x.status);
  x = await req('POST', '/api/admin/users/' + jid + '/suspend', { reason: 'Testing suspension email with a custom reason.' }, oTok);
  check('suspend teacher (with reason body)', x.status === 200, x);
  x = await req('GET', '/api/me', null, tTok);
  check('suspended token invalidated (401)', x.status === 401, x.status);
  x = await req('POST', '/api/login', { email: 'jane@test.com', password: 'secret1' });
  check('suspended cannot login (403)', x.status === 403, x.status);
  x = await req('POST', '/api/admin/users/' + jid + '/activate', null, oTok);
  check('reactivate teacher', x.status === 200, x);
  x = await req('POST', '/api/login', { email: 'jane@test.com', password: 'secret1' });
  check('reactivated can login', x.status === 200, x.status);
  const tTok2 = x.body.token;
  x = await req('POST', '/api/admin/users/' + jid + '/logout', null, oTok);
  check('force logout (revoke)', x.status === 200, x);
  x = await req('GET', '/api/me', null, tTok2);
  check('token revoked after force-logout (401)', x.status === 401, x.status);
  x = await req('POST', '/api/admin/users/OWNER/suspend', null, oTok);
  check('cannot suspend owner (400)', x.status === 400, x.status);
  x = await req('DELETE', '/api/admin/users/' + jid, null, oTok);
  check('delete teacher', x.status === 200, x);
  x = await req('GET', '/api/admin/users', null, oTok);
  check('user removed after delete', x.body.users.length === 1, x.body.users.length);

  // Email alerts should have been logged to data/emails/ in fallback mode (no SMTP).
  await new Promise((r) => setTimeout(r, 300));
  let emailFiles = [];
  try { emailFiles = require('fs').readdirSync(__dirname + '/data/emails'); } catch (e) {}
  const htmls = emailFiles.filter((f) => f.endsWith('.html'));
  check('suspension email logged', htmls.some((f) => /Suspended/i.test(f)), htmls);
  check('reactivation email logged', htmls.some((f) => /Reactivated/i.test(f)), htmls);
  check('removal email logged', htmls.some((f) => /Removed/i.test(f)), htmls);
  check('registration email logged', htmls.some((f) => /Awaiting/i.test(f) || /Approval/i.test(f)), htmls);
  check('email files created (>=5)', htmls.length >= 5, htmls.length);

  const failed = results.filter((r) => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' checks passed.');
  if (failed) console.log('--- server output ---\n' + out);
  srv.kill('SIGTERM');
  setTimeout(() => process.exit(failed ? 1 : 0), 300);
}
run();
