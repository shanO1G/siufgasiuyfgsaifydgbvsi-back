// Admin Panel Application logic
const API_BASE = 'https://frnd-api-n3hv.onrender.com/api/admin';

// DOM elements
const loginContainer = document.getElementById('login-container');
const dashboardContainer = document.getElementById('dashboard-container');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const adminEmailDisplay = document.getElementById('admin-email-display');
const logoutBtn = document.getElementById('logout-btn');

// Signin / Signup Switch UI elements
const signinSection = document.getElementById('signin-section');
const signupSection = document.getElementById('signup-section');
const toSignupLink = document.getElementById('to-signup-link');
const toSigninLink = document.getElementById('to-signin-link');
const signupForm = document.getElementById('signup-form');
const signupError = document.getElementById('signup-error');
const signupSuccess = document.getElementById('signup-success');

// ------------------------------------------------------------------
// UI NAVIGATION (SIGNIN / SIGNUP TOGGLES)
// ------------------------------------------------------------------
toSignupLink.addEventListener('click', (e) => {
  e.preventDefault();
  signinSection.classList.add('hidden');
  signupSection.classList.remove('hidden');
  loginError.classList.add('hidden');
  signupError.classList.add('hidden');
  signupSuccess.classList.add('hidden');
});

toSigninLink.addEventListener('click', (e) => {
  e.preventDefault();
  signupSection.classList.add('hidden');
  signinSection.classList.remove('hidden');
  loginError.classList.add('hidden');
  signupError.classList.add('hidden');
  signupSuccess.classList.add('hidden');
});

// Modal Elements
const rejectModal = document.getElementById('reject-modal');
const rejectForm = document.getElementById('reject-form');
const rejectRequestId = document.getElementById('reject-request-id');
const rejectReasonInput = document.getElementById('reject-reason');
const rejectModalCancel = document.getElementById('reject-modal-cancel');

const userModal = document.getElementById('user-modal');
const userModalForm = document.getElementById('user-modal-form');
const userModalUserId = document.getElementById('user-modal-userid');
const userModalBadges = document.getElementById('user-modal-badges');
const userModalCancel = document.getElementById('user-modal-cancel');

// Tab tracking
const navItems = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');
const tabTitle = document.getElementById('tab-title');

// Initialize state
let token = localStorage.getItem('adminToken');
let email = localStorage.getItem('adminEmail');

if (token) {
  showDashboard();
} else {
  showLogin();
}

// ------------------------------------------------------------------
// AUTHENTICATION FLOWS
// ------------------------------------------------------------------
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  
  const emailVal = document.getElementById('login-email').value;
  const passwordVal = document.getElementById('login-password').value;
  const commonVal = document.getElementById('login-common').value;

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailVal, password: passwordVal, commonPass: commonVal })
    });
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    token = data.token;
    email = data.email;
    localStorage.setItem('adminToken', token);
    localStorage.setItem('adminEmail', email);
    
    showDashboard();
  } catch (err) {
    loginError.innerText = err.message;
    loginError.classList.remove('hidden');
  }
});

// Admin Registration handler
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  signupError.classList.add('hidden');
  signupSuccess.classList.add('hidden');

  const emailVal = document.getElementById('signup-email').value;
  const passwordVal = document.getElementById('signup-password').value;

  try {
    const res = await fetch(`${API_BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailVal, password: passwordVal })
    });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Registration failed');
    }

    signupSuccess.innerText = 'Admin account registered successfully! You can now sign in.';
    signupSuccess.classList.remove('hidden');
    
    // Clear inputs
    document.getElementById('signup-email').value = '';
    document.getElementById('signup-password').value = '';

    // Switch back to signin after 2.5 seconds
    setTimeout(() => {
      toSigninLink.click();
    }, 2500);
  } catch (err) {
    signupError.innerText = err.message;
    signupError.classList.remove('hidden');
  }
});

logoutBtn.addEventListener('click', async () => {
  // Non-blocking server-side logout notify
  fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  }).catch(() => {});

  localStorage.removeItem('adminToken');
  localStorage.removeItem('adminEmail');
  token = null;
  email = null;
  showLogin();
});

function showLogin() {
  loginContainer.classList.remove('hidden');
  dashboardContainer.classList.add('hidden');
}

function showDashboard() {
  loginContainer.classList.add('hidden');
  dashboardContainer.classList.remove('hidden');
  adminEmailDisplay.innerText = email;
  loadTabContent('flags-tab');
}

// Tab navigation
navItems.forEach(item => {
  item.addEventListener('click', () => {
    navItems.forEach(nav => nav.classList.remove('active'));
    item.classList.add('active');
    
    const tabId = item.getAttribute('data-tab');
    tabPanes.forEach(pane => {
      if (pane.id === tabId) {
        pane.classList.add('active');
      } else {
        pane.classList.remove('active');
      }
    });

    tabTitle.innerText = item.innerText.replace(/[^\w\s]/g, '').trim();
    loadTabContent(tabId);
  });
});

// Safe API Fetch wrapper
async function apiFetch(path, options = {}) {
  if (!options.headers) options.headers = {};
  options.headers['Authorization'] = `Bearer ${token}`;
  
  try {
    const res = await fetch(`${API_BASE}${path}`, options);
    if (res.status === 401 || res.status === 403) {
      // Force logout on token expiration
      logoutBtn.click();
      return null;
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'API Request failed');
    }
    return data;
  } catch (err) {
    alert(err.message);
    return null;
  }
}

// ------------------------------------------------------------------
// TAB ROUTERS
// ------------------------------------------------------------------
function loadTabContent(tabId) {
  switch (tabId) {
    case 'flags-tab':
      fetchFlags();
      break;
    case 'verifications-tab':
      fetchVerificationRequests();
      break;
    case 'users-tab':
      fetchUsers();
      break;
    case 'reports-tab':
      fetchReports();
      break;
    case 'feedback-tab':
      fetchFeedback();
      break;
  }
}

// ------------------------------------------------------------------
// 1. FLAGS QUEUE TAB
// ------------------------------------------------------------------
async function fetchFlags() {
  const data = await apiFetch('/flags?status=open');
  const tbody = document.getElementById('flags-table-body');
  const emptyState = document.getElementById('flags-empty-state');
  
  tbody.innerHTML = '';
  
  if (!data || !data.flags || data.flags.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  data.flags.forEach(flag => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong>${flag.userId?.name || 'N/A'}</strong><br>
        <span class="text-secondary">@${flag.userId?.username || 'N/A'}</span>
      </td>
      <td><code>${flag.flagType}</code></td>
      <td><span class="badge-status ${flag.severity}">${flag.severity}</span></td>
      <td><pre class="json-details">${JSON.stringify(flag.details)}</pre></td>
      <td>
        <div class="table-actions">
          <button class="btn sm secondary" onclick="resolveFlag('${flag._id}', 'dismiss')">Dismiss</button>
          <button class="btn sm secondary" onclick="resolveFlag('${flag._id}', 'review')">Review</button>
          <button class="btn sm primary danger" onclick="resolveFlag('${flag._id}', 'action')">Ban / Action</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.resolveFlag = async (flagId, outcome) => {
  const data = await apiFetch(`/flags/${flagId}/${outcome}`, { method: 'POST' });
  if (data) fetchFlags();
};

// ------------------------------------------------------------------
// 2. VERIFICATIONS QUEUE TAB
// ------------------------------------------------------------------
async function fetchVerificationRequests() {
  const data = await apiFetch('/verification-requests');
  const grid = document.getElementById('verifications-grid');
  const emptyState = document.getElementById('verifications-empty-state');
  
  grid.innerHTML = '';
  
  if (!data || !data.requests || data.requests.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }
  emptyState.classList.add('hidden');

  data.requests.forEach(req => {
    const card = document.createElement('div');
    card.className = 'verify-card';
    card.innerHTML = `
      <div class="verify-user-header">
        <div>
          <h3>${req.userId?.name || 'N/A'}</h3>
          <p class="text-secondary">@${req.userId?.username || 'N/A'} (${req.userId?.email || ''})</p>
        </div>
        ${req.isDuplicate ? '<span class="badge-status high">Warning: Duplicate Document Hash</span>' : ''}
      </div>
      <div class="verify-images-container">
        <div class="image-box">
          <span>Camera ID Card Image</span>
          <img src="${req.idCardUrl}" alt="ID Card preview">
        </div>
        <div class="image-box">
          <span>Camera Face Capture</span>
          <img src="${req.faceUrl}" alt="Face preview">
        </div>
      </div>
      <div class="verify-card-actions">
        <button class="btn primary" onclick="approveVerification('${req._id}')">Approve</button>
        <button class="btn secondary" onclick="openRejectModal('${req._id}')">Reject</button>
      </div>
    `;
    grid.appendChild(card);
  });
}

window.approveVerification = async (requestId) => {
  const data = await apiFetch(`/verification-requests/${requestId}/approve`, { method: 'POST' });
  if (data) fetchVerificationRequests();
};

window.openRejectModal = (requestId) => {
  rejectRequestId.value = requestId;
  rejectReasonInput.value = '';
  rejectModal.classList.remove('hidden');
};

rejectModalCancel.addEventListener('click', () => {
  rejectModal.classList.add('hidden');
});

rejectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const requestId = rejectRequestId.value;
  const reason = rejectReasonInput.value;

  const data = await apiFetch(`/verification-requests/${requestId}/reject`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  });

  if (data) {
    rejectModal.classList.add('hidden');
    fetchVerificationRequests();
  }
});

// ------------------------------------------------------------------
// 3. USER DIRECTORY TAB
// ------------------------------------------------------------------
async function fetchUsers() {
  const data = await apiFetch('/users');
  const tbody = document.getElementById('users-table-body');
  
  tbody.innerHTML = '';
  if (!data || !data.users) return;

  data.users.forEach(user => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <strong>${user.name}</strong><br>
        <span class="text-secondary">@${user.username} (Age ${user.age})</span>
      </td>
      <td>${user.email}</td>
      <td><span class="badge-status ${user.identityStatus === 'verified' ? 'success' : 'secondary'}">${user.identityStatus}</span></td>
      <td><span class="badge-status ${user.openFlagCount > 0 ? 'high' : 'low'}">${user.openFlagCount} open</span></td>
      <td>
        <button class="btn sm secondary" onclick="togglePremium('${user._id}', ${user.isPremium})">
          ${user.isPremium ? 'Premium ✓' : 'Upgrade'}
        </button>
      </td>
      <td>${user.badges?.join(', ') || 'None'}</td>
      <td><span class="badge-status ${user.banned ? 'high' : 'success'}">${user.banned ? 'Banned' : 'Active'}</span></td>
      <td>
        <div class="table-actions">
          <button class="btn sm secondary" onclick="openUserModal('${user._id}', '${user.name}', '${user.badges?.join(', ') || ''}')">Badges</button>
          ${user.banned 
            ? `<button class="btn sm secondary" onclick="unbanUser('${user._id}')">Unban</button>`
            : `<button class="btn sm primary danger" onclick="banUserPrompt('${user._id}')">Ban</button>`
          }
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.togglePremium = async (userId, currentVal) => {
  const data = await apiFetch(`/users/${userId}/premium`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPremium: !currentVal })
  });
  if (data) fetchUsers();
};

window.banUserPrompt = async (userId) => {
  const reason = prompt('Please enter a reason for banning this user:');
  if (!reason) return;

  const data = await apiFetch(`/users/${userId}/ban`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  });
  if (data) fetchUsers();
};

window.unbanUser = async (userId) => {
  const data = await apiFetch(`/users/${userId}/unban`, { method: 'POST' });
  if (data) fetchUsers();
};

window.openUserModal = (userId, name, badges) => {
  userModalUserId.value = userId;
  userModalBadges.value = badges;
  document.getElementById('user-modal-title').innerText = `Moderation: ${name}`;
  userModal.classList.remove('hidden');
};

userModalCancel.addEventListener('click', () => {
  userModal.classList.add('hidden');
});

userModalForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userId = userModalUserId.value;
  const badgesStr = userModalBadges.value;
  const badgesArray = badgesStr.split(',').map(b => b.trim()).filter(b => b !== '');

  const data = await apiFetch(`/users/${userId}/badge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ badges: badgesArray })
  });

  if (data) {
    userModal.classList.add('hidden');
    fetchUsers();
  }
});

// ------------------------------------------------------------------
// 4. REPORTS LOGS TAB
// ------------------------------------------------------------------
async function fetchReports() {
  const data = await apiFetch('/reports');
  const tbody = document.getElementById('reports-table-body');
  
  tbody.innerHTML = '';
  if (!data || !data.reports) return;

  data.reports.forEach(report => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>@${report.reporterId?.username || 'N/A'}</td>
      <td>
        ${report.targetUserId 
          ? `User: <strong>@${report.targetUserId.username || 'N/A'}</strong>`
          : `Post ID: <code>${report.targetPostId || 'N/A'}</code>`
        }
      </td>
      <td>${report.reason}</td>
      <td>${new Date(report.createdAt).toLocaleString()}</td>
      <td><span class="badge-status ${report.status === 'open' ? 'high' : 'secondary'}">${report.status}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// ------------------------------------------------------------------
// 5. FEEDBACK LOGS TAB
// ------------------------------------------------------------------
async function fetchFeedback() {
  const data = await apiFetch('/feedback');
  const tbody = document.getElementById('feedback-table-body');
  
  tbody.innerHTML = '';
  if (!data || !data.feedback) return;

  data.feedback.forEach(fb => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>@${fb.userId?.username || 'N/A'}</td>
      <td>${fb.content}</td>
      <td>${new Date(fb.createdAt).toLocaleString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ------------------------------------------------------------------
// 6. ANNOUNCEMENT FORM SUBMIT
// ------------------------------------------------------------------
const announcementForm = document.getElementById('announcement-form');
const announceAlert = document.getElementById('announce-alert');

announcementForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  announceAlert.classList.add('hidden');
  
  const title = document.getElementById('announce-title').value;
  const content = document.getElementById('announce-content').value;

  const data = await apiFetch('/announce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, content })
  });

  if (data) {
    announceAlert.innerText = 'Announcement published successfully!';
    announceAlert.className = 'alert success';
    announceAlert.classList.remove('hidden');
    
    // Clear form inputs
    document.getElementById('announce-title').value = '';
    document.getElementById('announce-content').value = '';
  }
});
