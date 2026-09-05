window.SDBridge = {
  isNative: true,

  ads: {
    ready: () => boolean,                    // false if not loaded or user bought removal
    interstitial: () => Promise<boolean>,    // true only if an ad was actually shown
    rewarded: () => Promise<boolean>         // true ONLY if watched to completion
  },

  iap: {
    available: () => boolean,
    price: (productId) => string | null,     // localised, e.g. "$2.99", from StoreKit
    buy: (productId) => Promise<boolean>,
    restore: () => Promise<boolean>
  },

  cloud: {
    available: () => boolean,
    load: () => Promise<object | null>,
    save: (object) => void
  },

  leaderboard: { available: () => false, submit: () => {}, show: () => {} },

  haptic: (kind) => void
};
