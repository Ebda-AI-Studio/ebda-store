# Orders Focus Mode — Feature Plan

**Date:** 2026-06-13
**Branch:** feat/orders-focus-mode
**Author:** Ahmad Sharaf

---

## Goal

Turn the admin PWA into a dedicated order-handling station by adding a per-device "Focus Mode" toggle. When on, the shell collapses to orders-only chrome (no sidebar, no bottom nav), the device is redirected to the orders list, and a one-tap push-notification prompt surfaces for OneSignal.

---

## Design decisions (locked by product owner)

- **Scope = View + Act on orders**: orders list, order detail, existing ActionFooter (update status, mark paid/fulfilled, print invoice). No other routes.
- **Access model = toggle, not a role**: any logged-in `store_admin` (or `super_admin` scoped to a store) flips their own device into focus. No schema change, no migration.
- **State location = `localStorage` key `fwb_focus_mode`**, initialised from a `?focus=1` URL param on first mount.
- **No server middleware**: auth is client-side everywhere in this app (per CLAUDE.md). The route guard runs in `AdminLayout` on `useEffect`.

---

## Files touched / created

### New

| File                                                     | Purpose                                                   |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `apps/admin/src/contexts/FocusModeContext.tsx`           | `FocusModeProvider`, `useFocusMode()` hook                |
| `apps/admin/src/components/admin-layout/FocusTopBar.tsx` | Minimal top bar for focus mode (store name + bell + exit) |

### Modified

| File                                                       | Change                                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `apps/admin/src/app/providers.tsx`                         | Mount `FocusModeProvider` inside `AuthenticatedProviders`                                              |
| `apps/admin/src/components/AdminLayout.tsx`                | Consume `useFocusMode()`, hide sidebars + bottom nav, swap `TopBar` for `FocusTopBar`, add route guard |
| `apps/admin/src/components/admin-layout/SidebarFooter.tsx` | Add "Enter focus mode" button (calls `enterFocusMode(storeId)`)                                        |
| `apps/admin/src/app/manifest.ts`                           | Add `shortcuts` array with focus start_url `/?focus=1`                                                 |
| `apps/admin/src/i18n/messages/en.json`                     | Add all focus-mode strings under `components.adminLayout.focusMode`                                    |
| `apps/admin/src/i18n/messages/ar.json`                     | Arabic equivalents                                                                                     |

---

## Behaviour specification

### FocusModeContext

```
interface FocusModeContextValue {
  isFocused: boolean;
  focusStoreId: string | null;   // the store locked in focus
  enterFocusMode(storeId: string): void;
  exitFocusMode(): void;
}
```

- On mount: check `?focus=1` URL param → if present AND `localStorage.fwb_focus_mode` is set, stay focused. If `?focus=1` but no stored storeId, wait for storeId resolution from AdminLayout.
- `enterFocusMode(storeId)`: writes `{ storeId }` to `localStorage` key `fwb_focus_mode`, updates state.
- `exitFocusMode()`: removes localStorage key, updates state.

### AdminLayout changes

1. Read `useFocusMode()`.
2. When `isFocused`:
   - Skip rendering mobile sidebar overlay, mobile sidebar aside, desktop sidebar aside.
   - Drop `lg:ms-72` on `<main>` (no sidebar offset).
   - Render `<FocusTopBar>` instead of full `<TopBar>`.
   - Skip `<HubTabs>`.
   - Skip `<MobileBottomNav>`.
3. Route guard (`useEffect`): when `isFocused && pathname && focusStoreId`, if the current path is NOT under `/stores/${focusStoreId}/orders`, redirect to `/stores/${focusStoreId}/orders`.
4. When NOT focused, layout is 100% unchanged.

### FocusTopBar

Minimal sticky header showing:

- Store name / branding (from `resolvedStoreBranding`)
- `<NotificationBell />` (reused as-is)
- "Exit focus mode" button with an X icon

### Enter focus mode trigger

In `SidebarFooter` add an "Enter Focus Mode" item (small compact button above the user profile block). It calls `enterFocusMode(storeId)` — the storeId is threaded down from AdminLayout via a new optional `onEnterFocusMode` prop.

### OneSignal nudge

In `FocusTopBar`, after the exit button, check `OneSignal.User?.PushSubscription?.optedIn`. If `false` or `undefined` (not subscribed), render a compact one-tap "Enable order notifications" pill. When tapped, call `OneSignal.User.PushSubscription.optIn()`. The SDK is already initialised by `<OneSignalInit />` in providers.

### PWA manifest

Add a `shortcuts` entry:

```json
{
  "name": "Orders Focus",
  "short_name": "Orders",
  "description": "Jump straight to focus mode",
  "url": "/?focus=1",
  "icons": [{ "src": "/icon-192x192.png", "sizes": "192x192", "type": "image/png" }]
}
```

Also set `share_target` is NOT added (no file sharing needed). The existing `start_url` `/` is unchanged so normal installs still land on the dashboard.

---

## i18n strings

All strings live under `components.adminLayout.focusMode`:

- `enterFocusMode` — "Focus mode"
- `exitFocusMode` — "Exit focus mode"
- `ordersOnly` — "Orders only"
- `enableNotifications` — "Enable order notifications"
- `notificationsEnabled` — "Notifications on"
- `focusModeHint` — "Collapses the app to orders only on this device"
- `manifestShortcutName` — "Orders Focus"
- `manifestShortcutDesc` — "Jump straight to focus mode"

---

## Test plan

1. **Enter focus mode**:
   - Log in as store_admin → any admin page → open sidebar → click "Focus mode" button in footer
   - Sidebar collapses, bottom nav disappears, minimal top bar appears
   - Browser URL redirects to `/stores/<id>/orders`

2. **Orders-only constraint**:
   - While focused, manually navigate to `/stores/<id>/products`
   - Should redirect back to `/stores/<id>/orders`

3. **Act on an order**:
   - In focus mode, tap an order row → detail page loads with ActionFooter intact
   - Update status → save → back to list

4. **Exit focus mode**:
   - Tap "Exit focus mode" in the top bar
   - Full admin layout restores
   - No redirect (stay on current page)

5. **PWA shortcut**:
   - Open browser devtools → Application → Manifest → confirm "Orders Focus" shortcut listed
   - Launch from shortcut → lands on focus-mode orders view

6. **OneSignal nudge**:
   - In focus mode on a device that hasn't granted push permission
   - "Enable order notifications" pill appears in FocusTopBar
   - Tap → browser permission prompt fires

7. **Persistence**:
   - Enter focus mode → close tab → reopen admin URL
   - Focus mode is still on (localStorage persists)

8. **Multi-store (super_admin)**:
   - As super_admin viewing `/stores/<id>/orders`
   - Enter focus mode → locked to that store's orders

9. **RTL (Arabic)**:
   - Switch locale to AR → all focus-mode strings render in Arabic
   - Exit button position mirrors correctly in RTL

---

## Non-goals

- No new API endpoints, no DB schema changes.
- No role restriction — any store_admin can toggle.
- The focus state is per-device (localStorage), not per-user-account.
