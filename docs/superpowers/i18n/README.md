# Arabic Translation Handoff — Force Admin Dashboard

Welcome, and thank you for translating the Force admin dashboard into Arabic.

## What this package contains

| File                                | Purpose                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `admin-strings-for-translator.json` | All user-facing strings from the admin dashboard (the file you will edit).                                                           |
| `glossary.md`                       | Commerce terminology reference — preferred Arabic equivalents for e-commerce terms. Use this as the source of truth for consistency. |
| `README.md`                         | This file.                                                                                                                           |

## What is being translated

Force is a **Egypt-based multi-tenant e-commerce SaaS**. The admin dashboard is the back-office tool that merchants (store owners) and platform operators (super admins) use to manage stores, products, orders, payments, shipping, loyalty, marketing, analytics, and more.

The strings you see cover every screen of that dashboard: navigation labels, buttons, form fields, table headers, empty-state messages, toast notifications, error messages, validation messages, and email/UI copy.

## How to translate

1. Open `admin-strings-for-translator.json` in any editor that supports JSON (VS Code recommended).
2. **Overwrite the English values with their Arabic translations.**
3. **Do NOT change the keys.** Keys are the property names on the left of every `:`. They are identifiers used by the code.
4. **Do NOT change the JSON structure** — do not remove braces, reorder nested objects, add new keys, or delete keys.
5. Save the file and return it when complete.

### Example

Before:

```json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel"
  }
}
```

After:

```json
{
  "common": {
    "save": "حفظ",
    "cancel": "إلغاء"
  }
}
```

Notice the keys (`common`, `save`, `cancel`) are unchanged. Only the string values to the right of the `:` are translated.

## Rules and conventions

### Placeholders — keep them intact

Some strings contain placeholders inside curly braces like `{name}`, `{count}`, `{store}`, or `{id}`. These are filled in at runtime with real values. **Keep them exactly as-is, including the braces**, and place them wherever they naturally fit in the Arabic sentence.

Example:

- English: `"Welcome back, {name}"`
- Arabic: `"مرحبًا بعودتك، {name}"`

### Plural forms (ICU)

A few strings use ICU MessageFormat for pluralization, for example:

```json
"items": "{count, plural, one {# item} other {# items}}"
```

If you encounter these, translate the words inside `{ ... }` but leave the syntax (`count, plural, one`, `other`, `#`) exactly as-is. If unsure, leave it and flag the key — we will review together.

### Digits and numbers

Use **Latin digits (0-9) for all money amounts, SKUs, IDs, order numbers, phone numbers, and dates in data tables.** This is the global e-commerce standard and matches customer receipts, payment gateway outputs, and shipping labels.

Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) are acceptable only for free-flowing prose counts that are never joined to data (for example, a welcome sentence like "you have three unread notifications" — though for consistency, Latin digits are also fine there).

### Brand name

The product name **Force** stays in English (Latin script) everywhere. Do not transliterate it to ابدأ.

### Technical terms that stay in English

Certain technical terms stay in Latin script because they are universally recognized and have no stable Arabic equivalent in developer/commerce contexts:

- `SKU`
- `webhook`
- `API`
- `URL`
- `PWA` (optional — see glossary)
- `CSV`, `JSON`

See `glossary.md` for the full list and reasoning.

### Tone

Use **Modern Standard Arabic (MSA)** with a professional, clear, direct tone. Imagine you are writing UI copy for a modern SaaS product used by small-to-medium business owners. Avoid colloquial Egyptian/Gulf dialect, but also avoid overly formal classical phrasing. Aim for clarity over literal translation — if a literal translation sounds awkward, rephrase for naturalness.

### Consistency

Always consult `glossary.md` before translating commerce terms. The same English term should map to the same Arabic term every time (for example, "Coupon" should always be كوبون, not sometimes كوبون and sometimes قسيمة).

If you encounter a commerce term that is **not** in the glossary, add it to the glossary with your proposed translation so reviewers can confirm before we standardize.

## Where the translation ends up

The live Arabic file in the codebase is:

```
apps/admin/src/i18n/messages/ar.json
```

Once your translation is reviewed, its contents will be copy-pasted into that file verbatim. Keep the JSON structure identical so the paste is a straight overwrite.

## Questions

If anything is ambiguous — an unclear context, a short label you cannot interpret, a tone question — flag the key in a comment or separate list. It is better to ask than to guess.

Thank you.
