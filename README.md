# 🛒 Shop Wise

> Smarter aisles. Faster trips.

A mobile-first PWA shopping list that sorts items by aisle as you add them, then guides you through the store in **Shopping Mode** — with a Finder that shows you where each item lives on a sample store map.

## Features

- **Aisle-sorted list** — items group by aisle in store-walk order
- **Shopping Mode** — tap "Start Shopping" for a streamlined check-off view
- **Launch Finder** — opens a store map with a "You are here" pin and a walking route to the item (random spawn for the MVP; future: GPS-based)
- **Autocomplete** — inline ghost-text completion, dropdown of all 31 sample items, click or Enter to add
- **Undo** — reverses the most recent add or tick
- **Persistence** — localStorage; ticked items auto-clear on reopen
- **Share** — Web Share API on mobile, clipboard fallback on desktop
- **Print** — clean aisle-grouped checklist
- **Dark mode** — full palette swap, persisted
- **Installable PWA** — service worker for offline use, "Add to Home Screen" on iOS/Android

## Running it

### Best (full PWA, installable):
Host on any static service — GitHub Pages, Netlify, Cloudflare Pages.

### Locally with a server:
```bash
cd shop-wise
python3 -m http.server 8000
# then open http://localhost:8000
```
or
```bash
npx serve
```

### Quick-and-dirty (no install):
Double-click `index.html`. The app runs but the service worker won't register (browsers block it on `file://`), so no offline mode and no installable home-screen icon.

## Sample data

The MVP ships with one fictional store layout:
- **Top row:** Bakery · Deli · Butchery
- **Middle:** 9 vertical aisles — Produce (left) + Aisles 1–8
- **Bottom row:** Dairy · Frozen · Checkout
- **Entrance** at the bottom

31 sample items across all zones (SA grocery flavour: NikNaks, Koo, Tastic, Rooibos, etc.).

## File structure

```
shop-wise/
├── index.html         # Single-file app (HTML + CSS + JS)
├── manifest.json      # PWA manifest
├── sw.js              # Service worker (offline cache)
└── icons/
    ├── icon-192.svg
    └── icon-512.svg
```

## Roadmap

- Aisle-internal ordering (front-to-back position within each aisle)
- GPS / indoor positioning to drive the "You are here" pin for real
- Multi-store support with editable aisle maps
- Free-text item entry with AI/learned aisle inference
- Cross-device sync (would need a backend)
- Print: include the aisle map alongside the list
- Share: attach an image of the store map / route

## Status

Working title: **Shop Wise**. MVP — single store, single user, single device.
