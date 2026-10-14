"""Catalogue shared by the gallery (build.py) and the site export (export.py)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qamar import qa, qb, qc
from souq import sa, sb, sc
from jasmine import ja, jb, jc
from lamma import la, lb, lc
from dahab import da, db, dc

T = [
 ('qamar', 'Qamar', 'قمر', 'Fashion & boutiques', [
   (qa, 'A', 'Atelier', 'For a boutique whose clothes should speak alone: calm, white, editorial.', 'Oversized product photography with almost no chrome: the clothes are the interface.'),
   (qb, 'B', 'Lookbook', 'For stylists and fast-fashion shops that sell outfits, not single pieces.', 'Shop the whole outfit: each look carries its items and prices, one tap adds the lot.'),
   (qc, 'C', 'Vitrine', 'For occasion wear (weddings, engagements, evenings) where the event decides the purchase.', 'Occasion-first navigation: فرح · خطوبة · سهرة, each on its own palette band.')]),
 ('souq', 'Souq', 'سوق', 'General retail & electronics', [
   (sa, 'A', 'Catalogue', 'For a shop with many SKUs where shoppers arrive knowing what they want.', 'Find it in two taps: search and categories come before any hero.'),
   (sb, 'B', 'Night souq', 'For a retailer who wants warmth and personality, not a spec sheet.', 'A market that feels lit and alive without clutter; orange is reserved for deals only.'),
   (sc, 'C', 'Showroom', 'For a small, premium range (phones, laptops) sold one object at a time.', 'Product as hero, one object per screen, with a compare toggle.')]),
 ('jasmine', 'Jasmine', 'ياسمين', 'Beauty & skincare', [
   (ja, 'A', 'Apothecary', 'For natural and heritage skincare where trust comes from what is inside.', 'Ingredients first: what is in it, then the product.'),
   (jb, 'B', 'Bloom', 'For colour cosmetics and a young audience that shops by shade.', 'The colour of the product is the colour of the page; shade swatches everywhere.'),
   (jc, 'C', 'Clinic', 'For dermatologist-style actives where the shopper has a concern to solve.', 'The routine is the navigation: cleanse, treat, protect.')]),
 ('lamma', 'Lamma', 'لمّة', 'Home food & home kitchens', [
   (la, 'A', 'Family table', 'For a home kitchen that takes same-day orders like a restaurant menu.', 'Order like a menu, not like a shop: tabs, portions, big add buttons.'),
   (lb, 'B', 'Kitchen notebook', 'For a single named cook whose face and story are the brand.', 'The cook is the brand: pre-order by day, dishes told as stories.'),
   (lc, 'C', 'Fresh market', 'For grocery and produce delivery where repeat baskets matter.', 'Everything in two taps, with colour-coded aisles and a live cart total.')]),
 ('dahab', 'Dahab', 'دهب', 'Jewellery, handmade & gifts', [
   (da, 'A', 'Worn', 'For a gold jeweller whose customers worry about size and karat before they fall in love.', 'Worn, not displayed: every photo is on skin and scale and karat are always visible.'),
   (db, 'B', 'Workshop', 'For a handmade silver studio whose craft is the reason to pay more.', 'The making is the product: a real draw, cast, polish sequence and a lead time on every piece.'),
   (dc, 'C', 'Gift box', 'For gift buyers who start from who it is for and how much they can spend.', 'Shop by recipient and budget, with the wrapping and card visible before checkout.')]),
]

FONTS = ['Noto+Naskh+Arabic:wght@400;700', 'IBM+Plex+Sans+Arabic:wght@400;500;600;700', 'Cormorant+Garamond:wght@600', 'Lalezar', 'Tajawal:wght@400;500;700', 'Archivo:wght@500;700',
         'Aref+Ruqaa:wght@400;700', 'Noto+Sans+Arabic:wght@400;500;600;700', 'Playfair+Display:wght@600', 'IBM+Plex+Sans:wght@500;600', 'Changa:wght@600;700', 'Cairo:wght@400;600;700',
         'Manrope:wght@600;700', 'Alexandria:wght@500;700', 'Readex+Pro:wght@400;500;600', 'Inter+Tight:wght@500;600', 'Amiri:wght@400;700', 'Fraunces:wght@600',
         'Rubik:wght@500;700', 'DM+Sans:wght@500;700', 'Figtree:wght@500;600', 'El+Messiri:wght@600;700', 'Lora:wght@500;600', 'Baloo+Bhaijaan+2:wght@600;700',
         'Almarai:wght@400;700;800', 'Nunito:wght@600;700;800', 'Reem+Kufi:wght@600', 'Bodoni+Moda:wght@500', 'Markazi+Text:wght@600', 'Libre+Caslon+Text', 'Kufam:wght@600', 'Italiana']
