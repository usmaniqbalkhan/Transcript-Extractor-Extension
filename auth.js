/**
 * Auth page script — handles Google Sign-In lock screen.
 * Uses chrome.identity for OAuth and chrome.storage.local for persistence.
 * The extension is completely locked until sign-in succeeds.
 */

const signInBtn = document.getElementById('signInBtn');
const signedInArea = document.getElementById('signedInArea');
const emailDisplay = document.getElementById('emailDisplay');
const openExtensionBtn = document.getElementById('openExtensionBtn');
const signOutBtn = document.getElementById('signOutBtn');
const statusText = document.getElementById('statusText');
const errorText = document.getElementById('errorText');

// ============================================================================
// Initialization — check if already authenticated
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  statusText.textContent = 'Checking sign-in status...';

  const authData = await getStoredAuth();
  if (authData && authData.email) {
    // Verify the token is still valid (non-interactive)
    chrome.identity.getAuthToken({ interactive: false }, (token) => {
      if (chrome.runtime.lastError || !token) {
        // Token expired or revoked — clear stored auth and show sign-in
        clearStoredAuth();
        showSignIn();
        statusText.textContent = '';
        return;
      }
      // Token still valid — show signed-in state
      showSignedIn(authData.email);
    });
  } else {
    showSignIn();
    statusText.textContent = '';
  }
});

// ============================================================================
// Event Listeners
// ============================================================================

signInBtn.addEventListener('click', () => {
  signInBtn.disabled = true;
  clearError();
  statusText.textContent = 'Signing in...';

  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    if (chrome.runtime.lastError) {
      const msg = chrome.runtime.lastError.message || 'Sign-in failed';
      showSignInError(msg);
      signInBtn.disabled = false;
      statusText.textContent = '';
      return;
    }
    if (!token) {
      showSignInError('Sign-in was cancelled or no token received.');
      signInBtn.disabled = false;
      statusText.textContent = '';
      return;
    }

    // Get user profile
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, async (userInfo) => {
      if (chrome.runtime.lastError || !userInfo || !userInfo.email) {
        showSignInError('Signed in but could not retrieve email. Check extension permissions.');
        signInBtn.disabled = false;
        statusText.textContent = '';
        return;
      }

      // Save auth state
      await storeAuth({ email: userInfo.email, signedInAt: Date.now() });

      // Notify service worker that auth state changed
      try { chrome.runtime.sendMessage({ action: 'authStateChanged', signedIn: true }); } catch {}

      showSignedIn(userInfo.email);
    });
  });
});

openExtensionBtn.addEventListener('click', () => {
  // Tell the service worker to open the popup for this tab
  chrome.runtime.sendMessage({ action: 'openPopup' });
});

signOutBtn.addEventListener('click', () => {
  chrome.identity.getAuthToken({ interactive: false }, (token) => {
    if (chrome.runtime.lastError || !token) {
      doSignOut();
      return;
    }
    chrome.identity.removeCachedAuthToken({ token }, () => {
      // Revoke remotely so re-sign-in shows account picker
      fetch(`https://accounts.google.com/o/oauth2/revoke?token=${token}`)
        .catch(() => {})
        .finally(() => doSignOut());
    });
  });
});

// ============================================================================
// UI State
// ============================================================================

function showSignIn() {
  signInBtn.style.display = '';
  signInBtn.disabled = false;
  signedInArea.classList.remove('visible');
  statusText.textContent = '';
  clearError();
}

function showSignedIn(email) {
  signInBtn.style.display = 'none';
  emailDisplay.textContent = email;
  signedInArea.classList.add('visible');
  statusText.textContent = '';
  clearError();
}

async function doSignOut() {
  await clearStoredAuth();
  // Notify service worker
  try { chrome.runtime.sendMessage({ action: 'authStateChanged', signedIn: false }); } catch {}
  showSignIn();
}

function showSignInError(msg) {
  errorText.textContent = msg;
}

function clearError() {
  errorText.textContent = '';
}

// ============================================================================
// Storage helpers
// ============================================================================

function getStoredAuth() {
  return new Promise((resolve) => {
    chrome.storage.local.get('authState', (data) => {
      resolve(data.authState || null);
    });
  });
}

function storeAuth(authData) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ authState: authData }, resolve);
  });
}

function clearStoredAuth() {
  return new Promise((resolve) => {
    chrome.storage.local.remove('authState', resolve);
  });
}
