# FP-6

> Section: Admin fix pass 2026-11-04, track T1 API core (branch `feat/admin-fix-t1-api-core`)

Ruling FP-6 - BE:S-20. A verified existing staff account is added at once (201), any other address gets an invitation (202); that difference is observable by the store owner. Removing it would change the status code four tests and the staff page rely on (`staff-invite-flow`, `staff-removal-scope`, `staff-invite` integration, the toast branch). The 201 body used to return the pre-existing account's stored first and last name; it now echoes the names the OWNER typed. The route sits behind owner + MFA + `staff_accounts` + not-impersonated (FP-3), so only an authenticated owner of a paying store can probe. Cost if wrong: an owner can learn that an address already is a verified staff account elsewhere, one probe at a time.
