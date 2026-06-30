// Google Analytics (GA4), lazy-loaded only when VITE_GA_MEASUREMENT_ID is set —
// same privacy-conscious pattern as firebase.js: zero cost/zero tracking for
// anyone who hasn't configured it.

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID;
let loaded = false;

function ensureGa() {
  if (!GA_ID || loaded) return;
  loaded = true;
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', GA_ID, { send_page_view: false }); // we send page_view manually per view change
}

export const analyticsAvailable = () => Boolean(GA_ID);

export function trackPageView(path, title) {
  if (!GA_ID) return;
  ensureGa();
  window.gtag('event', 'page_view', { page_path: path, page_title: title });
}

export function trackEvent(name, params = {}) {
  if (!GA_ID) return;
  ensureGa();
  window.gtag('event', name, params);
}
