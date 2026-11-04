# PREMIUM-27

> Section: 2026-11-03 - Storefront premium defaults (PREMIUM-\*)

Ruling PREMIUM-27 - CLS: header placeholder knows an uploaded logo; 404 top-aligned; search reserves its floor. measured on production (390px, PerformanceObserver): cart 0.117 (header placeholder 92px vs real 68px on a Qamar Atelier store with an uploaded logo, 0.07; cookie strip 0.05), 404 0.23 (centred column moved when categories arrived), empty search 0.47 and blog 0.42 (footer jumped from an empty box to 488px). Fixes: `LOOK_HEADER_WITH_LOGO_PX` (Atelier 68, measured; other looks with an uploaded logo keep the showroom value, NOT MEASURED), 404 top-aligned with a 100svh floor, search wrapper `min-h-[70svh]`, blog server-rendered (PREMIUM-23). Cost if wrong: another look with an uploaded logo still shifts by the difference between the showroom's lockup header and its real one.
