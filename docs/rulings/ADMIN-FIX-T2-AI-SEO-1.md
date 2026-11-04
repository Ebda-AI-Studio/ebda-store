# ADMIN-FIX-T2-AI-SEO-1

> Section: ADMIN-FIX-T2-AI-SEO-1 (2026-11-04, admin fix pass T2, BE:F-4 / QA P2-2)

Ruling ADMIN-FIX-T2-AI-SEO-1 - AI SEO suggestions are language-typed and checked. Evidence: the prompt never said which fields are English, so the model wrote Arabic into `title` / `description` (QA P2-2). The instruction now states `title` / `description` = English and `titleAr` / `descriptionAr` = Arabic; the answer is post-checked by Arabic-letter share (English fields at most 30% Arabic letters, Arabic fields at least 50%, a field with no letters is not judged) with one retry, then `422 AI_WRONG_LANGUAGE`; every attempt is metered. The instruction text is part of the cache key, so answers cached with the old prompt are not served. Evidence of behaviour: `tests/unit/ai-seo-language.test.ts`. Cost if wrong: a legitimate suggestion that mixes the languages heavily is refused after one retry and the merchant types the meta by hand.
