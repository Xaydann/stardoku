/* =====================================================================
   Stardoku — native ad bridge
   ---------------------------------------------------------------------
   Drop this into the Capacitor project as www/ads.js and load it AFTER
   the game, at the very end of <body>:

       <script type="module" src="ads.js"></script>

   The game runs perfectly without it. It looks for window.SDBridge, and
   until this file replaces it every ad call is a no-op that resolves
   false. Nothing here can break gameplay: every path is wrapped, and a
   failure to load an ad is indistinguishable from having no ads at all.
   ===================================================================== */

import { AdMob } from '@capacitor-community/admob';
import { InAppPurchase2 as Store2 } from '@ionic-native/in-app-purchase-2';
import { Preferences } from '@capacitor/preferences';

/* ---------- 1. Your IDs ---------------------------------------------
   Keep the test IDs while developing. Clicking your own live ads will
   get the AdMob account suspended, and it is not reversible.          */
const LIVE = false;                    // flip to true only for release builds

/* App ID (goes in Info.plist as GADApplicationIdentifier, note the tilde):
       ca-app-pub-9229974695673452~6472153936
   That one identifies the app and cannot request an ad. The two below are the
   ad units, which use a slash.                                              */
const ID = LIVE ? {
  interstitial: 'ca-app-pub-9229974695673452/8610503165',
  rewarded:     'ca-app-pub-9229974695673452/1195399220'
} : {                                  // Google's public test units
  interstitial: 'ca-app-pub-3940256099942544/4411468910',
  rewarded:     'ca-app-pub-3940256099942544/1712485313'
};

/* Guard rails. Both of these have cost people their AdMob account. */
if (LIVE) {
  console.warn('[Stardoku] LIVE ads are on. Do not tap them yourself.');
  if (!/^ca-app-pub-\d{16}\/\d+$/.test(ID.interstitial) ||
      !/^ca-app-pub-\d{16}\/\d+$/.test(ID.rewarded)) {
    console.error('[Stardoku] An ad unit id looks wrong. Units use a slash; a tilde means you have pasted the App ID.');
  }
}

let interstitialReady = false;
let rewardedReady     = false;
let consentDone       = false;

const REMOVE_ADS = 'stardoku.removeads';   // must match App Store Connect exactly
const CLOUD_KEY  = 'stardoku.save.v1';
let iapReady     = false;
let ownsAdFree   = false;
let productPrice = null;

/* Registering the product has to happen before Store2.refresh(). If the
   product id here does not match the one in App Store Connect, the buy
   button simply never appears; there is no error. */
function initPurchases() {
  try {
    Store2.verbosity = Store2.QUIET;
    Store2.register({ id: REMOVE_ADS, type: Store2.NON_CONSUMABLE });
    Store2.when(REMOVE_ADS).updated((p) => {
      if (p.title || p.price) productPrice = p.price || productPrice;
      if (p.owned) ownsAdFree = true;
      iapReady = !!(p.valid);
    });
    Store2.error(() => { /* offline, or StoreKit unavailable */ });
    Store2.refresh();
  } catch (e) { iapReady = false; }
}

/* ---------- 2. Consent, in the right order --------------------------
   UMP first (GDPR/UK GDPR), then ATT (Apple). Doing ATT first means the
   European consent form appears after the system prompt, which reads as
   two dialogues stacked on top of each other and tanks acceptance.
   Both are asked ONCE, on second launch rather than first: a prompt
   before someone has played anything is the fastest way to get a "no".  */
async function establishConsent() {
  try {
    await AdMob.requestConsentInfo({
      debugGeography: LIVE ? undefined : 'EEA',
      testDeviceIdentifiers: []
    });
    const info = await AdMob.requestConsentInfo();
    if (info.isConsentFormAvailable && info.status === 'REQUIRED') {
      await AdMob.showConsentForm();
    }
  } catch (e) { /* no form available, or already answered */ }

  try {
    const t = await AdMob.trackingAuthorizationStatus();
    if (t.status === 'notDetermined') {
      await AdMob.requestTrackingAuthorization();
    }
  } catch (e) { /* older iOS, or the user already answered */ }

  consentDone = true;
}

/* ---------- 3. Preloading -------------------------------------------
   Always keep one of each in hand. An ad requested at the moment it is
   needed takes seconds to arrive, and the player just sees the game
   stop responding.                                                     */
async function preloadInterstitial() {
  try {
    await AdMob.prepareInterstitial({ adId: ID.interstitial });
    interstitialReady = true;
  } catch (e) { interstitialReady = false; }
}

async function preloadRewarded() {
  try {
    await AdMob.prepareRewardVideoAd({ adId: ID.rewarded });
    rewardedReady = true;
  } catch (e) { rewardedReady = false; }
}

/* ---------- 4. Boot -------------------------------------------------- */
async function boot() {
  try {
    await AdMob.initialize({ initializeForTesting: !LIVE });
  } catch (e) {
    return;                            // SDK missing: leave the no-op bridge alone
  }

  // Wait until the player has actually played before asking anything.
  const played = Number(localStorage.getItem('sd.launches') || 0) + 1;
  localStorage.setItem('sd.launches', String(played));
  if (played >= 2) await establishConsent(); else consentDone = true;

  preloadInterstitial();
  preloadRewarded();
  initPurchases();

  window.SDBridge = {
    isNative: true,

    ads: {
      // The game asks this before counting anything, so a failed preload
      // simply means no ads this session rather than a broken placement.
      ready: () => !ownsAdFree && consentDone && (interstitialReady || rewardedReady),

      interstitial: async () => {
        if (!interstitialReady) { preloadInterstitial(); return false; }
        try {
          await AdMob.showInterstitial();
          return true;
        } catch (e) {
          return false;
        } finally {
          interstitialReady = false;
          preloadInterstitial();       // have the next one ready immediately
        }
      },

      rewarded: async () => {
        if (!rewardedReady) { preloadRewarded(); return false; }
        try {
          const r = await AdMob.showRewardVideoAd();
          // Only true if they watched it through. Closing early must not pay.
          return !!(r && typeof r.amount === 'number' && r.amount > 0);
        } catch (e) {
          return false;
        } finally {
          rewardedReady = false;
          preloadRewarded();
        }
      }
    },

    /* ---- Remove ads, $2.99, non-consumable ------------------------
       Apple requires a Restore control for non-consumables and rejects
       builds without one; the game shows it beside the buy button.     */
    iap: {
      available: () => iapReady,
      price: () => productPrice,
      buy: (id) => new Promise((resolve) => {
        try {
          const p = Store2.get(id);
          if (!p) return resolve(false);
          Store2.once(id).approved((o) => { o.verify(); });
          Store2.once(id).verified((o) => { o.finish(); ownsAdFree = true; resolve(true); });
          Store2.once(id).cancelled(() => resolve(false));
          Store2.once(id).error(() => resolve(false));
          Store2.order(id);
        } catch (e) { resolve(false); }
      }),
      restore: () => new Promise((resolve) => {
        try {
          ownsAdFree = false;
          Store2.refresh();
          // give StoreKit a moment to report owned products
          setTimeout(() => {
            const p = Store2.get(REMOVE_ADS);
            resolve(!!(p && p.owned));
          }, 2500);
        } catch (e) { resolve(false); }
      })
    },

    /* ---- iCloud key-value save -----------------------------------
       No login, no server, no account to delete. It syncs for anyone
       signed into iCloud and simply does nothing for anyone who is not. */
    cloud: {
      available: () => true,
      load: async () => {
        try {
          const { value } = await Preferences.get({ key: CLOUD_KEY });
          return value ? JSON.parse(value) : null;
        } catch (e) { return null; }
      },
      save: (data) => {
        try { Preferences.set({ key: CLOUD_KEY, value: JSON.stringify(data) }); }
        catch (e) {}
      }
    },

    // Filled in if you add Game Center; see SHIPPING_GUIDE part 3.
    leaderboard: { available: () => false, submit: () => {}, show: () => {} },

    haptic: (ms) => { try { navigator.vibrate && navigator.vibrate(ms || 6); } catch (e) {} }
  };
}

boot();
