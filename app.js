/** app.js - client-side React (UMD) */
/* NOTE: this file expects:
   - React & ReactDOM global (included in index.html)
   - firebase-app-compat, firebase-auth-compat, firebase-database-compat loaded before this script
   - xlsx (SheetJS) loaded
   - Chart.js loaded
*/

/* ========== Configuration ========== */
/* Use your existing config - I left your existing firebase keys (from your uploaded file).
   You should rotate these keys if they are sensitive; firebase client SDK config is not secret,
   but if this is a real production project, consider server-side validations. */
const firebaseConfig = {
  apiKey: "AIzaSyDn_9J6yhfiGdugCB8EUwNi14QSnXq3Q5M",
  authDomain: "logbot-f502d.firebaseapp.com",
  databaseURL: "https://logbot-f502d-default-rtdb.asia-southeast1.firebasedatabase.app", // <- IMPORTANT: add this
  projectId: "logbot-f502d",
  storageBucket: "logbot-f502d.appspot.com",
  messagingSenderId: "750282755685",
  appId: "1:750282755685:web:d1e221e501ace4112d808c",
  measurementId: "G-CG16LVPW3Y"
};

const VEHICLES = ['69408','69409','69410','69411','69412','69413','69414','69415','69416','69417','69418','69419'];
const OPERATORS = ['Wei Hongpeng','Chen Yanshuo','Jonathan Soo','Gunasekaran Yoganth'];

/* Optional: bootstrap admin by email list.
   During dev, set one email (your primary admin email) to automatically become admin at first login.
   For production, set roles via the Realtime Database console or using Admin SDK / Cloud Function.
*/
const adminEmailList = [
  /* e.g. "you@company.com" */
];

/* Initialize firebase app (compat) */
if (!window.firebase.apps.length) {
  window.firebase.initializeApp(firebaseConfig);
}
const auth = window.firebase.auth();
const db = window.firebase.database();

/* ========== Utility helpers ========== */
function formatDateDisplayISO(dateStr) {
  // input 'YYYY-MM-DD' -> 'DD/MM/YYYY'
  if (!dateStr) return '';
  const [y,m,d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}
function formatTimeDisplayHHMMSS(t) {
  if(!t || t.length !== 6) return t;
  return `${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`;
}
function parseTimeToMs(hhmmss) {
  if (!hhmmss || hhmmss.length !== 6) return null;
  const hh = parseInt(hhmmss.slice(0,2),10);
  const mm = parseInt(hhmmss.slice(2,4),10);
  const ss = parseInt(hhmmss.slice(4,6),10);
  if (Number.isNaN(hh) || Number.isNaN(mm) || Number.isNaN(ss)) return null;
  const d = new Date(); d.setHours(hh,mm,ss,0); return d.getTime();
}
function secondsToMinutesRounded(sec) {
  return Math.max(0, Math.round(sec/60));
}

/* Export helpers */
function downloadBlob(filename, contentType, blobData) {
  const blob = new Blob([blobData], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function exportCSV(entries, filename='logbot_export.csv') {
  if (!entries || !entries.length) {
    alert('No entries to export');
    return;
  }
  const headers = ["vehicle","date","place","purpose","startTime","endTime","travelTime","stationaryTime","mileage","engineHours","fuelLevel","operator","accompanying","createdBy","timestamp"];
  const rows = entries.map(e => headers.map(h => (e[h] !== undefined ? String(e[h]).replace(/"/g,'""') : '')).map(v => `"${v}"`).join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  downloadBlob(filename, 'text/csv;charset=utf-8;', csv);
}
function exportXLSX(entries, filename='logbot_export.xlsx') {
  if (!entries || !entries.length) { alert('No entries to export'); return; }
  // transform to worksheet
  const wsData = entries.map(e => ({
    Vehicle: e.vehicle,
    Date: e.date,
    Place: e.place,
    Purpose: e.purpose,
    Start: formatTimeDisplayHHMMSS(e.startTime),
    End: formatTimeDisplayHHMMSS(e.endTime),
    Travel_mins: e.travelTime,
    Stationary_mins: e.stationaryTime,
    Mileage_Km: e.mileage,
    Engine_Hours: e.engineHours,
    Fuel_pct: e.fuelLevel,
    Operator: e.operator,
    Accompanying: e.accompanying,
    CreatedBy: e.createdBy || '',
    Timestamp: new Date(e.timestamp || 0).toLocaleString()
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Entries');
  XLSX.writeFile(wb, filename);
}

/* ========== React App ========== */
const { useState, useEffect, useRef } = React;

function App() {
  const [user, setUser] = useState(null);
  const [userRecord, setUserRecord] = useState(null); // { displayName, role }
  const [entries, setEntries] = useState([]);
  const [vehicleFilter, setVehicleFilter] = useState('all');
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({
    vehicle: VEHICLES[0],
    date: new Date().toISOString().slice(0,10),
    place: '',
    purpose: '',
    startTime: '',
    endTime: '',
    travelTime: '',
    stationaryTime: '',
    mileage: '',
    engineHours: '',
    fuelLevel: '',
    operator: OPERATORS[0],
    operatorCustom: '',
    accompanying: OPERATORS[1] || OPERATORS[0],
    accompanyingCustom: ''
  });
  const [errors, setErrors] = useState({});
  const chartRef = useRef(null);
  const chartInstanceRef = useRef(null);

  /* load entries from realtime db */
  // Attach DB listener only after user is authenticated
  useEffect(() => {
  // if no user, clear entries and don't attach listener
  if (!user) {
    console.log('[LogBot] No auth user present — not attaching DB listener');
    setEntries([]); // ensure UI clears
    return;
  }

  console.log('[LogBot] Attaching DB listener for vehicle-entries as user:', user.uid);
  const ref = db.ref('vehicle-entries');

  const handler = (snap) => {
    const val = snap.val();
    console.log('[LogBot] DB snapshot received:', val);
    if (!val) {
      setEntries([]);
      return;
    }
    const list = Object.keys(val).map(k => ({ id: k, ...val[k] }))
      .sort((a,b) => (Number(b.timestamp || b.createdAt || 0) - Number(a.timestamp || a.createdAt || 0)));
    setEntries(list);
  };

  const onError = (err) => {
    console.error('[LogBot] Realtime DB listener error:', err);
    // show a visible message in case of permission_denied
    if (err && err.code === 'PERMISSION_DENIED') {
      alert('Realtime DB read permission denied. Confirm rules and /users/{uid} exist.');
    }
  };

  // attach
  ref.on('value', handler, onError);

  // cleanup when user signs out or component unmounts
  return () => {
    console.log('[LogBot] Detaching DB listener');
    ref.off('value', handler);
  };
}, [user]); // re-run when auth user changes

  /* Firebase auth state */
  useEffect(() => {
    const unsub = auth.onAuthStateChanged(async (u) => {
      if (u) {
        setUser(u);
        // ensure user record exists; create if missing
        const uRef = db.ref(`users/${u.uid}`);
        const snap = await uRef.get();
        if (!snap.exists()) {
          // default role operator, but allow admin bootstrap from adminEmailList
          const role = adminEmailList.includes(u.email) ? 'admin' : 'operator';
          await uRef.set({
            displayName: u.email.split('@')[0],
            email: u.email,
            role
          });
          setUserRecord({ displayName: u.email.split('@')[0], role });
        } else {
          setUserRecord(snap.val());
        }
      } else {
        setUser(null);
        setUserRecord(null);
      }
    });
    return () => unsub();
  }, []);

  /* auto compute stationary minutes when start/end/travel change */
  useEffect(() => {
    if (form.startTime && form.endTime) {
      const s = parseTimeToMs(form.startTime);
      const e = parseTimeToMs(form.endTime);
      const travel = parseInt(form.travelTime || '0', 10);
      if (s !== null && e !== null && e > s) {
        const stationaryMin = secondsToMinutesRounded((e - s) / 1000 - travel * 60);
        setForm(prev => ({ ...prev, stationaryTime: String(Math.max(0, stationaryMin)) }));
      }
    }
  }, [form.startTime, form.endTime, form.travelTime]);

  /* filtered entries */
  const filteredEntries = vehicleFilter === 'all' ? entries : entries.filter(en => en.vehicle === vehicleFilter);

  /* compute summary */
  const summary = React.useMemo(() => {
    const stats = { totalMileage:0, trips:0, avgFuel: null, totalEngineHours:0 };
    if (!filteredEntries || filteredEntries.length === 0) return stats;
    stats.trips = filteredEntries.length;
    let fuelSum = 0;
    filteredEntries.forEach(e => {
      stats.totalMileage += Number(e.mileage || 0);
      fuelSum += Number(e.fuelLevel || 0);
      stats.totalEngineHours += Number(e.engineHours || 0);
    });
    stats.avgFuel = Math.round((fuelSum / stats.trips) * 10) / 10;
    return stats;
  }, [filteredEntries]);

  /* monthly trend (group by YYYY-MM) */
  const monthlyMileage = React.useMemo(() => {
    const map = {};
    entries.forEach(e => {
      // assume e.date is YYYY-MM-DD
      const m = (e.date || '').slice(0,7) || 'unknown';
      map[m] = (map[m] || 0) + Number(e.mileage || 0);
    });
    // convert to sorted arrays
    const keys = Object.keys(map).sort();
    return { labels: keys, values: keys.map(k => map[k]) };
  }, [entries]);

  /* chart rendering */
  useEffect(() => {
    if (!chartRef.current) return;
    const ctx = chartRef.current.getContext('2d');
    if (chartInstanceRef.current) {
      chartInstanceRef.current.data.labels = monthlyMileage.labels;
      chartInstanceRef.current.data.datasets[0].data = monthlyMileage.values;
      chartInstanceRef.current.update();
      return;
    }
    chartInstanceRef.current = new Chart(ctx, {
      type: 'line',
      data: {
        labels: monthlyMileage.labels,
        datasets: [{
          label: 'Monthly Mileage (Km)',
          data: monthlyMileage.values,
          fill: false,
          borderWidth: 2
        }]
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          y: { beginAtZero: true }
        }
      }
    });
    return () => {
      // no op
    };
  }, [monthlyMileage]);

  /* Auth flows */
  async function handleSignUp(email, password) {
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, password);
      // user record will be created in onAuthStateChanged handler
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  async function handleSignIn(email, password) {
    try {
      await auth.signInWithEmailAndPassword(email, password);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
  function handleSignOut() {
    auth.signOut();
  }

  /* Validate entry */
  function validateEntry(payload) {
    const errs = {};
    if (!VEHICLES.includes(payload.vehicle)) errs.vehicle = 'Invalid vehicle';
    if (!payload.date) errs.date = 'Date required';
    if (!payload.place || payload.place.length > 200) errs.place = 'Place invalid';
    if (!payload.purpose || payload.purpose.length > 200) errs.purpose = 'Purpose invalid';
    if (!payload.startTime || parseTimeToMs(payload.startTime) === null) errs.startTime = 'Invalid start';
    if (!payload.endTime || parseTimeToMs(payload.endTime) === null) errs.endTime = 'Invalid end';
    if (parseTimeToMs(payload.endTime) <= parseTimeToMs(payload.startTime)) errs.endTime = 'End must be after start';
    if (!Number.isInteger(Number(payload.travelTime)) || Number(payload.travelTime) < 0) errs.travelTime = 'Travel time integer';
    if (!/^\d{1,5}$/.test(String(payload.mileage))) errs.mileage = 'Mileage must be integer up to 5 digits';
    if (isNaN(Number(payload.engineHours))) errs.engineHours = 'Engine hours numeric';
    const fuel = Number(payload.fuelLevel);
    if (!Number.isInteger(fuel) || fuel < 0 || fuel > 100) errs.fuelLevel = 'Fuel 0-100';
    if (!payload.operator || payload.operator.length > 200) errs.operator = 'Operator invalid';
    if (!payload.accompanying || payload.accompanying.length > 200) errs.accompanying = 'Accompanying invalid';
    if (payload.operator === payload.accompanying) errs.accompanying = 'Operator and accompanying must differ';
    return errs;
  }

  /* Save entry (create or update) */
  async function saveEntry() {
  console.log('[LogBot] saveEntry called — preparing payload', { form, editingId });

  try {
    const currentUser = firebase.auth().currentUser;
    console.log('[LogBot] firebase.auth().currentUser =', currentUser && currentUser.uid);
    if (!currentUser) {
      alert('Not signed in. Please sign in again.');
      console.error('[LogBot] saveEntry aborted: no auth.currentUser');
      return;
    }

    // resolve operator/accompanying fields
    const operator = form.operator === 'custom' ? (form.operatorCustom || '').trim() : form.operator;
    const accompanying = form.accompanying === 'custom' ? (form.accompanyingCustom || '').trim() : form.accompanying;

    // canonical payload fields (values as strings where appropriate)
    const newPayload = {
      vehicle: form.vehicle,
      date: form.date,
      place: (form.place || '').trim(),
      purpose: (form.purpose || '').trim(),
      startTime: form.startTime || '',
      endTime: form.endTime || '',
      travelTime: String(Number(form.travelTime || 0)),
      stationaryTime: String(Number(form.stationaryTime || 0)),
      mileage: String(Number(form.mileage || 0)),
      engineHours: String(Number(form.engineHours || 0)),
      fuelLevel: String(Number(form.fuelLevel || 0)),
      operator: operator,
      accompanying: accompanying
      // DO NOT add createdBy/createdAt here for update case
    };

    // validation (validateEntry expects createdBy etc for create case; adapt)
    // for update we can still validate most fields by adding a temporary createdBy field
    const validationObject = Object.assign({}, newPayload, { createdBy: currentUser.uid });
    const vErrors = validateEntry(validationObject);
    if (Object.keys(vErrors).length > 0) {
      setErrors(vErrors);
      console.warn('[LogBot] validation failed', vErrors);
      alert('Please fix validation errors before saving.');
      return;
    }

    if (editingId) {
      // UPDATE flow: preserve createdBy/createdAt by using update()
      const updates = Object.assign({}, newPayload, { updatedAt: firebase.database.ServerValue.TIMESTAMP });
      console.log('[LogBot] Performing update for id', editingId, 'with', updates);
      await db.ref(`vehicle-entries/${editingId}`).update(updates);
      console.log('[LogBot] update successful for id', editingId);

      // cleanup edit state
      setEditingId(null);
      setIsAdding(false);
      resetForm();
      alert('Entry updated successfully');
    } else {
      // CREATE flow: set createdBy + createdAt + timestamp
      const createPayload = Object.assign({}, newPayload, {
        createdBy: currentUser.uid,
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        timestamp: Date.now()
      });
      console.log('[LogBot] Performing push with', createPayload);
      const ref = await db.ref('vehicle-entries').push(createPayload);
      console.log('[LogBot] push successful, id =', ref.key);
      resetForm();
      alert('Entry added successfully');
    }

  } catch (err) {
    console.error('[LogBot] saveEntry failed', err);
    const msg = err && err.message ? err.message : JSON.stringify(err);
    alert('Failed to save entry: ' + msg);
  }
}

  async function deleteEntry(id, entry) {
    // permission: only admin or entry.createdBy === uid
    const role = userRecord?.role;
    if (!role && !user) { alert('No permission'); return; }
    const allowed = (role === 'admin') || (entry.createdBy && user && entry.createdBy === user.uid);
    if (!allowed) { alert('You are not permitted to delete this entry'); return; }
    if (!confirm('Delete entry?')) return;
    try {
      await db.ref(`vehicle-entries/${id}`).remove();
    } catch (err) {
      console.error(err); alert('Failed to delete');
    }
  }

  function startEdit(entry) {
    const opCustom = !OPERATORS.includes(entry.operator);
    const acCustom = !OPERATORS.includes(entry.accompanying);
    setForm({
      vehicle: entry.vehicle || VEHICLES[0],
      date: entry.date || new Date().toISOString().slice(0,10),
      place: entry.place || '',
      purpose: entry.purpose || '',
      startTime: entry.startTime || '',
      endTime: entry.endTime || '',
      travelTime: String(entry.travelTime || ''),
      stationaryTime: String(entry.stationaryTime || ''),
      mileage: String(entry.mileage || ''),
      engineHours: String(entry.engineHours || ''),
      fuelLevel: String(entry.fuelLevel || ''),
      operator: opCustom ? 'custom' : (entry.operator || OPERATORS[0]),
      operatorCustom: opCustom ? entry.operator : '',
      accompanying: acCustom ? 'custom' : (entry.accompanying || OPERATORS[1] || OPERATORS[0]),
      accompanyingCustom: acCustom ? entry.accompanying : ''
    });
    setEditingId(entry.id);
    setIsAdding(true);
    setErrors({});
  }

  function resetForm() {
    setForm({
      vehicle: VEHICLES[0],
      date: new Date().toISOString().slice(0,10),
      place: '',
      purpose: '',
      startTime: '',
      endTime: '',
      travelTime: '',
      stationaryTime: '',
      mileage: '',
      engineHours: '',
      fuelLevel: '',
      operator: OPERATORS[0],
      operatorCustom: '',
      accompanying: OPERATORS[1] || OPERATORS[0],
      accompanyingCustom: ''
    });
    setIsAdding(false);
    setEditingId(null);
    setErrors({});
  }

  /* Exports */
  function doExportCSV() {
    exportCSV(filteredEntries);
  }
  function doExportXLSX() {
    exportXLSX(filteredEntries);
  }

  /* admin utilities: set role of a user (admin only) */
  async function setRoleForUser(uid, role) {
    if (userRecord?.role !== 'admin') { alert('Only admin can set roles'); return; }
    await db.ref(`users/${uid}/role`).set(role);
    alert('Role updated');
  }

  /* UI: login screen (simple, integrated) */
  const [authState, setAuthState] = useState({ email:'', password:'', mode:'signin', authError: null });
  async function handleAuthSubmit(e) {
    e.preventDefault();
    if (authState.mode === 'signin') {
      const r = await handleSignIn(authState.email, authState.password);
      if (!r.success) setAuthState(s => ({ ...s, authError: r.error }));
    } else {
      const r = await handleSignUp(authState.email, authState.password);
      if (!r.success) setAuthState(s => ({ ...s, authError: r.error }));
    }
  }

  /* Permission helper UI: canEdit / canDelete */
  function canEdit(entry) {
    if (userRecord?.role === 'admin') return true;
    if (entry.createdBy && user && entry.createdBy === user.uid) return true;
    return false;
  }
  function canDelete(entry) {
    return canEdit(entry); // same policy for now
  }

  /* render */
  if (!user) {
    // Show auth UI
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-blue-600 to-blue-800">
        <div className="bg-white rounded-2xl shadow-2xl p-8 w-full max-w-md">
          <h1 className="text-3xl font-bold mb-4">Log Bot</h1>
          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium">Email</label>
              <input className="w-full border px-3 py-2 rounded" value={authState.email} onChange={e => setAuthState(s => ({ ...s, email: e.target.value }))} required />
            </div>
            <div>
              <label className="block text-sm font-medium">Password</label>
              <input type="password" className="w-full border px-3 py-2 rounded" value={authState.password} onChange={e => setAuthState(s => ({ ...s, password: e.target.value }))} required />
            </div>
            {authState.authError && <div className="text-red-600 text-sm">{authState.authError}</div>}
            <div className="flex gap-2">
              <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">{authState.mode === 'signin' ? 'Sign in' : 'Sign up'}</button>
              <button type="button" className="px-4 py-2 border rounded" onClick={() => setAuthState(s => ({ ...s, mode: s.mode === 'signin' ? 'signup' : 'signin', authError: null }))}>
                {authState.mode === 'signin' ? 'Create account' : 'Back to sign in'}
              </button>
            </div>
            <div className="text-xs text-gray-500 mt-2">Note: sign-up will create a user record with role = <strong>operator</strong> by default.</div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <div className="max-w-7xl mx-auto">
        <header className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold">Log Bot</h1>
            <div className="text-sm text-gray-600">User: {user.email} • Role: {userRecord?.role || 'n/a'}</div>
          </div>
          <div className="flex gap-2">
            <button className="px-3 py-2 border rounded" onClick={() => { setIsAdding(true); }}>Add New Entry</button>
            <button className="px-3 py-2 border rounded" onClick={doExportCSV}>Export CSV</button>
            <button className="px-3 py-2 border rounded" onClick={doExportXLSX}>Export XLSX</button>
            <button className="px-3 py-2 border rounded bg-red-500 text-white" onClick={() => auth.signOut()}>Sign out</button>
          </div>
        </header>

        {/* Summary */}
        <section className="bg-white p-4 rounded mb-4 shadow">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <div className="text-sm text-gray-500">Total Mileage (filtered)</div>
              <div className="text-2xl font-bold">{summary.totalMileage} Km</div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Trips</div>
              <div className="text-2xl font-bold">{summary.trips}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Average Fuel (%)</div>
              <div className="text-2xl font-bold">{summary.avgFuel ?? '—'}</div>
            </div>
          </div>
          <div className="mt-4" style={{height: '220px'}}>
            <canvas ref={chartRef}></canvas>
          </div>
        </section>

        {/* Filter + list */}
        <section className="bg-white p-4 rounded shadow mb-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <label className="block text-sm">Filter by vehicle</label>
              <select value={vehicleFilter} onChange={e => setVehicleFilter(e.target.value)} className="border px-3 py-2 rounded">
                <option value="all">All</option>
                {VEHICLES.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>

            <div className="text-sm text-gray-600">Showing {filteredEntries.length} entries</div>
          </div>

          <div className="space-y-3">
            {filteredEntries.length === 0 ? <div className="text-gray-500 p-6">No entries</div> :
              filteredEntries.map(entry => (
                <article key={entry.id} className="p-3 border rounded flex justify-between">
                  <div>
                    <div className="text-sm text-gray-500">{entry.vehicle} • {formatDateDisplayISO(entry.date)}</div>
                    <h3 className="font-semibold">{entry.place}</h3>
                    <div className="text-sm text-gray-600">{entry.purpose}</div>

                    <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                      <div>Start: <strong>{formatTimeDisplayHHMMSS(entry.startTime)}</strong></div>
                      <div>End: <strong>{formatTimeDisplayHHMMSS(entry.endTime)}</strong></div>
                      <div>Travel: <strong>{entry.travelTime} mins</strong></div>
                      <div>Stationary: <strong>{entry.stationaryTime} mins</strong></div>
                      <div>Mileage: <strong>{entry.mileage} Km</strong></div>
                      <div>Engine: <strong>{entry.engineHours} Hr</strong></div>
                      <div>Fuel: <strong>{entry.fuelLevel}%</strong></div>
                      <div>Operator: <strong>{entry.operator}</strong></div>
                      <div>Accompanying: <strong>{entry.accompanying}</strong></div>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <button onClick={() => { if (canEdit(entry)) startEdit(entry); else alert('No permission to edit'); }} className="px-3 py-1 border rounded">Edit</button>
                    {canDelete(entry) ? <button onClick={() => deleteEntry(entry.id, entry)} className="px-3 py-1 border rounded text-red-600">Delete</button> : <button disabled className="px-3 py-1 border rounded text-gray-400">Delete</button>}
                  </div>
                </article>
              ))
            }
          </div>
        </section>

        {/* Add/Edit Form */}
        {isAdding && (
          <section className="bg-white p-4 rounded shadow mb-6">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-semibold">{editingId ? 'Edit Entry' : 'Add New Entry'}</h2>
              <button onClick={resetForm} className="px-3 py-1 border rounded">Close</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-sm">Vehicle</label>
                <select value={form.vehicle} onChange={e => setForm({...form, vehicle: e.target.value})} className="w-full border px-2 py-2 rounded">
                  {VEHICLES.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>

              <div>
                <label className="text-sm">Date</label>
                <input type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})} className="w-full border px-2 py-2 rounded" />
              </div>

              <div>
                <label className="text-sm">Place</label>
                <input type="text" value={form.place} onChange={e => setForm({...form, place: e.target.value})} maxLength="200" className="w-full border px-2 py-2 rounded" />
                {errors.place && <div className="text-red-600 text-xs">{errors.place}</div>}
              </div>

              <div>
                <label className="text-sm">Purpose</label>
                <input type="text" value={form.purpose} onChange={e => setForm({...form, purpose: e.target.value})} maxLength="200" className="w-full border px-2 py-2 rounded" />
                {errors.purpose && <div className="text-red-600 text-xs">{errors.purpose}</div>}
              </div>

              <div>
                <label className="text-sm">Start (HHMMSS)</label>
                <input type="text" value={form.startTime} onChange={e => setForm({...form, startTime: e.target.value.replace(/\D/g,'').slice(0,6)})} maxLength="6" className="w-full border px-2 py-2 rounded" />
                {errors.startTime && <div className="text-red-600 text-xs">{errors.startTime}</div>}
              </div>

              <div>
                <label className="text-sm">End (HHMMSS)</label>
                <input type="text" value={form.endTime} onChange={e => setForm({...form, endTime: e.target.value.replace(/\D/g,'').slice(0,6)})} maxLength="6" className="w-full border px-2 py-2 rounded" />
                {errors.endTime && <div className="text-red-600 text-xs">{errors.endTime}</div>}
              </div>

              <div>
                <label className="text-sm">Travel Time (mins)</label>
                <div className="relative">
                  <input type="text" value={form.travelTime} onChange={e => setForm({...form, travelTime: e.target.value.replace(/\D/g,'')})} className="w-full border px-2 py-2 rounded pr-12" />
                  <span className="absolute right-2 top-2 text-gray-400">mins</span>
                </div>
                {errors.travelTime && <div className="text-red-600 text-xs">{errors.travelTime}</div>}
              </div>

              <div>
                <label className="text-sm">Stationary (auto)</label>
                <div className="relative">
                  <input value={form.stationaryTime} readOnly className="w-full border px-2 py-2 rounded bg-gray-100 pr-12" />
                  <span className="absolute right-2 top-2 text-gray-400">mins</span>
                </div>
              </div>

              <div>
                <label className="text-sm">Mileage (Km)</label>
                <input value={form.mileage} onChange={e => setForm({...form, mileage: e.target.value.replace(/\D/g,'').slice(0,5)})} className="w-full border px-2 py-2 rounded" />
                {errors.mileage && <div className="text-red-600 text-xs">{errors.mileage}</div>}
              </div>

              <div>
                <label className="text-sm">Engine Hours</label>
                <input value={form.engineHours} onChange={e => setForm({...form, engineHours: e.target.value})} className="w-full border px-2 py-2 rounded" />
                {errors.engineHours && <div className="text-red-600 text-xs">{errors.engineHours}</div>}
              </div>

              <div>
                <label className="text-sm">Fuel Level (%)</label>
                <input value={form.fuelLevel} onChange={e => setForm({...form, fuelLevel: e.target.value.replace(/\D/g,'').slice(0,3)})} className="w-full border px-2 py-2 rounded" />
                {errors.fuelLevel && <div className="text-red-600 text-xs">{errors.fuelLevel}</div>}
              </div>

              <div>
                <label className="text-sm">Operator</label>
                <select value={form.operator} onChange={e => setForm({...form, operator: e.target.value})} className="w-full border px-2 py-2 rounded">
                  {OPERATORS.map(o => <option key={o} value={o}>{o}</option>)}
                  <option value="custom">Other</option>
                </select>
                {form.operator === 'custom' && <input value={form.operatorCustom} onChange={e => setForm({...form, operatorCustom: e.target.value})} className="w-full border px-2 py-2 rounded mt-1" />}
                {errors.operator && <div className="text-red-600 text-xs">{errors.operator}</div>}
              </div>

              <div>
                <label className="text-sm">Accompanying</label>
                <select value={form.accompanying} onChange={e => setForm({...form, accompanying: e.target.value})} className="w-full border px-2 py-2 rounded">
                  {OPERATORS.map(o => <option key={o} value={o}>{o}</option>)}
                  <option value="custom">Other</option>
                </select>
                {form.accompanying === 'custom' && <input value={form.accompanyingCustom} onChange={e => setForm({...form, accompanyingCustom: e.target.value})} className="w-full border px-2 py-2 rounded mt-1" />}
                {errors.accompanying && <div className="text-red-600 text-xs">{errors.accompanying}</div>}
              </div>
            </div>

            <div className="mt-4 flex gap-2">
              <button onClick={saveEntry} className="px-4 py-2 bg-blue-600 text-white rounded">{editingId ? 'Update Entry' : 'Add Entry'}</button>
              <button onClick={resetForm} className="px-4 py-2 border rounded">Cancel</button>
            </div>
          </section>
        )}

        {/* Admin: user role management quick panel */}
        {userRecord?.role === 'admin' && (
          <section className="bg-white p-4 rounded shadow">
            <h3 className="font-semibold mb-2">Admin console (quick)</h3>
            <div className="text-sm text-gray-600 mb-2">Set a user's role (by uid). Use Realtime DB console for full user management.</div>
            <AdminRoleForm setRoleForUser={setRoleForUser} />
          </section>
        )}
      </div>
    </div>
  );
}

/* small admin form component */
function AdminRoleForm({ setRoleForUser }) {
  const [uid, setUid] = useState('');
  const [role, setRole] = useState('operator');
  return (
    <div className="flex gap-2 items-center">
      <input placeholder="user uid" value={uid} onChange={e => setUid(e.target.value)} className="border px-2 py-1 rounded" />
      <select value={role} onChange={e => setRole(e.target.value)} className="border px-2 py-1 rounded">
        <option value="operator">operator</option>
        <option value="admin">admin</option>
      </select>
      <button onClick={() => { if (!uid) return alert('enter uid'); setRoleForUser(uid, role); }} className="px-3 py-1 border rounded">Set role</button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));